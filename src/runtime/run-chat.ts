/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Orchestrate one extension chat turn, including prompt building, tool execution, approvals, review, and session tracking.
 */

import type { GalaxyConfig } from "../shared/config";
import {
  askActionApproval,
  buildPermissionContextBlock,
  denyActionApproval,
  getCommandPermission,
  grantActionApproval,
} from "../context/action-approval-store";
import {
  mapPathsToProjectScope,
  resolveEffectiveProjectPath,
} from "../context/active-project";
import {
  computeWorkingContextBudget,
  estimateTokens,
} from "../context/compaction";
import { buildPromptContext } from "../context/prompt-builder";
import { appendTelemetryEvent } from "../context/telemetry";
import type { HistoryManager } from "../context/entities/history-manager";
import { scheduleWorkflowGraphRefresh } from "../context/workflow/extractor/runtime";
import { noteFileTouchedForGraph } from "../context/workflow/extractor/touch-queue";
import { evaluateWorkflowRereadGuard } from "../context/workflow/reread-guard";
import {
  buildSubagentRoleConfig,
  getSubagentRoleDefinition,
} from "../shared/subagents";
import type {
  AgentType,
  ChatMessage,
  ToolApprovalDecision,
} from "../shared/protocol";
import type { PendingActionApproval, RunResult } from "../shared/runtime";
import { executeToolAsync } from "../tools/file/dispatch";
import {
  getEnabledToolDefinitions,
} from "../tools/file/definitions";
import { getToolFilePath, normalizeToolName } from "../tools/file/tooling";
import type { FileToolContext, ToolCall, ToolResult } from "../tools/entities/file-tools";
import { runCodeReviewTool } from "./code-reviewer";
import { buildApprovalRequest, getBlockedCapability } from "./chat-approvals";
import { createDriver } from "./driver-factory";
import { derivePromptContextHints } from "./drivers/message-builders";
import {
  captureWorkspaceSnapshot,
  getOriginalContent,
  getSessionFiles,
  trackWorkspaceChanges,
} from "./session-tracker";
import { recordCodeEdit } from "../context/rag-metadata/code-edits";
import { recordFileRead } from "../context/rag-metadata/file-reads";
import { buildSystemPrompt } from "./system-prompt";
import type { StreamChunk } from "../shared/runtime";
import {
  computeAdaptiveToolRoundLimit,
  getToolRoundExtensionStep,
  getToolRoundStallLimit,
  isProductiveToolResult,
} from "../shared/tool-budget";
import { evaluateTestingCommandPolicy } from "../validation/workspace-topology";

function shouldCompleteCodingAfterBoundaryTool(
  role: string | undefined,
  blockedCapability: string,
  filesWrittenCount: number,
): boolean {
  const codingBoundaryCapabilities = new Set([
    "runCommands",
    "validation",
    "review",
    "webResearch",
    "galaxyDesign",
    "vscodeNative",
  ]);
  return (
    role === "coding" &&
    filesWrittenCount > 0 &&
    codingBoundaryCapabilities.has(blockedCapability)
  );
}

function buildBoundaryHandoffForBlockedTool(opts: {
  role: string | undefined;
  blockedCapability: string;
  toolName: string;
  filesWrittenCount: number;
}): string | null {
  if (
    shouldCompleteCodingAfterBoundaryTool(
      opts.role,
      opts.blockedCapability,
      opts.filesWrittenCount,
    )
  ) {
    return "Coding changes were written. The blocked tool is outside the Coding Agent role boundary, so validation, review, web research, or environment execution is delegated to the next role that owns that capability.";
  }
  const readOnlyRoles = new Set(["ba", "profiler", "planning", "sa", "review"]);
  const boundaryCapabilities = new Set([
    "editFiles",
    "runCommands",
    "validation",
    "review",
  ]);
  if (
    opts.role &&
    readOnlyRoles.has(opts.role) &&
    boundaryCapabilities.has(opts.blockedCapability)
  ) {
    return [
      `${opts.role} role attempted to use ${opts.toolName}, but that tool is outside the active role boundary.`,
      "The blocked tool was not executed. Continue with the current role handoff and delegate implementation, validation, or review work to the next role that owns that capability.",
    ].join(" ");
  }
  return null;
}

function buildUnavailableToolMessage(
  toolName: string,
  enabledToolNamesText: string,
): string {
  const guidance: string[] = [];
  if (toolName === "edit" || toolName === "edit_file") {
    guidance.push(
      "For file edits, use multi_edit_file_ranges with one or more edits after a recent read_file result. For a coherent whole-file repair, read the file and use write_file with overwrite_existing=true.",
    );
  }
  return [
    `Tool call was not executed. Available tool names for this role are:\n${enabledToolNamesText}`,
    "If the desired tool is not in this list, do not retry it with a synonym. Finish with write_agent_handoff when the needed capability belongs to another subagent role.",
    ...guidance,
  ].join("\n\n");
}

const VALIDATION_COMMAND_TOOLS = new Set([
  "run_project_command",
  "run_terminal_command",
]);

const READ_ONLY_HANDOFF_ROLES = new Set(["ba", "profiler", "planning", "sa", "review"]);
const READ_ONLY_EVIDENCE_HANDOFF_THRESHOLD = Object.freeze({
  ba: 4,
  profiler: 6,
  planning: 5,
  sa: 6,
  review: 4,
} as const);

function getReadOnlyEvidenceHandoffThreshold(role: string | undefined): number | null {
  if (!role || !READ_ONLY_HANDOFF_ROLES.has(role)) {
    return null;
  }
  return READ_ONLY_EVIDENCE_HANDOFF_THRESHOLD[role as keyof typeof READ_ONLY_EVIDENCE_HANDOFF_THRESHOLD] ?? null;
}

const VALIDATION_COMMAND_PATTERN = /\b(test|jest|vitest|typecheck|tsc|lint|eslint|build|check)\b/i;
const TARGETED_EDIT_TOOLS = new Set([
  "multi_edit_file_ranges",
  "insert_file_at_line",
]);
const STALE_TARGETED_EDIT_PATTERN = /requires exact snapshot evidence|no longer matches the last read snapshot|read the file again/i;

function inferValidationCommandCategory(command: string): string | null {
  const lowered = command.trim().toLowerCase();
  if (/\b(test|jest|vitest|playwright\s+test)\b/.test(lowered)) return "test";
  if (/\b(typecheck|type-check|check-types|tsc)\b/.test(lowered)) return "static-check";
  if (/\b(lint|eslint|biome|oxlint)\b/.test(lowered)) return "lint";
  if (/\b(build|compile|next\s+build|vite\s+build|nest\s+build)\b/.test(lowered)) return "build";
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/.test(lowered)) return "setup";
  return null;
}

function buildValidationCommandRetryKey(
  toolName: string,
  params: Readonly<Record<string, unknown>>,
): string | null {
  if (!VALIDATION_COMMAND_TOOLS.has(toolName)) {
    return null;
  }
  const command = typeof params.command === "string"
    ? params.command.replace(/\s+/g, " ").trim()
    : "";
  if (!command || !VALIDATION_COMMAND_PATTERN.test(command)) {
    return null;
  }
  const cwd = typeof params.cwd === "string" && params.cwd.trim()
    ? params.cwd.trim()
    : ".";
  return `${cwd} :: ${inferValidationCommandCategory(command) ?? "validation"}`;
}

function buildValidationRetryBlockedResult(key: string): ToolResult {
  return Object.freeze({
    success: false,
    content: [
      `Validation retry budget exhausted for ${key}.`,
      "Record the latest command output and remaining blocker in write_agent_handoff instead of repeating the same package validation command.",
    ].join("\n"),
    error: "Repeated validation command failed in the same package.",
    meta: Object.freeze({
      validationRetryBlocked: true,
      validationCommandKey: key,
    }),
  });
}

function shouldCompleteTestingAfterEnvironmentBlock(
  role: string | undefined,
  toolName: string,
  result: ToolResult,
): boolean {
  if (role !== "testing") {
    return false;
  }
  const meta = (result.meta ?? {}) as Readonly<Record<string, unknown>>;
  if (meta.validationRetryBlocked === true) {
    return true;
  }
  if (
    meta.testingCommandBlocked === true &&
    String(meta.category ?? "") === "setup"
  ) {
    return true;
  }
  if (!VALIDATION_COMMAND_TOOLS.has(toolName) || result.success) {
    return false;
  }
  const text = `${result.error ?? ""}\n${result.content ?? ""}`;
  return /(?:command not found|not found:|ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|node_modules)/i.test(text);
}

function buildTestingEnvironmentBoundaryHandoff(toolName: string, result: ToolResult): string {
  const meta = (result.meta ?? {}) as Readonly<Record<string, unknown>>;
  const category = String(meta.category ?? "");
  const packagePath = typeof meta.packagePath === "string" ? meta.packagePath : "";
  return [
    `Testing reached an environment/setup boundary while using ${toolName}${category ? ` (${category})` : ""}.`,
    packagePath ? `Blocked scope: ${packagePath}.` : "",
    "The command was not repeated. Testing should hand off the missing dependency/runtime/setup requirement and continue only with scopes already proven ready by the ProjectProfile/environment readiness evidence.",
  ].filter(Boolean).join(" ");
}

function isStaleTargetedEditFailure(toolName: string, result: ToolResult, toolContent: string): boolean {
  return (
    !result.success &&
    TARGETED_EDIT_TOOLS.has(toolName) &&
    STALE_TARGETED_EDIT_PATTERN.test(`${result.error ?? ""}\n${toolContent}`)
  );
}

function buildStaleTargetedEditRecoveryMessage(filePath: string, count: number): string {
  const target = filePath || "the target file";
  return [
    `Stale targeted edit recovery (${count}): stop retrying the same range edit on ${target}.`,
    "Read the current file again, then either use write_file with overwrite_existing=true for one coherent whole-file repair, or move on to remaining user-requested files/tests and hand off the blocker.",
  ].join("\n");
}

function stringParam(params: Readonly<Record<string, unknown>>, name: string): string {
  const value = params[name];
  return typeof value === "string" ? value : "";
}

/**
 * Creates a stable-ish message id for transcript entries generated during one run.
 *
 * @returns Message id string.
 */
function createMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildRuntimeAgentMetadata(
  config: GalaxyConfig,
  agentType: AgentType,
): Readonly<{
  agentRole: string;
  agentModel: string;
  phase: string;
}> {
  const roleId = config.activeSubagentRole;
  const agentModel =
    config.agent.find((agent) => agent.type === agentType)?.model ??
    config.agent.find((agent) => agent.type === "manual")?.model ??
    agentType;
  if (roleId) {
    const role = getSubagentRoleDefinition(roleId);
    return Object.freeze({
      agentRole: role.title,
      agentModel,
      phase: `Subagent: ${roleId}`,
    });
  }
  return Object.freeze({
    agentRole: "Main Agent",
    agentModel,
    phase: "Main turn",
  });
}

/**
 * Formats tool output for transcript display while preserving async/background command semantics.
 *
 * @param toolName Tool runtime name associated with the result.
 * @param result Raw tool result returned by dispatch.
 * @returns Transcript-safe tool message content.
 */
function formatToolResultContent(
  toolName: string,
  result: Readonly<{
    success: boolean;
    content: string;
    error?: string;
    meta?: Readonly<Record<string, unknown>>;
  }>,
): string {
  if (!result.success) {
    const tailOutput =
      typeof result.meta?.tailOutput === "string"
        ? String(result.meta.tailOutput).trim()
        : "";
    const diagnosticOutput = result.content.trim() || tailOutput;
    return [
      `Error: ${result.error ?? "Unknown error"}`,
      diagnosticOutput,
    ].filter(Boolean).join("\n\n");
  }

  const commandState =
    typeof result.meta?.commandState === "string"
      ? String(result.meta.commandState)
      : "";
  const isBackgroundRunning =
    result.meta?.background === true &&
    (result.meta?.running === true || commandState === "running");
  if (isBackgroundRunning) {
    const commandLabel =
      typeof result.meta?.commandLabel === "string" &&
      result.meta.commandLabel.trim()
        ? result.meta.commandLabel
        : toolName;
    const commandId =
      typeof result.meta?.commandId === "string" && result.meta.commandId.trim()
        ? result.meta.commandId
        : "";
    return [
      `Command started and is still running in the background: ${commandLabel}`,
      ...(commandId ? [`commandId: ${commandId}`] : []),
      ...(commandId
        ? [
            `Use await_terminal_command with commandId "${commandId}" to wait for completion.`,
          ]
        : []),
      "Use View terminal to inspect live output while Galaxy continues working.",
    ].join("\n");
  }

  return result.content || "(no output)";
}

/**
 * Runs one full extension chat turn, including prompt assembly, tool loops, approvals, validation handoff, and telemetry.
 *
 * @param opts Turn runtime dependencies and UI callbacks.
 * @returns Final accumulated assistant output and file-write summary for the turn.
 */
export async function runExtensionChat(opts: {
  config: GalaxyConfig;
  agentType: AgentType;
  historyManager: HistoryManager;
  toolContext: FileToolContext;
  onChunk: (chunk: StreamChunk) => Promise<void> | void;
  onMessage: (message: ChatMessage) => Promise<void> | void;
  onToolCalls?: (
    toolCalls: readonly Readonly<{
      id: string;
      name: string;
      params: Record<string, unknown>;
    }>[],
  ) => Promise<void> | void;
  onStatus?: (statusText: string) => Promise<void> | void;
  onEvidenceContext?: (payload: {
    content: string;
    tokens: number;
    entryCount: number;
    finalPromptTokens?: number;
    focusSymbols?: readonly string[];
    manualPlanningContent?: string;
    manualReadBatchItems?: readonly string[];
    readPlanProgressItems?: readonly Readonly<{
      label: string;
      confirmed: boolean;
      evidenceSummary?: string;
      targetPath: string;
      symbolName?: string;
      tool: "read_file" | "grep";
    }>[];
    confirmedReadCount?: number;
  }) => Promise<void> | void;
  requestToolApproval: (
    approval: PendingActionApproval,
  ) => Promise<ToolApprovalDecision>;
}): Promise<RunResult> {
  const driver = createDriver(opts.config, opts.agentType, true);
  const workspacePath = opts.historyManager.getSessionMemory().workspacePath;
  const runtimeMetadata = buildRuntimeAgentMetadata(opts.config, opts.agentType);
  appendTelemetryEvent(workspacePath, {
    kind: "capability_snapshot",
    source: "chat_turn",
    agentType: opts.agentType,
    enabledCapabilities: Object.freeze(
      Object.entries(opts.config.toolCapabilities)
        .filter(([, enabled]) => enabled)
        .map(([capability]) => capability)
        .sort(),
    ),
  });
  const filesWritten = new Set<string>();
  let maxToolRounds = computeAdaptiveToolRoundLimit({
    config: opts.config,
    workspacePath,
  });
  const toolRoundExtensionStep = getToolRoundExtensionStep(opts.config);
  const toolRoundStallLimit = getToolRoundStallLimit(opts.config);
  let consecutiveNonProductiveRounds = 0;
  let consecutiveUnavailableToolOnlyRounds = 0;
  let boundaryHandoffText = "";
  const validationCommandFailureCounts = new Map<string, number>();
  const staleTargetedEditFailureCounts = new Map<string, number>();
  const observedEvidenceKeys = new Set<string>();
  const enabledToolDefinitions = getEnabledToolDefinitions(opts.config);
  const enabledToolNameSet = new Set(enabledToolDefinitions.map((tool) => normalizeToolName(tool.name)));
  const enabledToolNamesText = enabledToolDefinitions
    .map((tool) => `- ${tool.name}`)
    .join("\n") || "- none";
  const toolSchemaTokens = estimateTokens(
    JSON.stringify(enabledToolDefinitions),
  );

  for (
    let round = 0;
    maxToolRounds === null || round < maxToolRounds;
    round += 1
  ) {
    const buildRoundPrompt = async () => {
      const promptBuild = await buildPromptContext({
        agentType: opts.agentType,
        notes: opts.historyManager.getNotes(),
        sessionMemory: opts.historyManager.getSessionMemory(),
        workingTurn: opts.historyManager.getWorkingTurn(),
      });
      const systemPromptTokens = estimateTokens(
        buildSystemPrompt(
          opts.agentType,
          opts.config,
          derivePromptContextHints(promptBuild.messages),
        ),
      );
      const permissionsBlock = buildPermissionContextBlock(workspacePath);
      const permissionTokens = permissionsBlock
        ? estimateTokens(permissionsBlock)
        : 0;
      const promptTokensEstimate =
        promptBuild.finalPromptTokens +
        systemPromptTokens +
        toolSchemaTokens +
        permissionTokens;
      return {
        promptBuild,
        permissionsBlock,
        promptTokensEstimate,
      };
    };

    let roundPrompt = await buildRoundPrompt();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const workingTurnBudget = computeWorkingContextBudget({
        promptTokensEstimate: roundPrompt.promptTokensEstimate,
        workingTurnTokens: roundPrompt.promptBuild.workingTurnTokens,
      });
      const compacted = opts.historyManager.compactWorkingTurn({
        workingTurnBudget,
        promptTokensEstimate: roundPrompt.promptTokensEstimate,
      });
      if (!compacted) {
        break;
      }
      appendTelemetryEvent(workspacePath, {
        kind: "working_turn_compacted",
        promptTokensEstimate: roundPrompt.promptTokensEstimate,
        workingTurnBudget,
        workingTurnTokens: roundPrompt.promptBuild.workingTurnTokens,
      });
      roundPrompt = await buildRoundPrompt();
    }

    const { promptBuild, permissionsBlock, promptTokensEstimate } = roundPrompt;
    await opts.onEvidenceContext?.({
      content: promptBuild.evidenceContent,
      tokens: promptBuild.evidenceTokens,
      entryCount: promptBuild.evidenceEntryCount,
      finalPromptTokens: promptTokensEstimate,
      focusSymbols: promptBuild.focusSymbols,
      manualPlanningContent: promptBuild.manualPlanningContent,
      manualReadBatchItems: promptBuild.manualReadBatchItems,
      readPlanProgressItems: promptBuild.readPlanProgressItems,
      confirmedReadCount: promptBuild.confirmedReadCount,
    });
    const messages = permissionsBlock
      ? Object.freeze([
          ...promptBuild.messages,
          Object.freeze({
            id: `ctx-command-permissions-${Date.now()}`,
            role: "user" as const,
            content: permissionsBlock,
            timestamp: Date.now(),
          }),
        ])
      : promptBuild.messages;

    let roundText = "";
    let roundThinking = "";
    let errorMessage = "";
    const pendingToolCalls: ToolCall[] = [];
    const normalizedToolNamesThisRound: string[] = [];
    let roundMadeProductiveProgress = false;
    let roundExecutedKnownTools = false;
    let roundBlockedUnavailableTool = false;
    let shouldCompleteAfterBoundaryTool = false;

    await driver.chat(messages, async (chunk) => {
      if (chunk.type === "text") {
        roundText += chunk.delta;
        await opts.onChunk(chunk);
        return;
      }

      if (chunk.type === "thinking") {
        roundThinking += chunk.delta;
        await opts.onChunk(chunk);
        return;
      }

      if (chunk.type === "tool_call") {
        pendingToolCalls.push(chunk.call);
        await opts.onStatus?.(
          `${runtimeMetadata.agentRole} (${runtimeMetadata.agentModel}) tool: ${normalizeToolName(chunk.call.name)}`,
        );
        return;
      }

      if (chunk.type === "error") {
        errorMessage = chunk.message;
        await opts.onChunk(chunk);
      }
    });

    if (errorMessage) {
      return Object.freeze({
        assistantText: roundText,
        assistantThinking: roundThinking,
        errorMessage,
        filesWritten: Object.freeze([...filesWritten]),
      });
    }

    if (roundText.trim()) {
      opts.historyManager.appendAssistantDraft(roundText);
    }

    if (pendingToolCalls.length === 0) {
      return Object.freeze({
        assistantText: roundText,
        assistantThinking: roundThinking,
        filesWritten: Object.freeze([...filesWritten]),
      });
    }

    const assistantToolCalls = pendingToolCalls.map((call) =>
      Object.freeze({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: normalizeToolName(call.name),
        params: call.params,
      }),
    );

    const assistantContextMessage: ChatMessage = Object.freeze({
      id: createMessageId(),
      role: "assistant",
      content: roundText,
      agentType: opts.agentType,
      ...runtimeMetadata,
      ...(roundThinking.trim() ? { thinking: roundThinking } : {}),
      toolCalls: Object.freeze(assistantToolCalls),
      timestamp: Date.now(),
    });
    opts.historyManager.appendContextMessage(assistantContextMessage);
    await opts.onToolCalls?.(assistantToolCalls);

    if (roundText.trim() || roundThinking.trim()) {
      await opts.onMessage(assistantContextMessage);
    }

    for (let index = 0; index < pendingToolCalls.length; index += 1) {
      const call = pendingToolCalls[index]!;
      const toolCall = assistantToolCalls[index]!;
      const toolName = normalizeToolName(call.name);
      normalizedToolNamesThisRound.push(toolName);

      if (!enabledToolNameSet.has(toolName)) {
        roundBlockedUnavailableTool = true;
        const blockedCapability = getBlockedCapability(toolName);
        const blockedBoundaryHandoff = buildBoundaryHandoffForBlockedTool({
          role: opts.config.activeSubagentRole,
          blockedCapability,
          toolName,
          filesWrittenCount: filesWritten.size,
        });
        if (blockedBoundaryHandoff) {
          shouldCompleteAfterBoundaryTool = true;
          boundaryHandoffText = blockedBoundaryHandoff;
        }
        appendTelemetryEvent(workspacePath, {
          kind: "blocked_tool",
          toolName,
          capability: blockedCapability,
        });
        const disabledToolMessage: ChatMessage = Object.freeze({
          id: createMessageId(),
          role: "tool",
          content: buildUnavailableToolMessage(toolName, enabledToolNamesText),
          timestamp: Date.now(),
          toolName,
          toolParams: Object.freeze(call.params),
          toolSuccess: false,
          toolCallId: toolCall.id,
        });
        opts.historyManager.appendToolMessage(disabledToolMessage);
        await opts.onMessage(disabledToolMessage);
        continue;
      }

      roundExecutedKnownTools = true;
      const approvalRequest = buildApprovalRequest({
        workspacePath,
        config: opts.config,
        toolName,
        params: call.params,
      });
      if (toolName === "run_project_command" && approvalRequest) {
        const permission = getCommandPermission(
          workspacePath,
          approvalRequest.approvalKey,
        );
        if (permission === "deny") {
          const deniedToolMessage: ChatMessage = Object.freeze({
            id: createMessageId(),
            role: "tool",
            content: `Permission denied by user for command: ${approvalRequest.approvalKey}`,
            timestamp: Date.now(),
            toolName,
            toolParams: Object.freeze(call.params),
            toolSuccess: false,
            toolCallId: toolCall.id,
          });
          opts.historyManager.appendToolMessage(deniedToolMessage);
          await opts.onMessage(deniedToolMessage);
          continue;
        }

        if (permission !== "allow") {
          const decision = await opts.requestToolApproval(approvalRequest);
          if (decision === "allow") {
            grantActionApproval(
              workspacePath,
              approvalRequest.approvalKey,
              toolName,
            );
          } else if (decision === "ask") {
            askActionApproval(workspacePath, approvalRequest.approvalKey);
          } else if (decision === "deny") {
            denyActionApproval(workspacePath, approvalRequest.approvalKey);
            const deniedToolMessage: ChatMessage = Object.freeze({
              id: createMessageId(),
              role: "tool",
              content: `Permission denied by user for command: ${approvalRequest.approvalKey}`,
              timestamp: Date.now(),
              toolName,
              toolParams: Object.freeze(call.params),
              toolSuccess: false,
              toolCallId: toolCall.id,
            });
            opts.historyManager.appendToolMessage(deniedToolMessage);
            await opts.onMessage(deniedToolMessage);
            continue;
          }
        }
      } else if (approvalRequest) {
        const decision = await opts.requestToolApproval(approvalRequest);
        if (decision === "deny") {
          const deniedToolMessage: ChatMessage = Object.freeze({
            id: createMessageId(),
            role: "tool",
            content: `Permission denied by user for ${toolName}.`,
            timestamp: Date.now(),
            toolName,
            toolParams: Object.freeze(call.params),
            toolSuccess: false,
            toolCallId: toolCall.id,
          });
          opts.historyManager.appendToolMessage(deniedToolMessage);
          await opts.onMessage(deniedToolMessage);
          continue;
        }
      }

      const workflowGuardDecision = evaluateWorkflowRereadGuard({
        workspacePath,
        toolName,
        params: call.params,
        guard: promptBuild.workflowRereadGuard,
      });
      if (workflowGuardDecision.blocked) {
        const blockedToolMessage: ChatMessage = Object.freeze({
          id: createMessageId(),
          role: "tool",
          content: `Error: ${workflowGuardDecision.reason}`,
          timestamp: Date.now(),
          toolName,
          toolParams: Object.freeze(call.params),
          toolSuccess: false,
          toolCallId: toolCall.id,
          toolMeta: Object.freeze({
            blockedBy: "workflow_reread_guard",
            relativePath: workflowGuardDecision.relativePath ?? "",
          }),
        });
        opts.historyManager.appendToolMessage(blockedToolMessage);
        await opts.onMessage(blockedToolMessage);
        continue;
      }

      await opts.onStatus?.(
        `${runtimeMetadata.agentRole} (${runtimeMetadata.agentModel}) executing: ${toolName}`,
      );
      const shouldTrackWorkspaceChanges = [
        "run_project_command",
        "galaxy_design_init",
        "galaxy_design_add",
      ].includes(toolName);
      const workspaceSnapshotBefore = shouldTrackWorkspaceChanges
        ? captureWorkspaceSnapshot(workspacePath)
        : null;
      const validationRetryKey = opts.config.activeSubagentRole === "testing"
        ? buildValidationCommandRetryKey(toolName, call.params)
        : null;
      const testingCommandPolicy = opts.config.activeSubagentRole === "testing" && VALIDATION_COMMAND_TOOLS.has(toolName)
        ? evaluateTestingCommandPolicy(
            workspacePath,
            stringParam(call.params, "command") || stringParam(call.params, "commandId"),
            stringParam(call.params, "cwd") || ".",
          )
        : null;
      let result: ToolResult =
        testingCommandPolicy && !testingCommandPolicy.allowed
          ? {
              success: false,
              content: testingCommandPolicy.reason ?? "Testing command blocked by validation topology.",
              error: "Testing command blocked by validation topology.",
              meta: Object.freeze({
                testingCommandBlocked: true,
                category: testingCommandPolicy.category,
                packagePath: testingCommandPolicy.packagePath,
              }),
            }
          : validationRetryKey && (validationCommandFailureCounts.get(validationRetryKey) ?? 0) >= 2
          ? buildValidationRetryBlockedResult(validationRetryKey)
          : toolName === "request_code_review"
            ? await runCodeReviewTool({
                workspacePath,
                sessionFiles: getSessionFiles(),
                config: opts.config.subagent
                  ? buildSubagentRoleConfig(opts.config, "review")
                  : opts.config,
                agentType: opts.agentType,
              })
            : await executeToolAsync(
                Object.freeze({
                  ...call,
                  params: Object.freeze({
                    ...call.params,
                    ...(toolName === "run_project_command" ||
                    toolName === "run_terminal_command"
                      ? { toolCallId: toolCall.id }
                      : {}),
                  }),
                }),
                opts.toolContext,
              );
      if (validationRetryKey) {
        if (result.success) {
          validationCommandFailureCounts.delete(validationRetryKey);
        } else {
          validationCommandFailureCounts.set(
            validationRetryKey,
            (validationCommandFailureCounts.get(validationRetryKey) ?? 0) + 1,
          );
        }
      }
      let toolContent = formatToolResultContent(toolName, result);
      if (
        !shouldCompleteAfterBoundaryTool &&
        shouldCompleteTestingAfterEnvironmentBlock(
          opts.config.activeSubagentRole,
          toolName,
          result,
        )
      ) {
        shouldCompleteAfterBoundaryTool = true;
        boundaryHandoffText = buildTestingEnvironmentBoundaryHandoff(toolName, result);
        appendTelemetryEvent(workspacePath, {
          kind: "blocked_tool",
          toolName,
          capability: "testingEnvironmentBoundary",
        });
      }
      if (opts.config.activeSubagentRole === "coding" && isStaleTargetedEditFailure(toolName, result, toolContent)) {
        const staleFilePath = getToolFilePath(call as ToolCall);
        const staleKey = `${toolName}:${staleFilePath || "unknown"}`;
        const staleCount = (staleTargetedEditFailureCounts.get(staleKey) ?? 0) + 1;
        staleTargetedEditFailureCounts.set(staleKey, staleCount);
        const recoveryMessage = buildStaleTargetedEditRecoveryMessage(staleFilePath, staleCount);
        result = Object.freeze({
          ...result,
          content: [result.content ?? "", recoveryMessage].filter((part) => part.trim()).join("\n\n"),
          meta: Object.freeze({
            ...(result.meta ?? {}),
            staleTargetedEditFailure: true,
            staleTargetedEditCount: staleCount,
            ...(staleFilePath ? { filePath: staleFilePath } : {}),
          }),
        });
        toolContent = formatToolResultContent(toolName, result);
        if (filesWritten.size > 0 && staleCount >= 3) {
          shouldCompleteAfterBoundaryTool = true;
          boundaryHandoffText = [
            "Coding changes were partially written, but repeated stale targeted edits on the same file indicate the Coding Agent is stuck on edit mechanics.",
            "Stop Coding here. The next role should read the current workspace, verify all user-requested source/test/config files exist, create any missing test files, and run validation/repair from current evidence.",
          ].join(" ");
          appendTelemetryEvent(workspacePath, {
            kind: "blocked_tool",
            toolName,
            capability: "staleTargetedEditStall",
          });
        }
      }
      if (isProductiveToolResult({
        role: opts.config.activeSubagentRole,
        toolName,
        success: result.success,
        params: call.params,
        content: result.success ? result.content : toolContent,
        observedEvidenceKeys,
        ...(result.meta ? { meta: result.meta } : {}),
      })) {
        roundMadeProductiveProgress = true;
      }
      opts.historyManager.appendToolEvidence({
        call: Object.freeze({
          name: toolName,
          params: call.params,
        }),
        result,
        toolCallId: toolCall.id,
      });
      try {
        const activeTurn = opts.historyManager.getWorkingTurn();
        if (activeTurn) {
          const turnId = activeTurn.turnId;
          const workspaceId = opts.historyManager.getWorkspaceId();
          if (
            result.success &&
            [
              "write_file",
              "insert_file_at_line",
              "edit_file",
              "edit_file_range",
              "multi_edit_file_ranges",
            ].includes(toolName)
          ) {
            const editPath =
              typeof result.meta?.filePath === "string"
                ? result.meta.filePath
                : typeof call.params["path"] === "string"
                  ? String(call.params["path"])
                  : "";
            if (editPath) {
              const beforeContent = getOriginalContent(editPath) ?? "";
              let afterContent = "";
              try {
                const fsModule = await import("node:fs");
                afterContent = fsModule.existsSync(editPath)
                  ? fsModule.readFileSync(editPath, "utf-8")
                  : "";
              } catch {
                afterContent = "";
              }
              const meta = (result.meta ?? {}) as Readonly<
                Record<string, unknown>
              >;
              const ranges = Array.isArray(meta.changedLineRanges)
                ? meta.changedLineRanges
                : [];
              const firstRange =
                ranges.length > 0
                  ? (ranges[0] as Readonly<{
                      startLine?: number;
                      endLine?: number;
                    }>)
                  : null;
              recordCodeEdit(workspacePath, {
                workspaceId,
                turnId,
                toolName,
                filePath: editPath,
                rangeStartLine: firstRange?.startLine ?? null,
                rangeEndLine: firstRange?.endLine ?? null,
                beforeContent,
                afterContent,
              });
            }
          }
          if (result.success && toolName === "read_file") {
            const meta = (result.meta ?? {}) as Readonly<
              Record<string, unknown>
            >;
            const targetPath =
              typeof meta.filePath === "string"
                ? meta.filePath
                : typeof call.params["path"] === "string"
                  ? String(call.params["path"])
                  : "";
            if (targetPath) {
              let mtimeMs = 0;
              let sizeBytes = 0;
              try {
                const fsModule = await import("node:fs");
                if (fsModule.existsSync(targetPath)) {
                  const stat = fsModule.statSync(targetPath);
                  mtimeMs = stat.mtimeMs;
                  sizeBytes = stat.size;
                }
              } catch {
                /* ignore */
              }
              recordFileRead(workspacePath, {
                workspaceId,
                turnId,
                filePath: targetPath,
                readMode:
                  typeof meta.readMode === "string"
                    ? String(meta.readMode)
                    : "file_lines",
                offset: Number(
                  call.params["offset"] ?? meta.requestedOffset ?? 0,
                ),
                limit: Number(
                  call.params["maxLines"] ?? meta.requestedMaxLines ?? 0,
                ),
                mtimeMs,
                sizeBytes,
                cached: meta.cacheHit === true,
              });
            }
          }
        }
      } catch {
        /* never break the chat loop on ledger errors */
      }
      const touchedPath =
        typeof result.meta?.filePath === "string"
          ? result.meta.filePath
          : typeof result.meta?.targetPath === "string"
            ? result.meta.targetPath
            : null;
      if (
        result.success &&
        touchedPath &&
        ([
          "write_file",
          "create_drawio_diagram",
          "export_workflow_drawio_diagram",
          "export_workflow_mermaid_diagram",
          "insert_file_at_line",
          "edit_file",
          "edit_file_range",
          "multi_edit_file_ranges",
        ].includes(toolName) ||
          ["galaxy_design_init", "galaxy_design_add"].includes(toolName))
      ) {
        filesWritten.add(touchedPath);
      }
      const workflowRefreshPaths = new Set<string>();
      if (
        result.success &&
        touchedPath &&
        ([
          "write_file",
          "create_drawio_diagram",
          "export_workflow_drawio_diagram",
          "export_workflow_mermaid_diagram",
          "insert_file_at_line",
          "edit_file",
          "edit_file_range",
          "multi_edit_file_ranges",
          "revert_file",
        ].includes(toolName) ||
          ["galaxy_design_init", "galaxy_design_add"].includes(toolName))
      ) {
        workflowRefreshPaths.add(touchedPath);
      }
      if (result.success && workspaceSnapshotBefore) {
        for (const changedPath of trackWorkspaceChanges(
          workspacePath,
          workspaceSnapshotBefore,
        )) {
          filesWritten.add(changedPath);
          workflowRefreshPaths.add(changedPath);
        }
      }
      if (result.success && workflowRefreshPaths.size > 0) {
        const workflowRefreshWorkspacePath = resolveEffectiveProjectPath({
          workspacePath,
          activeProjectPath:
            opts.historyManager.getSessionMemory().activeProjectPath,
          candidateFilePaths: [...workflowRefreshPaths],
        });
        const scopedWorkflowRefreshPaths = mapPathsToProjectScope(
          workspacePath,
          workflowRefreshWorkspacePath,
          [...workflowRefreshPaths],
        );
        scheduleWorkflowGraphRefresh(workflowRefreshWorkspacePath, {
          reason: `tool:${toolName}`,
          filePaths: scopedWorkflowRefreshPaths,
        });
        for (const scopedPath of scopedWorkflowRefreshPaths) {
          noteFileTouchedForGraph(workflowRefreshWorkspacePath, scopedPath, {
            force: true,
          });
        }
      }
      if (
        result.success &&
        touchedPath &&
        [
          "read_file",
          "head",
          "tail",
          "grep",
          "read_document",
          "validate_code",
          "diff_file",
        ].includes(toolName)
      ) {
        const readWorkspacePath = resolveEffectiveProjectPath({
          workspacePath,
          activeProjectPath:
            opts.historyManager.getSessionMemory().activeProjectPath,
          candidateFilePaths: [touchedPath],
        });
        const [scopedReadPath] = mapPathsToProjectScope(
          workspacePath,
          readWorkspacePath,
          [touchedPath],
        );
        if (scopedReadPath) {
          noteFileTouchedForGraph(readWorkspacePath, scopedReadPath);
        }
      }
      const toolMessage: ChatMessage = Object.freeze({
        id: createMessageId(),
        role: "tool",
        content: toolContent,
        timestamp: Date.now(),
        toolName,
        toolParams: Object.freeze(call.params),
        toolMeta: Object.freeze({
          ...(result.meta ?? {}),
          agentRole: runtimeMetadata.agentRole,
          agentModel: runtimeMetadata.agentModel,
          phase: runtimeMetadata.phase,
        }),
        toolSuccess: result.success,
        toolCallId: toolCall.id,
      });

      opts.historyManager.appendToolMessage(toolMessage);
      await opts.onMessage(toolMessage);
    }

    const readOnlyEvidenceThreshold = getReadOnlyEvidenceHandoffThreshold(opts.config.activeSubagentRole);
    if (
      !shouldCompleteAfterBoundaryTool &&
      readOnlyEvidenceThreshold !== null &&
      filesWritten.size === 0 &&
      observedEvidenceKeys.size >= readOnlyEvidenceThreshold &&
      !normalizedToolNamesThisRound.includes("write_agent_handoff")
    ) {
      shouldCompleteAfterBoundaryTool = true;
      boundaryHandoffText = [
        `${opts.config.activeSubagentRole} role collected ${observedEvidenceKeys.size} distinct evidence item(s) without emitting an explicit handoff.`,
        "Stop this read-only role here and continue with the next subagent using the collected transcript evidence. Implementation, validation, and review work remain delegated to their own roles.",
      ].join(" ");
      appendTelemetryEvent(workspacePath, {
        kind: "blocked_tool",
        toolName: normalizedToolNamesThisRound.join(",") || "read_only_evidence",
        capability: "readOnlyEvidenceHandoffFallback",
      });
    }

    opts.historyManager.incrementRound();
    const roundOnlyUnavailableToolCalls =
      pendingToolCalls.length > 0 &&
      roundBlockedUnavailableTool &&
      !roundExecutedKnownTools;
    consecutiveUnavailableToolOnlyRounds = roundOnlyUnavailableToolCalls
      ? consecutiveUnavailableToolOnlyRounds + 1
      : 0;
    if (
      !shouldCompleteAfterBoundaryTool &&
      opts.config.activeSubagentRole === "coding" &&
      filesWritten.size > 0 &&
      consecutiveUnavailableToolOnlyRounds >= 2
    ) {
      shouldCompleteAfterBoundaryTool = true;
      boundaryHandoffText = "Coding changes were written, but the model repeatedly requested unavailable tools outside the Coding Agent schema. Stop Coding here and delegate validation, review, or environment execution to the next role that owns that capability.";
      appendTelemetryEvent(workspacePath, {
        kind: "blocked_tool",
        toolName: normalizedToolNamesThisRound.join(",") || "unavailable_tool",
        capability: "roleBoundaryStall",
      });
    }
    if (shouldCompleteAfterBoundaryTool) {
      return Object.freeze({
        assistantText: boundaryHandoffText,
        assistantThinking: "",
        filesWritten: Object.freeze([...filesWritten]),
      });
    }
    consecutiveNonProductiveRounds = roundMadeProductiveProgress
      ? 0
      : consecutiveNonProductiveRounds + 1;
    if (
      maxToolRounds !== null &&
      round + 1 >= maxToolRounds
    ) {
      const canRecoverFromStall =
        consecutiveNonProductiveRounds < toolRoundStallLimit &&
        roundExecutedKnownTools;
      if (roundMadeProductiveProgress || canRecoverFromStall) {
        const extensionStep = roundMadeProductiveProgress
          ? toolRoundExtensionStep
          : Math.max(2, Math.floor(toolRoundExtensionStep / 2));
        maxToolRounds += extensionStep;
      }
    }
  }

  return Object.freeze({
    assistantText: "",
    assistantThinking: "",
    errorMessage: `Agent exceeded the adaptive tool budget (${maxToolRounds ?? "unlimited"}) after ${consecutiveNonProductiveRounds} non-productive round(s).`,
    filesWritten: Object.freeze([...filesWritten]),
  });
}
