/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-09
 * @modify date 2026-04-09
 * @desc Helpers for creating Draw.io-compatible diagram files inside the workspace.
 */

import path from "node:path";
import type { ToolResult } from "../entities/file-tools";
import { writeFileTool } from "./edit";
import { resolveWorkspacePath } from "./path-read";

const DRAWIO_TEXT_EXTENSIONS = Object.freeze([".drawio", ".dio"]);
const DRAWIO_EDITABLE_EXTENSIONS = Object.freeze([
  ".drawio",
  ".dio",
  ".drawio.svg",
  ".drawio.png",
  ".dio.svg",
  ".dio.png",
]);

export type DrawioNativeAction = "convert" | "export";

export type DrawioNativeCommand = Readonly<{
  commandId: string;
  title: string;
  extensionId: string;
}>;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function normalizeDrawioDiagramPath(
  rawPath: string,
  format?: string,
): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) {
    throw new Error("create_drawio_diagram requires a non-empty path.");
  }

  const lowered = trimmed.toLowerCase();
  if (lowered.endsWith(".drawio.svg") || lowered.endsWith(".drawio.png")) {
    throw new Error(
      "create_drawio_diagram currently supports only .drawio or .dio files.",
    );
  }
  if (DRAWIO_TEXT_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
    return trimmed;
  }

  const normalizedFormat = String(format ?? "drawio")
    .trim()
    .toLowerCase();
  if (normalizedFormat === "dio") {
    return `${trimmed}.dio`;
  }
  if (normalizedFormat === "drawio" || normalizedFormat === "") {
    return `${trimmed}.drawio`;
  }

  throw new Error(
    `Unsupported draw.io format: ${format}. Use "drawio" or "dio".`,
  );
}

export function normalizeEditableDrawioPath(rawPath: string): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) {
    throw new Error("Draw.io actions require a non-empty path.");
  }

  const lowered = trimmed.toLowerCase();
  if (
    DRAWIO_EDITABLE_EXTENSIONS.some((extension) => lowered.endsWith(extension))
  ) {
    return trimmed;
  }

  return `${trimmed}.drawio`;
}

export function normalizeDrawioTargetFormat(
  rawFormat: string,
  action: DrawioNativeAction,
): string {
  const normalized = String(rawFormat ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!normalized) {
    throw new Error(
      `${action}_drawio_diagram requires a target format such as svg or png.`,
    );
  }

  if (action === "convert") {
    if (
      normalized === "drawio.svg" ||
      normalized === "dio.svg" ||
      normalized === "svg"
    ) {
      return ".drawio.svg";
    }
    if (
      normalized === "drawio.png" ||
      normalized === "dio.png" ||
      normalized === "png"
    ) {
      return ".drawio.png";
    }
    if (normalized === "drawio" || normalized === "dio") {
      return ".drawio";
    }
    throw new Error(
      `Unsupported Draw.io convert format: ${rawFormat}. Use drawio.svg, drawio.png, or drawio.`,
    );
  }

  if (
    normalized === "drawio.svg" ||
    normalized === "dio.svg" ||
    normalized === "svg"
  ) {
    return ".svg";
  }
  if (
    normalized === "drawio.png" ||
    normalized === "dio.png" ||
    normalized === "png"
  ) {
    return ".png";
  }
  if (normalized === "drawio" || normalized === "dio") {
    return ".drawio";
  }
  throw new Error(
    `Unsupported Draw.io export format: ${rawFormat}. Use svg, png, or drawio.`,
  );
}

export function getDrawioNativeCommand(
  providerId: string,
  action: DrawioNativeAction,
): DrawioNativeCommand | null {
  const normalizedProviderId = String(providerId ?? "")
    .trim()
    .toLowerCase();
  if (
    normalizedProviderId === "hediet.vscode-drawio" ||
    normalizedProviderId === "hediet.vscode-drawio-text"
  ) {
    return Object.freeze({
      commandId:
        action === "convert"
          ? "hediet.vscode-drawio.convert"
          : "hediet.vscode-drawio.export",
      title:
        action === "convert"
          ? "Draw.io: Convert To..."
          : "Draw.io: Export To...",
      extensionId: "hediet.vscode-drawio",
    });
  }
  return null;
}

export function buildDrawioActionGuidance(
  action: DrawioNativeAction,
  targetFormat: string,
): string {
  if (action === "convert") {
    return `Triggered Draw.io Convert To... Finish the Draw.io quick pick and save dialog by choosing ${targetFormat}. This flow is native to the Draw.io extension, so Galaxy cannot complete the final selection for you.`;
  }
  return `Triggered Draw.io Export To... Finish the Draw.io export dialog by choosing ${targetFormat}. The Draw.io extension owns the final export properties and save destination UI.`;
}

export function buildBlankDrawioXml(title?: string): string {
  const diagramTitle = (title?.trim() || "Page-1").slice(0, 80);
  const nowIso = new Date().toISOString();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<mxfile host="app.diagrams.net" modified="${escapeXml(nowIso)}" agent="Galaxy Code" version="26.0.11">`,
    `  <diagram id="galaxy-diagram-1" name="${escapeXml(diagramTitle)}">`,
    '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">',
    "      <root>",
    '        <mxCell id="0" />',
    '        <mxCell id="1" parent="0" />',
    "      </root>",
    "    </mxGraphModel>",
    "  </diagram>",
    "</mxfile>",
    "",
  ].join("\n");
}

export function createDrawioDiagramTool(
  workspaceRoot: string,
  rawPath: string,
  options?: Readonly<{
    format?: string;
    title?: string;
  }>,
): ToolResult {
  try {
    const normalizedPath = normalizeDrawioDiagramPath(rawPath, options?.format);
    const resolved = resolveWorkspacePath(workspaceRoot, normalizedPath);
    const knownExtension =
      DRAWIO_TEXT_EXTENSIONS.find((extension) =>
        resolved.endsWith(extension),
      ) ?? path.extname(resolved);
    const fallbackTitle = path.basename(resolved, knownExtension);
    return writeFileTool(
      workspaceRoot,
      normalizedPath,
      buildBlankDrawioXml(options?.title ?? fallbackTitle),
    );
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: String(error),
    });
  }
}
