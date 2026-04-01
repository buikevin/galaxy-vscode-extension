/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Small chat runtime state helpers extracted from the extension entrypoint.
 */

import type { ChatMessage, QualityPreferences } from "../shared/protocol";

/** Builds the synthetic continuation message used when the previous model reply stopped early. */
export function buildContinueMessage(opts: {
  attempt: number;
  lastUserGoal?: string;
  lastThinking?: string;
  filesWritten?: readonly string[];
  recentToolSummaries?: readonly string[];
}): ChatMessage {
  const lines = [
    "[SYSTEM CONTINUATION]",
    "The previous reply ended without a final user-facing answer.",
    "Continue from the current workspace state.",
    "Do not restart the task and do not repeat the same read/edit cycle unless fresh evidence is truly required.",
    "If you already inspected or edited a file in the previous attempt, prefer moving forward to completion instead of reopening the same file again.",
  ];

  if (opts.lastUserGoal?.trim()) {
    lines.push(`Last user goal: ${opts.lastUserGoal.trim()}`);
  }

  if (opts.filesWritten?.length) {
    lines.push(
      `Files already changed in the previous attempt: ${opts.filesWritten.join(", ")}`,
    );
  }

  if (opts.recentToolSummaries?.length) {
    lines.push("Recent tool actions:");
    opts.recentToolSummaries
      .slice(-6)
      .forEach((item) => lines.push(`- ${item}`));
  }

  if (opts.lastThinking?.trim()) {
    lines.push(
      `Last thinking snapshot: ${opts.lastThinking.trim().slice(0, 400)}`,
    );
  }

  lines.push(
    "Return either the next concrete action that advances the task or the final answer if the task is already complete.",
  );

  return Object.freeze({
    id: `continue-${Date.now()}-${opts.attempt}`,
    role: "user",
    content: lines.join("\n\n"),
    timestamp: Date.now(),
  });
}

/** Returns whether assistant final output should be gated behind review or validation. */
export function shouldGateAssistantFinalMessage(
  qualityPreferences: QualityPreferences,
  filesWritten: readonly string[],
): boolean {
  if (filesWritten.length === 0) {
    return false;
  }

  return qualityPreferences.reviewEnabled || qualityPreferences.validateEnabled;
}
