/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Helper functions for extension history management, working-turn compaction, and memory persistence.
 */

import type { ChatMessage } from "../../shared/protocol";
import type {
  ActiveTaskMemory,
  ProjectMemory,
  ReadPlanProgressItem,
  ToolDigest,
  TurnDigest,
  WorkingTurn,
} from "../entities/history";
import { estimateTokens } from "../compaction";
import {
  ACTIVE_TASK_MEMORY_SOFT_LIMIT,
  PROJECT_MEMORY_SOFT_LIMIT,
} from "../entities/constants";
import {
  estimateActiveTaskMemoryTokens,
  estimateProjectMemoryTokens,
  normalizeActiveTaskMemory,
  normalizeProjectMemory,
} from "../memory-format";

/**
 * Produces a compact single-line summary suitable for memory fields.
 *
 * @param text Source text to summarize.
 * @param maxChars Maximum number of characters to keep.
 * @returns Single-line summary string.
 */
export function summarizeText(text: string, maxChars = 400): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}...`
    : normalized;
}

/**
 * Reads a string-valued tool parameter from a chat message.
 *
 * @param message Tool or assistant message carrying tool params.
 * @param key Parameter name to read.
 * @returns String parameter value, or an empty string when missing.
 */
export function getStringParam(message: ChatMessage, key: string): string {
  const params = message.toolParams as Record<string, unknown> | undefined;
  const value = params?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Merges two ordered string lists while preserving uniqueness and recency.
 *
 * @param existing Existing ordered values.
 * @param incoming New values to append.
 * @param maxItems Maximum number of merged entries to keep.
 * @returns Frozen merged list with duplicate values removed.
 */
export function mergeUniqueItems(
  existing: readonly string[],
  incoming: readonly string[],
  maxItems: number,
): readonly string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...existing, ...incoming]) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    merged.push(trimmed);
  }

  return Object.freeze(merged.slice(-maxItems));
}

/**
 * Converts one tool message into a durable digest for history memory.
 *
 * @param message Tool message captured during the working turn.
 * @returns Compact digest stored alongside the turn.
 */
export function createToolDigest(message: ChatMessage): ToolDigest {
  const toolName = message.toolName ?? "unknown_tool";
  const pathParam = getStringParam(message, "path");
  const patternParam = getStringParam(message, "pattern");
  const success = message.toolSuccess ?? false;

  const filesRead =
    ["read_file", "head", "tail", "read_document", "validate_code"].includes(
      toolName,
    ) && pathParam
      ? Object.freeze([pathParam])
      : ["galaxy_design_project_info", "galaxy_design_registry"].includes(
            toolName,
          ) && pathParam
        ? Object.freeze([pathParam])
        : toolName === "grep" && pathParam
          ? Object.freeze([pathParam])
          : toolName === "list_dir" && pathParam
            ? Object.freeze([pathParam])
            : Object.freeze([]);
  const filesWritten =
    success &&
    [
      "write_file",
      "create_drawio_diagram",
      "edit_file",
      "edit_file_range",
      "multi_edit_file_ranges",
      "galaxy_design_init",
      "galaxy_design_add",
    ].includes(toolName) &&
    pathParam
      ? Object.freeze([pathParam])
      : Object.freeze([]);
  const filesReverted = Object.freeze([]);

  const summaryByTool: Record<string, string> = {
    read_file: `Read ${pathParam || "file"}`,
    read_document: `Read document ${pathParam || ""}`.trim(),
    search_web: `Searched web for ${getStringParam(message, "query") || "query"}`,
    extract_web: "Extracted web content from URLs",
    map_web: `Mapped website ${getStringParam(message, "url") || ""}`.trim(),
    crawl_web: `Crawled website ${getStringParam(message, "url") || ""}`.trim(),
    head: `Read file head ${pathParam || ""}`.trim(),
    tail: `Read file tail ${pathParam || ""}`.trim(),
    grep: `Searched ${pathParam || "."} for ${patternParam || "pattern"}`,
    list_dir: `Listed directory ${pathParam || "."}`,
    write_file: `Wrote ${pathParam || "file"}`,
    create_drawio_diagram: `Created Draw.io diagram ${pathParam || "file"}`,
    convert_drawio_diagram: `Triggered Draw.io convert for ${pathParam || "diagram"}`,
    export_drawio_diagram: `Triggered Draw.io export for ${pathParam || "diagram"}`,
    edit_file: `Edited ${pathParam || "file"}`,
    edit_file_range: `Edited ${pathParam || "file"} by line range`,
    multi_edit_file_ranges: `Edited ${pathParam || "file"} with multiple line ranges`,
    validate_code: `${success ? "Validated" : "Validation failed for"} ${pathParam || "file"}`,
    run_project_command:
      `Ran project command ${getStringParam(message, "command") || getStringParam(message, "commandId") || ""}`.trim(),
    galaxy_design_project_info: `Inspected Galaxy Design project ${pathParam || "."}`,
    galaxy_design_registry:
      `Inspected Galaxy Design registry ${getStringParam(message, "component") || getStringParam(message, "group") || getStringParam(message, "query") || getStringParam(message, "framework") || ""}`.trim(),
    galaxy_design_init: `Initialized Galaxy Design in ${pathParam || "."}`,
    galaxy_design_add: "Added Galaxy Design components",
    request_code_review: success ? "Ran code review" : "Code review failed",
    vscode_start_frontend_preview: success
      ? "Started frontend preview"
      : "Frontend preview failed",
  };

  return Object.freeze({
    name: toolName,
    success,
    summary:
      summaryByTool[toolName] ??
      summarizeText(message.content, 140) ??
      `${toolName} ${success ? "ok" : "failed"}`,
    filesRead,
    filesWritten,
    filesReverted,
  });
}

/**
 * Collects every file touched by a set of tool digests.
 *
 * @param toolDigests Tool digests captured during the turn.
 * @returns Frozen list of unique touched files.
 */
export function collectFilesTouched(
  toolDigests: readonly ToolDigest[],
): readonly string[] {
  const files = new Set<string>();
  for (const digest of toolDigests) {
    digest.filesRead.forEach((file) => files.add(file));
    digest.filesWritten.forEach((file) => files.add(file));
    digest.filesReverted.forEach((file) => files.add(file));
  }
  return Object.freeze([...files]);
}

/**
 * Extracts attachment labels and context-derived file references for the turn.
 *
 * @param userMessage User message starting the turn.
 * @param contextNote Optional derived context note passed into the working turn.
 * @returns Frozen attachment and referenced file labels.
 */
export function extractAttachments(
  userMessage: ChatMessage,
  contextNote?: string,
): readonly string[] {
  const fromMessage = [
    ...(userMessage.attachments?.map((attachment) => attachment.label) ?? []),
    ...(userMessage.figmaAttachments?.map((attachment) => attachment.label) ??
      []),
  ];
  const fromContext = Array.from(
    (contextNote ?? "").matchAll(/Read (?:file|document) with path "([^"]+)"/g),
  ).map((match) => match[1]!);
  return mergeUniqueItems([], [...fromMessage, ...fromContext], 10);
}

/**
 * Builds a compact handoff block used when the working turn is compacted.
 *
 * @param turn Active working turn being compacted.
 * @param assistantText Assistant draft to preserve in the handoff block.
 * @returns Compact handoff summary for the next prompt build.
 */
export function buildWorkingSessionHandoff(
  turn: WorkingTurn,
  assistantText: string,
): string {
  const lines: string[] = ["[WORKING SESSION HANDOFF]"];
  lines.push(
    `User request: ${summarizeText(turn.userMessage.content, 260) || "N/A"}`,
  );

  if (turn.contextNote?.trim()) {
    lines.push(`Context note: ${summarizeText(turn.contextNote, 220)}`);
  }

  if (assistantText.trim()) {
    lines.push(`Latest assistant state: ${summarizeText(assistantText, 320)}`);
  }

  const completed = turn.toolDigests
    .filter((digest) => digest.success)
    .map((digest) => digest.summary);
  const blockers = turn.toolDigests
    .filter((digest) => !digest.success)
    .map((digest) => digest.summary);

  if (completed.length > 0) {
    lines.push("Completed actions:");
    completed.slice(-8).forEach((item) => lines.push(`- ${item}`));
  }

  if (blockers.length > 0) {
    lines.push("Blockers:");
    blockers.slice(-6).forEach((item) => lines.push(`- ${item}`));
  }

  const filesTouched = collectFilesTouched(turn.toolDigests);
  if (filesTouched.length > 0) {
    lines.push(`Files touched: ${filesTouched.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Infers the high-level turn kind stored in task memory retrieval.
 *
 * @param turn Working turn used to classify the final result.
 * @param assistantText Final assistant text for the turn.
 * @returns Turn category used by task-memory retrieval.
 */
export function inferTaskMemoryTurnKind(
  turn: WorkingTurn,
  assistantText: string,
): "analysis" | "implementation" | "review" | "validation" | "repair" {
  const toolNames = new Set(turn.toolDigests.map((digest) => digest.name));
  const lowerAssistantText = assistantText.toLowerCase();

  if (
    toolNames.has("request_code_review") ||
    lowerAssistantText.includes("review finding")
  ) {
    return "review";
  }
  if (toolNames.has("validate_code")) {
    return "validation";
  }
  if (
    toolNames.has("edit_file_range") ||
    toolNames.has("multi_edit_file_ranges") ||
    toolNames.has("write_file") ||
    toolNames.has("create_drawio_diagram") ||
    toolNames.has("convert_drawio_diagram") ||
    toolNames.has("export_drawio_diagram") ||
    toolNames.has("edit_file")
  ) {
    return lowerAssistantText.includes("fix") ||
      lowerAssistantText.includes("repair")
      ? "repair"
      : "implementation";
  }
  return "analysis";
}

/**
 * Estimates the current token cost of the active working turn.
 *
 * @param turn Working turn to estimate.
 * @returns Token estimate for the working turn.
 */
export function estimateWorkingTurnTokens(turn: WorkingTurn | null): number {
  if (!turn) {
    return 0;
  }

  return (
    estimateTokens(turn.userMessage.content) +
    estimateTokens(turn.contextNote ?? "") +
    estimateTokens(turn.compactSummary ?? "") +
    turn.contextMessages.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0,
    )
  );
}

/**
 * Merges project summaries while keeping the result compact.
 *
 * @param existing Existing project summary.
 * @param next Next summary block to append.
 * @returns Trimmed merged summary.
 */
export function mergeProjectSummary(existing: string, next: string): string {
  const merged = [existing.trim(), next.trim()]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return summarizeText(merged, 3_200);
}

/**
 * Trims active task memory when it exceeds the configured soft limit.
 *
 * @param memory Active task memory snapshot to compact.
 * @returns Normalized compacted active-task memory.
 */
export function compactActiveTaskMemory(
  memory: ActiveTaskMemory,
): ActiveTaskMemory {
  if (estimateActiveTaskMemoryTokens(memory) <= ACTIVE_TASK_MEMORY_SOFT_LIMIT) {
    return normalizeActiveTaskMemory(memory);
  }

  return normalizeActiveTaskMemory(
    Object.freeze({
      ...memory,
      recentTurnSummaries: memory.recentTurnSummaries.slice(-6),
      filesTouched: memory.filesTouched.slice(-12),
      keyFiles: memory.keyFiles.slice(-12),
      pendingSteps: memory.pendingSteps.slice(-10),
      definitionOfDone: memory.definitionOfDone.slice(-10),
    }),
  );
}

/**
 * Trims project memory when it exceeds the configured soft limit.
 *
 * @param memory Project memory snapshot to compact.
 * @returns Normalized compacted project memory.
 */
export function compactProjectMemory(memory: ProjectMemory): ProjectMemory {
  if (estimateProjectMemoryTokens(memory) <= PROJECT_MEMORY_SOFT_LIMIT) {
    return normalizeProjectMemory(memory);
  }

  return normalizeProjectMemory(
    Object.freeze({
      ...memory,
      summary: summarizeText(memory.summary, 2_200),
      conventions: memory.conventions.slice(-10),
      recurringPitfalls: memory.recurringPitfalls.slice(-10),
      recentDecisions: memory.recentDecisions.slice(-10),
      keyFiles: memory.keyFiles.slice(-16),
    }),
  );
}

/**
 * Converts one finalized digest into a short session-summary line.
 *
 * @param digest Finalized turn digest.
 * @returns Compact one-line digest summary.
 */
export function createSessionSummaryLine(digest: TurnDigest): string {
  return [
    summarizeText(digest.userMessage, 120),
    summarizeText(digest.assistantSummary, 160),
    digest.filesTouched.length > 0
      ? `files=${digest.filesTouched.slice(0, 5).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" | ");
}
