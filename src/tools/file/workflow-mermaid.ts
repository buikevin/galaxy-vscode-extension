/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-21
 * @modify date 2026-04-21
 * @desc Helpers for exporting workflow graph views to Mermaid files inside the workspace.
 */

import path from "node:path";
import { exportViewGraphToMermaid } from "../../context/workflow/view/mermaid";
import {
  describeEnsureGraphFallbackHint,
  ensureGraphForScope,
} from "../../context/workflow/extractor/ensure-graph-for-scope";
import {
  describeWorkflowViewScope,
  resolveWorkflowViewGraphModel,
} from "../../context/workflow/view/resolver";
import type { ToolResult } from "../entities/file-tools";
import { writeFileTool } from "./edit";

const MERMAID_MARKDOWN_EXTENSIONS = Object.freeze([".md", ".mdx", ".markdown"]);
const MERMAID_TEXT_EXTENSIONS = Object.freeze([".mmd", ".mermaid"]);

type WorkflowMermaidOutputMode = "markdown" | "raw";

function normalizeRequestedFormat(rawFormat?: string): string {
  return String(rawFormat ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
}

function isMarkdownExtension(extension: string): boolean {
  return MERMAID_MARKDOWN_EXTENSIONS.includes(extension.toLowerCase());
}

function isRawMermaidExtension(extension: string): boolean {
  return MERMAID_TEXT_EXTENSIONS.includes(extension.toLowerCase());
}

export function normalizeWorkflowMermaidDiagramPath(
  rawPath: string,
  format?: string,
): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) {
    throw new Error(
      "export_workflow_mermaid_diagram requires a non-empty output path.",
    );
  }

  const extension = path.extname(trimmed).toLowerCase();
  if (
    extension &&
    (isMarkdownExtension(extension) || isRawMermaidExtension(extension))
  ) {
    return trimmed;
  }

  const normalizedFormat = normalizeRequestedFormat(format);
  if (
    normalizedFormat === "mmd" ||
    normalizedFormat === "mermaid" ||
    normalizedFormat === "raw"
  ) {
    return `${trimmed}.mmd`;
  }
  if (
    normalizedFormat === "md" ||
    normalizedFormat === "markdown" ||
    normalizedFormat === ""
  ) {
    return `${trimmed}.md`;
  }

  throw new Error(
    `Unsupported Mermaid output format: ${format}. Use markdown, md, mmd, mermaid, or raw.`,
  );
}

function resolveWorkflowMermaidOutputMode(
  normalizedPath: string,
  format?: string,
): WorkflowMermaidOutputMode {
  const extension = path.extname(normalizedPath).toLowerCase();
  if (isMarkdownExtension(extension)) {
    return "markdown";
  }
  if (isRawMermaidExtension(extension)) {
    return "raw";
  }

  const normalizedFormat = normalizeRequestedFormat(format);
  if (
    normalizedFormat === "mmd" ||
    normalizedFormat === "mermaid" ||
    normalizedFormat === "raw"
  ) {
    return "raw";
  }
  return "markdown";
}

function buildMarkdownMermaidDocument(
  title: string,
  summary: string,
  mermaidText: string,
  focusPaths: readonly string[],
): string {
  const lines = [`# ${title}`, "", summary.trim(), ""];
  if (focusPaths.length > 0) {
    lines.push("## Focus Paths", "");
    for (const focusPath of focusPaths) {
      lines.push(`- ${focusPath}`);
    }
    lines.push("");
  }
  lines.push("```mermaid", mermaidText.trimEnd(), "```", "");
  return lines.join("\n");
}

export async function createWorkflowMermaidDiagramTool(
  workspaceRoot: string,
  rawPath: string,
  options?: Readonly<{
    format?: string;
    title?: string;
    entryNodeId?: string;
    routePath?: string;
    filePath?: string;
    query?: string;
    maxHops?: number;
    maxNodes?: number;
    includeIncoming?: boolean;
    includeExternal?: boolean;
  }>,
): Promise<ToolResult> {
  try {
    const normalizedPath = normalizeWorkflowMermaidDiagramPath(
      rawPath,
      options?.format,
    );
    const outputMode = resolveWorkflowMermaidOutputMode(
      normalizedPath,
      options?.format,
    );
    // Phase 4 fallback: prime the graph for the requested scope before resolving so cold
    // workspaces / unread features still get a useful diagram instead of a hard error.
    const scopeInput = {
      ...(options?.entryNodeId ? { entryNodeId: options.entryNodeId } : {}),
      ...(options?.routePath ? { routePath: options.routePath } : {}),
      ...(options?.filePath ? { filePath: options.filePath } : {}),
      ...(options?.query ? { query: options.query } : {}),
    } as const;
    const ensureResult = await ensureGraphForScope(workspaceRoot, scopeInput);
    if (!ensureResult.graphHasMatchingNodes) {
      return Object.freeze({
        success: false,
        content: "",
        error: describeEnsureGraphFallbackHint(scopeInput, ensureResult),
      });
    }
    const { scope, model } = resolveWorkflowViewGraphModel(workspaceRoot, {
      ...(options?.entryNodeId ? { entryNodeId: options.entryNodeId } : {}),
      ...(options?.routePath ? { routePath: options.routePath } : {}),
      ...(options?.filePath ? { filePath: options.filePath } : {}),
      ...(options?.query ? { query: options.query } : {}),
      ...(typeof options?.maxHops === "number"
        ? { maxHops: options.maxHops }
        : {}),
      ...(typeof options?.maxNodes === "number"
        ? { maxNodes: options.maxNodes }
        : {}),
      ...(typeof options?.includeIncoming === "boolean"
        ? { includeIncoming: options.includeIncoming }
        : {}),
      ...(typeof options?.includeExternal === "boolean"
        ? { includeExternal: options.includeExternal }
        : {}),
    });

    const mermaidText = exportViewGraphToMermaid(model);
    const finalTitle = String(options?.title ?? "").trim() || model.graphTitle;
    const content =
      outputMode === "markdown"
        ? buildMarkdownMermaidDocument(
            finalTitle,
            model.graphSummary,
            mermaidText,
            model.focusPaths,
          )
        : mermaidText;
    const writeResult = writeFileTool(workspaceRoot, normalizedPath, content);
    if (!writeResult.success) {
      return writeResult;
    }

    return Object.freeze({
      success: true,
      content: `Exported Mermaid workflow diagram to ${normalizedPath} from ${describeWorkflowViewScope(scope)}.`,
      meta: Object.freeze({
        ...writeResult.meta,
        filePath: writeResult.meta?.filePath,
        operation: "export_workflow_mermaid_diagram",
        format: outputMode,
        scopeKind: model.scopeKind,
        scopeValue: model.scopeValue,
        entryNodeId: model.entryNodeId,
        graphTitle: finalTitle,
        graphSummary: model.graphSummary,
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
