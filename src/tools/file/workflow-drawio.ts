/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-21
 * @modify date 2026-04-21
 * @desc Helpers for exporting workflow graph views to editable Draw.io files inside the workspace.
 */

import path from "node:path";
import { exportViewGraphToDrawioXml } from "../../context/workflow/view/drawio";
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

const DRAWIO_TEXT_EXTENSIONS = Object.freeze([".drawio", ".dio"]);

function normalizeRequestedFormat(rawFormat?: string): string {
  return String(rawFormat ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
}

export function normalizeWorkflowDrawioDiagramPath(
  rawPath: string,
  format?: string,
): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) {
    throw new Error(
      "export_workflow_drawio_diagram requires a non-empty output path.",
    );
  }

  const extension = path.extname(trimmed).toLowerCase();
  if (DRAWIO_TEXT_EXTENSIONS.includes(extension)) {
    return trimmed;
  }

  const normalizedFormat = normalizeRequestedFormat(format);
  if (normalizedFormat === "dio") {
    return `${trimmed}.dio`;
  }
  if (normalizedFormat === "drawio" || normalizedFormat === "") {
    return `${trimmed}.drawio`;
  }

  throw new Error(
    `Unsupported workflow Draw.io output format: ${format}. Use drawio or dio.`,
  );
}

export async function createWorkflowDrawioDiagramTool(
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
    const normalizedPath = normalizeWorkflowDrawioDiagramPath(
      rawPath,
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

    const finalModel =
      options?.title && options.title.trim().length > 0
        ? Object.freeze({
            ...model,
            graphTitle: options.title.trim(),
          })
        : model;
    const content = exportViewGraphToDrawioXml(finalModel);
    const writeResult = writeFileTool(workspaceRoot, normalizedPath, content);
    if (!writeResult.success) {
      return writeResult;
    }

    return Object.freeze({
      success: true,
      content: `Exported workflow Draw.io diagram to ${normalizedPath} from ${describeWorkflowViewScope(scope)}.`,
      meta: Object.freeze({
        ...writeResult.meta,
        filePath: writeResult.meta?.filePath,
        operation: "export_workflow_drawio_diagram",
        format: path.extname(normalizedPath).replace(/^\./, "") || "drawio",
        scopeKind: finalModel.scopeKind,
        scopeValue: finalModel.scopeValue,
        entryNodeId: finalModel.entryNodeId,
        graphTitle: finalModel.graphTitle,
        graphSummary: finalModel.graphSummary,
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
