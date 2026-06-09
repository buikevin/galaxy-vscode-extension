/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Async tool dispatch for VS Code file tools.
 */

import fs from "node:fs";
import path from "node:path";
import { readDocumentTool } from "./document";
import {
  buildDrawioActionGuidance,
  createDrawioDiagramTool as executeCreateDrawioDiagramTool,
  getDrawioNativeCommand,
  normalizeDrawioTargetFormat,
  normalizeEditableDrawioPath,
} from "./drawio";
import { createWorkflowDrawioDiagramTool } from "./workflow-drawio";
import { createWorkflowMermaidDiagramTool } from "./workflow-mermaid";
import {
  editFileRangeTool as executeEditFileRangeTool,
  editFileTool as executeEditFileTool,
  insertFileAtLineTool as executeInsertFileAtLineTool,
  multiEditFileRangesTool as executeMultiEditFileRangesTool,
  writeFileTool as executeWriteFileTool,
} from "./edit";
import {
  grepTool,
  headTool,
  listDirTool,
  readFileTool,
  resolveWorkspacePath,
  tailTool,
  toDisplayPath,
} from "./path-read";
import { crawlWebTool, extractWebTool, mapWebTool, searchWebTool } from "./web";
import { runInTerminalTool } from "./terminal";
import { inspectWorkspaceEnvironmentTool } from "./environment";
import {
  querySharedMemoryTool,
  queryWorkflowGraphTool,
  writeAgentHandoffTool,
} from "./memory";
import type {
  EditFileRangeRequest,
  FileToolContext,
  InsertFileAtLineRequest,
  MultiEditFileRange,
  ToolCall,
  ToolResult,
} from "../entities/file-tools";
import {
  galaxyDesignAddTool,
  galaxyDesignInitTool,
  galaxyDesignProjectInfoTool,
  galaxyDesignRegistryTool,
} from "../galaxy-design";
import {
  awaitManagedProjectCommandTool,
  gitAddTool,
  gitCheckoutTool,
  gitCommitTool,
  gitDiffTool,
  gitPullTool,
  gitPushTool,
  gitStatusTool,
  getManagedProjectCommandOutputTool,
  killManagedProjectCommandTool,
  runProjectCommandTool,
} from "../project-command";
import { inferProjectCommandCategory } from "../project-command/core";
import { validateCodeTool } from "./diff-validate";
import { findDiscoveredExtensionTool } from "./definitions";
import { getChangeSummaryTool, runValidationSuiteTool } from "./quality";
import { normalizeToolName } from "./tooling";
import {
  claimFileScope,
  recordSubagentFileEdit,
} from "../../context/file-scope-locks";

const VALIDATION_COMMAND_CATEGORIES: ReadonlySet<string> = new Set([
  "build",
  "test",
  "lint",
  "typecheck",
  "format-check",
]);

function blockCodingAgentValidationCommand(
  config: FileToolContext["config"],
  commandText: string,
): ToolResult | null {
  if (config.activeSubagentRole !== "coding") {
    return null;
  }
  const category = inferProjectCommandCategory(commandText);
  if (!VALIDATION_COMMAND_CATEGORIES.has(category)) {
    return null;
  }
  return Object.freeze({
    success: false,
    content: [
      "Project validation commands are handled by Testing Agent in subagent mode.",
      "Add the recommended command, observed failure, or validation risk to write_agent_handoff so Testing Agent can choose the correct framework/language-specific test strategy.",
    ].join("\n"),
    error: "Validation command belongs to Testing Agent.",
    meta: Object.freeze({
      blockedBy: "subagent_role_boundary",
      role: "coding",
      category,
    }),
  });
}

function coerceMultiEditRanges(params: Readonly<Record<string, unknown>>): readonly MultiEditFileRange[] {
  if (Array.isArray(params.edits)) {
    return params.edits as readonly MultiEditFileRange[];
  }
  if (Array.isArray(params.ranges)) {
    return params.ranges as readonly MultiEditFileRange[];
  }
  const startLine = Number(params.start_line ?? params.startLine);
  const endLine = Number(params.end_line ?? params.endLine);
  const newContent = params.new_content ?? params.newContent ?? params.content;
  if (
    Number.isFinite(startLine) &&
    Number.isFinite(endLine) &&
    typeof newContent === "string"
  ) {
    return Object.freeze([
      Object.freeze({
        start_line: startLine,
        end_line: endLine,
        new_content: newContent,
        ...(typeof (params.expected_range_content ?? params.expectedRangeContent) === "string"
          ? { expected_range_content: String(params.expected_range_content ?? params.expectedRangeContent) }
          : {}),
        ...(typeof (params.anchor_before ?? params.anchorBefore) === "string"
          ? { anchor_before: String(params.anchor_before ?? params.anchorBefore) }
          : {}),
        ...(typeof (params.anchor_after ?? params.anchorAfter) === "string"
          ? { anchor_after: String(params.anchor_after ?? params.anchorAfter) }
          : {}),
      }) as MultiEditFileRange,
    ]);
  }
  return Object.freeze([]);
}

/**
 * Reads one string parameter from a tool call.
 *
 * @param call Tool call emitted by the model.
 * @param key Parameter key to read.
 * @param fallback Default string value.
 * @returns Trimmed parameter string.
 */
function p(call: ToolCall, key: string, fallback = ""): string {
  if (key === "path") {
    return String(
      call.params.path ??
      call.params.file_path ??
      call.params.filePath ??
      call.params.filepath ??
      fallback,
    ).trim();
  }
  return String(call.params[key] ?? fallback).trim();
}

function n(call: ToolCall, key: string, fallback = 0): number {
  if (key === "line") {
    return Number(call.params.line ?? call.params.line_number ?? call.params.lineNumber ?? fallback);
  }
  if (key === "start_line") {
    return Number(call.params.start_line ?? call.params.startLine ?? call.params.start ?? fallback);
  }
  if (key === "end_line") {
    return Number(call.params.end_line ?? call.params.endLine ?? call.params.end ?? fallback);
  }
  return Number(call.params[key] ?? fallback);
}

function annotateFileScopeConflicts(
  toolContext: FileToolContext,
  toolName: string,
  result: ToolResult,
): ToolResult {
  if (
    !result.success ||
    !toolContext.config.activeSubagentRole ||
    typeof result.meta?.filePath !== "string"
  ) {
    return result;
  }
  const conflicts = recordSubagentFileEdit({
    workspacePath: toolContext.workspaceRoot,
    filePath: result.meta.filePath,
    role: toolContext.config.activeSubagentRole,
    toolName,
  });
  if (conflicts.length === 0) {
    return result;
  }
  const conflictText = conflicts
    .map(
      (conflict) =>
        `- ${conflict.filePath}: ${conflict.existingRole} already touched this scope (${conflict.reason})`,
    )
    .join("\n");
  return Object.freeze({
    ...result,
    content: `${result.content}\n\n[FILE SCOPE CONFLICT]\n${conflictText}`,
    meta: Object.freeze({
      ...(result.meta ?? {}),
      fileScopeConflicts: conflicts,
    }),
  });
}

/**
 * Finds likely test or source siblings for one workspace file.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided workspace file path.
 * @returns Tool result listing related candidates.
 */
function findTestFilesTool(workspaceRoot: string, rawPath: string): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    const rel = toDisplayPath(resolved, workspaceRoot);
    const ext = path.extname(resolved);
    const base = path.basename(resolved, ext);
    const dir = path.dirname(resolved);
    const isTestFile =
      /\.(test|spec)$/.test(base) || dir.includes(`${path.sep}__tests__`);
    const sourceBase = base.replace(/\.(test|spec)$/, "");
    const candidates = new Set<string>();

    const walk = (currentDir: string): void => {
      if (!fs.existsSync(currentDir)) {
        return;
      }
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const absolute = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === "dist" ||
            entry.name === "build"
          ) {
            continue;
          }
          walk(absolute);
          continue;
        }
        const entryExt = path.extname(entry.name);
        const entryBase = path.basename(entry.name, entryExt);
        if (isTestFile) {
          if (entryBase === sourceBase && entryExt !== ".snap") {
            candidates.add(absolute);
          }
        } else if (
          entryBase === `${base}.test` ||
          entryBase === `${base}.spec` ||
          entryBase === `${sourceBase}.test` ||
          entryBase === `${sourceBase}.spec`
        ) {
          candidates.add(absolute);
        }
      }
    };

    const searchRoots = new Set<string>([
      dir,
      path.join(workspaceRoot, "__tests__"),
      workspaceRoot,
    ]);
    for (const root of searchRoots) {
      walk(root);
    }

    const results = [...candidates]
      .filter((candidate) => candidate !== resolved)
      .slice(0, 20)
      .map((candidate) => toDisplayPath(candidate, workspaceRoot));

    return Object.freeze({
      success: true,
      content:
        results.length > 0
          ? [
              `Related test/source files for ${rel}:`,
              ...results.map((item) => `- ${item}`),
            ].join("\n")
          : `No related test/source files found for ${rel}.`,
      meta: Object.freeze({
        filePath: resolved,
        relatedFiles: Object.freeze(results),
        resultCount: results.length,
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}

async function executeDrawioNativeActionTool(
  action: "convert" | "export",
  call: ToolCall,
  toolContext: FileToolContext,
): Promise<ToolResult> {
  const toolLabel =
    action === "convert" ? "convert_drawio_diagram" : "export_drawio_diagram";

  try {
    const sourcePath = normalizeEditableDrawioPath(p(call, "path"));
    const resolvedPath = resolveWorkspacePath(
      toolContext.workspaceRoot,
      sourcePath,
    );
    const requestedFormat = normalizeDrawioTargetFormat(
      String(call.params.format ?? ""),
      action,
    );

    if (!fs.existsSync(resolvedPath)) {
      return Object.freeze({
        success: false,
        content: "",
        error: `${toolLabel} could not find ${sourcePath} in the workspace.`,
      });
    }

    if (
      !toolContext.openDrawioDiagram ||
      !toolContext.executeExtensionCommand
    ) {
      return Object.freeze({
        success: false,
        content: "",
        error: `${toolLabel} is not available in this runtime context.`,
      });
    }

    const openResult = await toolContext.openDrawioDiagram(resolvedPath);
    if (!openResult.success) {
      return openResult;
    }

    const providerId = String(openResult.meta?.providerId ?? "").trim();
    const fallbackToText = openResult.meta?.fallbackToText === true;
    if (fallbackToText) {
      return Object.freeze({
        success: false,
        content: "",
        error:
          "Draw.io convert/export requires the Draw.io custom editor to open successfully. The file is currently open as XML text.",
      });
    }

    const nativeCommand = getDrawioNativeCommand(providerId, action);
    if (!nativeCommand) {
      return Object.freeze({
        success: false,
        content: "",
        error: providerId
          ? `The active Draw.io editor (${providerId}) does not expose a public ${action} command that Galaxy can trigger. Install hediet.vscode-drawio to automate this action.`
          : `No supported Draw.io editor is installed for ${toolLabel}. Install hediet.vscode-drawio to enable native convert/export support.`,
      });
    }

    const commandResult = await toolContext.executeExtensionCommand(
      nativeCommand.commandId,
      nativeCommand.title,
      nativeCommand.extensionId,
    );
    if (!commandResult.success) {
      return commandResult;
    }

    return Object.freeze({
      success: true,
      content: [
        openResult.content,
        commandResult.content,
        buildDrawioActionGuidance(action, requestedFormat),
      ]
        .filter(Boolean)
        .join("\n"),
      meta: Object.freeze({
        filePath: resolvedPath,
        operation: toolLabel,
        providerId,
        commandId: nativeCommand.commandId,
        extensionId: nativeCommand.extensionId,
        requestedFormat,
        requiresUserSelection: true,
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}

/**
 * Executes one asynchronous tool call inside the VS Code runtime context.
 *
 * @param call Tool call emitted by the model.
 * @param toolContext Runtime capabilities and workspace hooks.
 * @returns Tool result for the requested operation.
 */
export async function executeToolAsync(
  call: ToolCall,
  toolContext: FileToolContext,
): Promise<ToolResult> {
  const extensionTool = findDiscoveredExtensionTool(
    toolContext.config,
    call.name,
  );
  if (extensionTool) {
    if (
      toolContext.config.extensionToolToggles[extensionTool.tool.key] !== true
    ) {
      return Object.freeze({
        success: false,
        content: "",
        error: `Extension tool is disabled: ${extensionTool.tool.runtimeName}`,
      });
    }
    if (extensionTool.tool.invocation === "lm_tool") {
      if (!toolContext.invokeLanguageModelTool) {
        return Object.freeze({
          success: false,
          content: "",
          error: `Language model tool invocation is not available for ${extensionTool.tool.runtimeName}.`,
        });
      }
      return toolContext.invokeLanguageModelTool(
        extensionTool.tool.runtimeName,
        extensionTool.tool.title,
        extensionTool.group.extensionId,
        call.params,
      );
    }
    if (!toolContext.executeExtensionCommand || !extensionTool.tool.commandId) {
      return Object.freeze({
        success: false,
        content: "",
        error: `Extension command execution is not available for ${extensionTool.tool.runtimeName}.`,
      });
    }
    return toolContext.executeExtensionCommand(
      extensionTool.tool.commandId,
      extensionTool.tool.title,
      extensionTool.group.extensionId,
    );
  }

  const toolName = normalizeToolName(call.name);

  switch (toolName) {
    case "read_file":
      return readFileTool(toolContext.workspaceRoot, p(call, "path"), {
        maxLines: Number(call.params.maxLines ?? 200),
        offset: Number(call.params.offset ?? 0),
      });
    case "vscode_start_frontend_preview":
      return toolContext.startFrontendPreview
        ? toolContext.startFrontendPreview({
            ...(p(call, "query")
              ? { query: p(call, "query") }
              : p(call, "project")
                ? { query: p(call, "project") }
                : p(call, "path")
                  ? { query: p(call, "path") }
                  : {}),
          })
        : Object.freeze({
            success: false,
            content: "",
            error: "Frontend preview startup is not available in this context.",
          });
    case "find_test_files":
      return findTestFilesTool(toolContext.workspaceRoot, p(call, "path"));
    case "get_latest_test_failure":
      return toolContext.getLatestTestFailure
        ? toolContext.getLatestTestFailure()
        : Object.freeze({
            success: false,
            content: "",
            error: "Latest test failure is not available in this context.",
          });
    case "get_latest_review_findings":
      return toolContext.getLatestReviewFindings
        ? toolContext.getLatestReviewFindings()
        : Object.freeze({
            success: false,
            content: "",
            error: "Latest review findings are not available in this context.",
          });
    case "get_next_review_finding":
      return toolContext.getNextReviewFinding
        ? toolContext.getNextReviewFinding()
        : Object.freeze({
            success: false,
            content: "",
            error: "Next review finding is not available in this context.",
          });
    case "dismiss_review_finding":
      return toolContext.dismissReviewFinding
        ? toolContext.dismissReviewFinding(p(call, "finding_id"))
        : Object.freeze({
            success: false,
            content: "",
            error:
              "Dismissing review findings is not available in this context.",
          });
    case "query_shared_memory":
      return querySharedMemoryTool(toolContext.workspaceRoot, {
        query: p(call, "query"),
        role: p(call, "role") || undefined,
        fallbackRole: toolContext.config.activeSubagentRole,
        limit: Number(call.params.limit ?? 4),
        turnKinds: Array.isArray(call.params.turn_kinds)
          ? call.params.turn_kinds as readonly unknown[]
          : Array.isArray(call.params.turnKinds)
            ? call.params.turnKinds as readonly unknown[]
            : undefined,
      });
    case "write_agent_handoff":
      return writeAgentHandoffTool(toolContext.workspaceRoot, {
        role: p(call, "role") || undefined,
        fallbackRole: toolContext.config.activeSubagentRole,
        summary: p(call, "summary"),
        status: p(call, "status") || undefined,
        nextRole: p(call, "next_role") || p(call, "nextRole") || undefined,
        files: Array.isArray(call.params.files) ? call.params.files as readonly unknown[] : undefined,
        planId: p(call, "plan_id") || p(call, "planId") || undefined,
      });
    case "query_workflow_graph":
      return queryWorkflowGraphTool(toolContext.workspaceRoot, {
        query: p(call, "query"),
      });
    case "inspect_workspace_environment":
      return inspectWorkspaceEnvironmentTool({
        workspacePath: toolContext.workspaceRoot,
        cwd: p(call, "cwd") || undefined,
        paths: Array.isArray(call.params.paths)
          ? call.params.paths as readonly unknown[]
          : undefined,
        envVars: Array.isArray(call.params.env_vars)
          ? call.params.env_vars as readonly unknown[]
          : Array.isArray(call.params.envVars)
            ? call.params.envVars as readonly unknown[]
            : undefined,
        commandChecks: Array.isArray(call.params.command_checks)
          ? call.params.command_checks as readonly { command?: unknown; binary?: unknown; args?: unknown }[]
          : Array.isArray(call.params.commandChecks)
            ? call.params.commandChecks as readonly { command?: unknown; binary?: unknown; args?: unknown }[]
            : undefined,
        maxChars: Number(call.params.maxChars ?? call.params.max_chars ?? 8_000),
      });
    case "claim_file_scope": {
      const files = Array.isArray(call.params.files)
        ? call.params.files.map((item) => String(item ?? "").trim()).filter(Boolean)
        : [];
      const result = claimFileScope({
        workspacePath: toolContext.workspaceRoot,
        files,
        role: p(call, "role") || toolContext.config.activeSubagentRole || "main",
        reason: p(call, "reason") || "claimed by claim_file_scope",
        force: Boolean(call.params.force ?? false),
      });
      return Object.freeze({
        success: result.success,
        content: result.content,
        ...(result.success ? {} : { error: "File scope conflict detected." }),
        meta: Object.freeze({
          claimedFiles: result.claimedFiles,
          conflicts: result.conflicts,
        }),
      });
    }
    case "write_file": {
      let result = executeWriteFileTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        String(call.params.content ?? ""),
        Boolean(call.params.overwrite_existing ?? call.params.overwriteExisting ?? call.params.overwrite ?? call.params.replace ?? false),
      );
      result = annotateFileScopeConflicts(toolContext, toolName, result);
      if (result.success && typeof result.meta?.filePath === "string") {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case "create_drawio_diagram": {
      let result = executeCreateDrawioDiagramTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        {
          ...(typeof call.params.format === "string"
            ? { format: String(call.params.format) }
            : {}),
          ...(typeof call.params.title === "string"
            ? { title: String(call.params.title) }
            : {}),
        },
      );
      result = annotateFileScopeConflicts(toolContext, toolName, result);
      if (result.success && typeof result.meta?.filePath === "string") {
        await toolContext.refreshWorkspaceFiles();
        if (call.params.open !== false && toolContext.openDrawioDiagram) {
          const openResult = await toolContext.openDrawioDiagram(
            result.meta.filePath as string,
          );
          return annotateFileScopeConflicts(toolContext, toolName, Object.freeze({
            success: true,
            content: `${result.content}\n${openResult.content}`,
            meta: Object.freeze({
              ...result.meta,
              opened: true,
              fallbackToText: openResult.meta?.fallbackToText === true,
            }),
          }));
        }
      }
      return result;
    }
    case "export_workflow_drawio_diagram": {
      let result = await createWorkflowDrawioDiagramTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        {
          ...(typeof call.params.format === "string"
            ? { format: String(call.params.format) }
            : {}),
          ...(typeof call.params.title === "string"
            ? { title: String(call.params.title) }
            : {}),
          ...(typeof call.params.entry_node_id === "string"
            ? { entryNodeId: String(call.params.entry_node_id) }
            : {}),
          ...(typeof call.params.route_path === "string"
            ? { routePath: String(call.params.route_path) }
            : {}),
          ...(typeof call.params.file_path === "string"
            ? { filePath: String(call.params.file_path) }
            : {}),
          ...(typeof call.params.query === "string"
            ? { query: String(call.params.query) }
            : {}),
          ...(typeof call.params.max_hops === "number"
            ? { maxHops: Number(call.params.max_hops) }
            : {}),
          ...(typeof call.params.max_nodes === "number"
            ? { maxNodes: Number(call.params.max_nodes) }
            : {}),
          ...(typeof call.params.include_incoming === "boolean"
            ? { includeIncoming: Boolean(call.params.include_incoming) }
            : {}),
          ...(typeof call.params.include_external === "boolean"
            ? { includeExternal: Boolean(call.params.include_external) }
            : {}),
        },
      );
      result = annotateFileScopeConflicts(toolContext, toolName, result);
      if (result.success && typeof result.meta?.filePath === "string") {
        await toolContext.refreshWorkspaceFiles();
        if (call.params.open !== false && toolContext.openDrawioDiagram) {
          const openResult = await toolContext.openDrawioDiagram(
            result.meta.filePath as string,
          );
          return annotateFileScopeConflicts(toolContext, toolName, Object.freeze({
            success: true,
            content: `${result.content}\n${openResult.content}`,
            meta: Object.freeze({
              ...result.meta,
              opened: true,
              fallbackToText: openResult.meta?.fallbackToText === true,
            }),
          }));
        }
      }
      return result;
    }
    case "export_workflow_mermaid_diagram": {
      let result = await createWorkflowMermaidDiagramTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        {
          ...(typeof call.params.format === "string"
            ? { format: String(call.params.format) }
            : {}),
          ...(typeof call.params.title === "string"
            ? { title: String(call.params.title) }
            : {}),
          ...(typeof call.params.entry_node_id === "string"
            ? { entryNodeId: String(call.params.entry_node_id) }
            : {}),
          ...(typeof call.params.route_path === "string"
            ? { routePath: String(call.params.route_path) }
            : {}),
          ...(typeof call.params.file_path === "string"
            ? { filePath: String(call.params.file_path) }
            : {}),
          ...(typeof call.params.query === "string"
            ? { query: String(call.params.query) }
            : {}),
          ...(typeof call.params.max_hops === "number"
            ? { maxHops: Number(call.params.max_hops) }
            : {}),
          ...(typeof call.params.max_nodes === "number"
            ? { maxNodes: Number(call.params.max_nodes) }
            : {}),
          ...(typeof call.params.include_incoming === "boolean"
            ? { includeIncoming: Boolean(call.params.include_incoming) }
            : {}),
          ...(typeof call.params.include_external === "boolean"
            ? { includeExternal: Boolean(call.params.include_external) }
            : {}),
        },
      );
      result = annotateFileScopeConflicts(toolContext, toolName, result);
      if (result.success && typeof result.meta?.filePath === "string") {
        await toolContext.refreshWorkspaceFiles();
        if (call.params.open !== false) {
          await toolContext.revealFile(result.meta.filePath as string);
          return annotateFileScopeConflicts(toolContext, toolName, Object.freeze({
            success: true,
            content: `${result.content}\nOpened ${toDisplayPath(
              result.meta.filePath as string,
              toolContext.workspaceRoot,
            )}.`,
            meta: Object.freeze({
              ...result.meta,
              opened: true,
            }),
          }));
        }
      }
      return result;
    }
    case "convert_drawio_diagram":
      return executeDrawioNativeActionTool("convert", call, toolContext);
    case "export_drawio_diagram":
      return executeDrawioNativeActionTool("export", call, toolContext);
    case "insert_file_at_line": {
      const request: InsertFileAtLineRequest = Object.freeze({
        line: n(call, "line"),
        contentToInsert: String(call.params.content ?? ""),
        ...(typeof call.params.expected_total_lines === "number" &&
        Number.isFinite(call.params.expected_total_lines) &&
        Number(call.params.expected_total_lines) > 0
          ? { expectedTotalLines: Number(call.params.expected_total_lines) }
          : {}),
        ...(typeof call.params.anchor_before === "string"
          ? { anchorBefore: String(call.params.anchor_before) }
          : {}),
        ...(typeof call.params.anchor_after === "string"
          ? { anchorAfter: String(call.params.anchor_after) }
          : {}),
      });
      let result = executeInsertFileAtLineTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        request,
      );
      result = annotateFileScopeConflicts(toolContext, toolName, result);
      if (result.success && typeof result.meta?.filePath === "string") {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case "edit_file": {
      let result = executeEditFileTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        String(call.params.old_string ?? ""),
        String(call.params.new_string ?? ""),
        Boolean(call.params.replace_all ?? false),
      );
      result = annotateFileScopeConflicts(toolContext, toolName, result);
      if (result.success && typeof result.meta?.filePath === "string") {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case "edit_file_range": {
      const request: EditFileRangeRequest = Object.freeze({
        startLine: n(call, "start_line"),
        endLine: n(call, "end_line"),
        newContent: String(
          call.params.new_content ?? call.params.newContent ?? call.params.content ?? "",
        ),
        ...(typeof (call.params.expected_total_lines ?? call.params.expectedTotalLines) === "number" &&
        Number.isFinite(call.params.expected_total_lines ?? call.params.expectedTotalLines) &&
        Number(call.params.expected_total_lines ?? call.params.expectedTotalLines) > 0
          ? { expectedTotalLines: Number(call.params.expected_total_lines ?? call.params.expectedTotalLines) }
          : {}),
        ...(typeof (call.params.expected_range_content ?? call.params.expectedRangeContent) === "string"
          ? { expectedRangeContent: String(call.params.expected_range_content ?? call.params.expectedRangeContent) }
          : {}),
        ...(typeof (call.params.anchor_before ?? call.params.anchorBefore) === "string"
          ? { anchorBefore: String(call.params.anchor_before ?? call.params.anchorBefore) }
          : {}),
        ...(typeof (call.params.anchor_after ?? call.params.anchorAfter) === "string"
          ? { anchorAfter: String(call.params.anchor_after ?? call.params.anchorAfter) }
          : {}),
      });
      let result = executeEditFileRangeTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        request,
      );
      result = annotateFileScopeConflicts(toolContext, toolName, result);
      if (result.success && typeof result.meta?.filePath === "string") {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case "multi_edit_file_ranges": {
      let result = executeMultiEditFileRangesTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        coerceMultiEditRanges(call.params),
        Number(call.params.expected_total_lines ?? call.params.expectedTotalLines ?? 0),
      );
      result = annotateFileScopeConflicts(toolContext, toolName, result);
      if (result.success && typeof result.meta?.filePath === "string") {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case "grep":
      return grepTool(
        toolContext.workspaceRoot,
        p(call, "pattern"),
        p(call, "path", "."),
        {
          contextLines: Number(call.params.contextLines ?? 2),
        },
      );
    case "list_dir":
      return listDirTool(toolContext.workspaceRoot, p(call, "path", "."), {
        depth: Number(call.params.depth ?? 0),
      });
    case "head":
      return headTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        Number(call.params.lines ?? 50),
      );
    case "tail":
      return tailTool(
        toolContext.workspaceRoot,
        p(call, "path"),
        Number(call.params.lines ?? 50),
      );
    case "read_document":
      return readDocumentTool(toolContext.workspaceRoot, p(call, "path"), {
        maxChars: Number(call.params.maxChars ?? 20_000),
        offset: Number(call.params.offset ?? 0),
        query: String(call.params.query ?? ""),
      });
    case "search_web":
      return searchWebTool(
        toolContext.config,
        p(call, "query"),
        (() => {
          const timeRange = String(call.params.timeRange ?? "").trim();
          return {
            maxResults: Number(call.params.maxResults ?? 5),
            searchDepth: String(call.params.searchDepth ?? "basic") as
              | "basic"
              | "advanced",
            includeAnswer: Boolean(call.params.includeAnswer ?? false),
            includeRawContent: Boolean(call.params.includeRawContent ?? false),
            includeDomains: Array.isArray(call.params.includeDomains)
              ? (call.params.includeDomains as string[])
              : undefined,
            excludeDomains: Array.isArray(call.params.excludeDomains)
              ? (call.params.excludeDomains as string[])
              : undefined,
            ...(timeRange
              ? { timeRange: timeRange as "day" | "week" | "month" | "year" }
              : {}),
          };
        })(),
      );
    case "extract_web":
      return extractWebTool(
        toolContext.config,
        Array.isArray(call.params.urls) ? (call.params.urls as string[]) : [],
        {
          extractDepth: String(call.params.extractDepth ?? "basic") as
            | "basic"
            | "advanced",
          format: String(call.params.format ?? "text") as "text" | "markdown",
          query: p(call, "query"),
          includeImages: Boolean(call.params.includeImages ?? false),
          maxCharsPerUrl: Number(call.params.maxCharsPerUrl ?? 3_000),
        },
      );
    case "map_web":
      return mapWebTool(toolContext.config, p(call, "url"), {
        limit: Number(call.params.limit ?? 20),
        maxDepth: Number(call.params.maxDepth ?? 2),
        maxBreadth: Number(call.params.maxBreadth ?? 20),
        instructions: p(call, "instructions"),
        selectPaths: Array.isArray(call.params.selectPaths)
          ? (call.params.selectPaths as string[])
          : undefined,
        selectDomains: Array.isArray(call.params.selectDomains)
          ? (call.params.selectDomains as string[])
          : undefined,
        excludePaths: Array.isArray(call.params.excludePaths)
          ? (call.params.excludePaths as string[])
          : undefined,
        excludeDomains: Array.isArray(call.params.excludeDomains)
          ? (call.params.excludeDomains as string[])
          : undefined,
        allowExternal: Boolean(call.params.allowExternal ?? false),
      });
    case "crawl_web":
      return crawlWebTool(toolContext.config, p(call, "url"), {
        maxDepth: Number(call.params.maxDepth ?? 2),
        maxBreadth: Number(call.params.maxBreadth ?? 20),
        limit: Number(call.params.limit ?? 10),
        instructions: p(call, "instructions"),
        extractDepth: String(call.params.extractDepth ?? "basic") as
          | "basic"
          | "advanced",
        selectPaths: Array.isArray(call.params.selectPaths)
          ? (call.params.selectPaths as string[])
          : undefined,
        selectDomains: Array.isArray(call.params.selectDomains)
          ? (call.params.selectDomains as string[])
          : undefined,
        excludePaths: Array.isArray(call.params.excludePaths)
          ? (call.params.excludePaths as string[])
          : undefined,
        excludeDomains: Array.isArray(call.params.excludeDomains)
          ? (call.params.excludeDomains as string[])
          : undefined,
        allowExternal: Boolean(call.params.allowExternal ?? false),
        includeImages: Boolean(call.params.includeImages ?? false),
        format: String(call.params.format ?? "text") as "text" | "markdown",
        maxCharsPerPage: Number(call.params.maxCharsPerPage ?? 3_000),
      });
    case "validate_code":
      try {
        return validateCodeTool(
          resolveWorkspacePath(toolContext.workspaceRoot, p(call, "path")),
        );
      } catch (error) {
        return Object.freeze({
          success: false,
          content: "",
          error: String(error),
        });
      }
    case "run_validation_suite":
      return runValidationSuiteTool(toolContext.workspaceRoot, toolContext.config, {
        paths: Array.isArray(call.params.paths)
          ? (call.params.paths as readonly unknown[])
          : undefined,
      });
    case "get_change_summary":
      return getChangeSummaryTool(toolContext.workspaceRoot);
    case "run_in_terminal":
      return runInTerminalTool(
        toolContext.workspaceRoot,
        p(call, "command"),
        {
          cwd: p(call, "cwd"),
          timeoutMs: Number(call.params.timeoutMs ?? 8_000),
          maxChars: Number(call.params.maxChars ?? 4_000),
        },
      );
    case "run_project_command":
    case "run_terminal_command": {
      const commandText = p(call, "command", p(call, "commandId"));
      const blocked = blockCodingAgentValidationCommand(
        toolContext.config,
        commandText,
      );
      if (blocked) {
        return blocked;
      }
      return runProjectCommandTool(
        toolContext.workspaceRoot,
        commandText,
        {
          cwd: p(call, "cwd"),
          maxChars: Number(call.params.maxChars ?? 8_000),
          ...(toolName === "run_terminal_command"
            ? { asyncStartOnly: true }
            : {}),
          stream:
            typeof call.params.toolCallId === "string"
              ? {
                  onStart: async ({ commandText, cwd, startedAt }) => {
                    await toolContext.onProjectCommandStart?.({
                      toolCallId: call.params.toolCallId as string,
                      commandText,
                      cwd,
                      startedAt,
                    });
                  },
                  onChunk: async ({ chunk }) => {
                    await toolContext.onProjectCommandChunk?.({
                      toolCallId: call.params.toolCallId as string,
                      chunk,
                    });
                  },
                  onEnd: async ({
                    exitCode,
                    success,
                    durationMs,
                    background,
                  }) => {
                    await toolContext.onProjectCommandEnd?.({
                      toolCallId: call.params.toolCallId as string,
                      exitCode,
                      success,
                      durationMs,
                      ...(background ? { background } : {}),
                    });
                  },
                  onComplete: async ({
                    commandText,
                    cwd,
                    exitCode,
                    success,
                    durationMs,
                    output,
                    background,
                  }) => {
                    await toolContext.onProjectCommandComplete?.({
                      toolCallId: call.params.toolCallId as string,
                      commandText,
                      cwd,
                      exitCode,
                      success,
                      durationMs,
                      output,
                      background,
                    });
                  },
                }
              : undefined,
        },
      );
    }
    case "await_terminal_command":
      return awaitManagedProjectCommandTool(p(call, "commandId"), {
        timeoutMs: Number(call.params.timeoutMs ?? 15_000),
        maxChars: Number(call.params.maxChars ?? 8_000),
      });
    case "get_terminal_output":
      return getManagedProjectCommandOutputTool(p(call, "commandId"), {
        maxChars: Number(call.params.maxChars ?? 8_000),
      });
    case "kill_terminal_command":
      return killManagedProjectCommandTool(p(call, "commandId"));
    case "git_status":
      return gitStatusTool(toolContext.workspaceRoot, {
        cwd: p(call, "cwd"),
        short: Boolean(call.params.short ?? false),
        pathspec: p(call, "pathspec"),
      });
    case "git_diff":
      return gitDiffTool(toolContext.workspaceRoot, {
        cwd: p(call, "cwd"),
        pathspec: p(call, "pathspec"),
        staged: Boolean(call.params.staged ?? false),
        maxChars: Number(call.params.maxChars ?? 8_000),
      });
    case "git_add":
      return gitAddTool(
        toolContext.workspaceRoot,
        Array.isArray(call.params.paths)
          ? (call.params.paths as unknown[])
              .map((item) => String(item ?? "").trim())
              .filter(Boolean)
          : [],
        { cwd: p(call, "cwd") },
      );
    case "git_commit":
      return gitCommitTool(toolContext.workspaceRoot, p(call, "message"), {
        cwd: p(call, "cwd"),
        all: Boolean(call.params.all ?? false),
      });
    case "git_push":
      return gitPushTool(toolContext.workspaceRoot, {
        cwd: p(call, "cwd"),
        remote: p(call, "remote"),
        branch: p(call, "branch"),
      });
    case "git_pull":
      return gitPullTool(toolContext.workspaceRoot, {
        cwd: p(call, "cwd"),
        remote: p(call, "remote"),
        branch: p(call, "branch"),
      });
    case "git_checkout":
      return gitCheckoutTool(toolContext.workspaceRoot, p(call, "ref"), {
        cwd: p(call, "cwd"),
        createBranch: Boolean(call.params.createBranch ?? false),
      });
    case "vscode_open_diff":
      return toolContext.openTrackedDiff
        ? toolContext.openTrackedDiff(p(call, "path"))
        : Object.freeze({
            success: false,
            content: "",
            error: "VS Code native diff is not available in this context.",
          });
    case "vscode_show_problems":
      return toolContext.showProblems
        ? toolContext.showProblems(p(call, "path"))
        : Object.freeze({
            success: false,
            content: "",
            error: "VS Code problems view is not available in this context.",
          });
    case "vscode_workspace_search":
      return toolContext.workspaceSearch
        ? toolContext.workspaceSearch(p(call, "query"), {
            includes: p(call, "includes"),
            maxResults: Number(call.params.maxResults ?? 20),
            isRegex: Boolean(call.params.isRegex ?? false),
            isCaseSensitive: Boolean(call.params.isCaseSensitive ?? false),
            matchWholeWord: Boolean(call.params.matchWholeWord ?? false),
          })
        : Object.freeze({
            success: false,
            content: "",
            error: "VS Code workspace search is not available in this context.",
          });
    case "vscode_find_references":
      return toolContext.findReferences
        ? toolContext.findReferences(p(call, "path"), {
            line:
              typeof call.params.line === "number"
                ? Number(call.params.line)
                : undefined,
            character:
              typeof call.params.character === "number"
                ? Number(call.params.character)
                : undefined,
            symbol: p(call, "symbol"),
            maxResults: Number(call.params.maxResults ?? 20),
          })
        : Object.freeze({
            success: false,
            content: "",
            error:
              "VS Code references provider is not available in this context.",
          });
    case "search_extension_tools":
      return toolContext.searchExtensionTools
        ? toolContext.searchExtensionTools(
            p(call, "query"),
            Number(call.params.maxResults ?? 8),
          )
        : Object.freeze({
            success: false,
            content: "",
            error: "Extension tool search is not available in this context.",
          });
    case "activate_extension_tools":
      return toolContext.activateExtensionTools
        ? toolContext.activateExtensionTools(
            Array.isArray(call.params.tool_keys)
              ? (call.params.tool_keys as unknown[])
                  .map((item) => String(item ?? "").trim())
                  .filter(Boolean)
              : [],
          )
        : Object.freeze({
            success: false,
            content: "",
            error:
              "Extension tool activation is not available in this context.",
          });
    case "galaxy_design_project_info":
      return galaxyDesignProjectInfoTool(
        toolContext.workspaceRoot,
        p(call, "path"),
      );
    case "galaxy_design_registry":
      return galaxyDesignRegistryTool(toolContext.workspaceRoot, {
        framework: p(call, "framework"),
        component: p(call, "component"),
        group: p(call, "group"),
        query: p(call, "query"),
        path: p(call, "path"),
      });
    case "galaxy_design_init": {
      const result = await galaxyDesignInitTool(
        toolContext.workspaceRoot,
        p(call, "path"),
      );
      if (result.success) {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case "galaxy_design_add": {
      const result = await galaxyDesignAddTool(
        toolContext.workspaceRoot,
        Array.isArray(call.params.components)
          ? (call.params.components as string[])
          : p(call, "components"),
        p(call, "path"),
      );
      if (result.success) {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    default:
      return Object.freeze({
        success: false,
        content: "",
        error: `Unknown tool: ${call.name}`,
      });
  }
}
