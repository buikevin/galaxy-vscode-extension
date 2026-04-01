/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared extension-host utility helpers for labels, ids, webview sanitization, and debug logging.
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import type { AgentType, ChatMessage } from "../shared/protocol";
import type { ChangedFileSummary as ChangedFileSummaryPayload } from "../shared/protocol";
import {
  AGENT_TYPES,
  MAX_DEBUG_BLOCK_CHARS,
  MAX_WEBVIEW_META_ARRAY_ITEMS,
  MAX_WEBVIEW_PARAM_STRING_CHARS,
  MAX_WEBVIEW_TOOL_CONTENT_CHARS,
} from "../shared/constants";

/** Normalize one display path to POSIX separators for UI rendering. */
export function normalizeRelativeDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Return the parent-path description for a relative path label. */
export function getRelativePathDescription(
  relativePath: string,
): string | undefined {
  const normalized = normalizeRelativeDisplayPath(relativePath);
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return undefined;
  }

  return normalized.slice(0, separatorIndex);
}

/** Build one short changed-file description for tree rendering. */
export function getChangedFileDescription(
  file: ChangedFileSummaryPayload,
): string {
  const parts = [
    getRelativePathDescription(file.label),
    file.wasNew ? "new" : undefined,
    `+${file.addedLines} -${file.deletedLines}`,
  ].filter((value): value is string => Boolean(value));

  return parts.join(" · ");
}

/** Append one debug line into the workspace debug log if possible. */
export function writeDebugLine(
  filePath: string,
  scope: string,
  message: string,
): void {
  try {
    const timestamp = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(
      filePath,
      `[${timestamp}] [${scope}] ${message}\n`,
      "utf-8",
    );
  } catch {
    // ignore debug logging failures
  }
}

/** Truncate one long webview string field to the configured limit. */
export function truncateWebviewText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n\n...[truncated ${value.length - maxChars} chars]`;
}

/** Recursively sanitize metadata before posting a message to the webview. */
export function sanitizeWebviewValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncateWebviewText(value, MAX_WEBVIEW_PARAM_STRING_CHARS);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_WEBVIEW_META_ARRAY_ITEMS)
      .map((item) => sanitizeWebviewValue(item, depth + 1));
    if (value.length > MAX_WEBVIEW_META_ARRAY_ITEMS) {
      items.push(
        `[...${value.length - MAX_WEBVIEW_META_ARRAY_ITEMS} more items]`,
      );
    }
    return items;
  }
  if (typeof value === "object") {
    if (depth >= 2) {
      return "[object truncated]";
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      32,
    );
    return Object.fromEntries(
      entries.map(([key, nested]) => [
        key,
        sanitizeWebviewValue(nested, depth + 1),
      ]),
    );
  }
  return String(value);
}

/** Remove oversized tool payloads before mirroring one transcript message to the webview. */
export function sanitizeChatMessageForWebview(
  message: ChatMessage,
): ChatMessage {
  if (message.role !== "tool") {
    return message;
  }

  return Object.freeze({
    ...message,
    content: truncateWebviewText(
      message.content,
      MAX_WEBVIEW_TOOL_CONTENT_CHARS,
    ),
    ...(message.toolParams
      ? {
          toolParams: sanitizeWebviewValue(message.toolParams) as Record<
            string,
            unknown
          >,
        }
      : {}),
    ...(message.toolMeta
      ? {
          toolMeta: sanitizeWebviewValue(message.toolMeta) as Record<
            string,
            unknown
          >,
        }
      : {}),
  });
}

/** Type guard for supported runtime agent identifiers. */
export function isAgentType(value: string | undefined): value is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(value ?? "");
}

/** Return one user-facing label for the selected runtime agent. */
export function getAgentLabel(agentType: AgentType): string {
  switch (agentType) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "ollama":
      return "Ollama";
    case "manual":
      return "Manual";
  }
}

/** Create one CSP nonce used by host-generated webviews. */
export function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";

  for (let index = 0; index < 32; index += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

/** Create one stable-enough UI message id for transcript and approval events. */
export function createMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a plain assistant message object with current timestamp. */
export function createAssistantMessage(content: string): ChatMessage {
  return {
    id: createMessageId(),
    role: "assistant",
    content,
    timestamp: Date.now(),
  };
}

/** Open the Galaxy config directory in the OS file manager. */
export async function openGalaxyConfigDir(configDir: string): Promise<void> {
  const configUri = vscode.Uri.file(configDir);
  await vscode.workspace.fs.createDirectory(configUri);
  await vscode.env.openExternal(configUri);
}
