/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Pure parsing and formatting helpers used by the Galaxy Code webview transcript.
 */

import type { ChatMessage } from "@shared/protocol";
import type { ListDirEntry } from "@webview/entities/chat";

/**
 * Normalize a relative path so the UI always works with forward slashes and no leading `./`.
 *
 * @param pathValue Raw path value emitted by a tool or typed by the user.
 * @returns Normalized relative path used for display and path joins.
 */
export function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/^\.\/+/, "").replace(/\\/g, "/");
}

/**
 * Join a base relative path with a child segment while preserving normalized separators.
 *
 * @param basePath Parent relative directory path.
 * @param childName Child file or folder name.
 * @returns Joined relative path suitable for UI rendering.
 */
export function joinRelativePath(basePath: string, childName: string): string {
  const normalizedBase = normalizeRelativePath(basePath.trim());
  return normalizedBase ? `${normalizedBase}/${childName}` : childName;
}

/**
 * Parse a `list_dir` tool message into structured entries that can be rendered in the UI.
 *
 * @param message Tool message returned by the host.
 * @returns Flattened directory entries with inferred depth/path metadata.
 */
export function buildListDirEntries(message: ChatMessage): ListDirEntry[] {
  if (message.toolName !== "list_dir" || !message.content.trim()) {
    return [];
  }

  const basePath =
    typeof message.toolParams?.path === "string" ? message.toolParams.path : "";
  const lines = message.content.split("\n").filter((line) => line.trim());
  const segmentStack: string[] = [];
  const entries: ListDirEntry[] = [];

  lines.forEach((line, index) => {
    const leadingSpaces = line.match(/^\s*/)?.[0].length ?? 0;
    const depth = Math.floor(leadingSpaces / 2);
    const trimmed = line.trim();
    const isDir = trimmed.endsWith("/");
    const label = isDir ? trimmed.slice(0, -1) : trimmed;

    segmentStack.length = depth;
    segmentStack[depth] = label;

    const relativePath = joinRelativePath(basePath, segmentStack.join("/"));
    entries.push({
      key: `${message.id}-${index}-${relativePath}`,
      label,
      filePath: relativePath,
      isDir,
      depth,
    });
  });

  return entries;
}

/**
 * Extract the main file/document path from a tool message.
 *
 * @param message Tool message returned by the host.
 * @returns Path string or an empty string when the tool has no path payload.
 */
export function getToolPath(message: ChatMessage): string {
  return typeof message.toolParams?.path === "string" ? message.toolParams.path : "";
}

/**
 * Read a string value from `toolMeta` safely.
 *
 * @param message Tool message that may contain `toolMeta`.
 * @param key Metadata key to read.
 * @returns String value or an empty string when absent.
 */
export function getToolMetaString(message: ChatMessage, key: string): string {
  const value = message.toolMeta?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Read a finite numeric value from `toolMeta` safely.
 *
 * @param message Tool message that may contain `toolMeta`.
 * @param key Metadata key to read.
 * @returns Finite number or `null` when absent or invalid.
 */
export function getToolMetaNumber(
  message: ChatMessage,
  key: string
): number | null {
  const value = message.toolMeta?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Convert command duration in milliseconds into a short human-readable label.
 *
 * @param durationMs Duration in milliseconds.
 * @returns Compact duration label used by shell cards.
 */
export function formatCommandDuration(durationMs: number | null): string {
  if (durationMs === null || durationMs < 0) {
    return "";
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

/**
 * Shorten long relative paths while keeping the tail segments visible.
 *
 * @param pathValue Raw or normalized path value.
 * @param maxLength Maximum display length before truncation.
 * @returns Shortened display path.
 */
export function shortenPath(pathValue: string, maxLength = 24): string {
  const normalized = normalizeRelativePath(pathValue);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return `...${normalized.slice(-(maxLength - 3))}`;
  }

  let suffix = segments[segments.length - 1] ?? normalized;
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const candidate = `${segments[index]}/${suffix}`;
    if (candidate.length + 4 > maxLength) {
      break;
    }
    suffix = candidate;
  }

  return `.../${suffix}`;
}
