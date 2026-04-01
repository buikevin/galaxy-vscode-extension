/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Tracked file revert flows extracted from the extension host entrypoint.
 */

import { appendTelemetryEvent } from "../context/telemetry";
import { revertAllSessionFiles, revertFile } from "../runtime/session-tracker";
import type { TrackedChangeCallbacks } from "../shared/tracked-changes";
import { createAssistantMessage } from "./utils";

/** Reverts one tracked file, records telemetry/history, and refreshes workspace file state. */
export async function revertTrackedFileChange(
  callbacks: TrackedChangeCallbacks,
  filePath: string,
): Promise<void> {
  const result = revertFile(filePath);
  if (!result.success) {
    await callbacks.postMessage({
      type: "error",
      payload: { message: result.reason },
    });
    return;
  }

  const relativePath = callbacks.asWorkspaceRelative(result.filePath);
  const summaryText = result.wasNew
    ? `User reverted a newly created file: ${relativePath}.`
    : `User reverted changes in file: ${relativePath}.`;
  appendTelemetryEvent(callbacks.workspacePath, {
    kind: "user_revert",
    fileCount: 1,
  });
  callbacks.recordExternalEvent(summaryText, [result.filePath]);
  await callbacks.addMessage(createAssistantMessage(summaryText));
  await callbacks.refreshWorkspaceFiles();
}

/** Reverts every tracked file in the session, posts failures, and refreshes workspace file state. */
export async function revertAllTrackedChanges(
  callbacks: TrackedChangeCallbacks,
): Promise<void> {
  const result = revertAllSessionFiles();
  if (result.revertedPaths.length === 0 && result.failedReasons.length === 0) {
    return;
  }

  if (result.revertedPaths.length > 0) {
    const revertedLabels = result.revertedPaths.map((filePath) =>
      callbacks.asWorkspaceRelative(filePath),
    );
    const summaryText =
      `User reverted ${result.revertedPaths.length} tracked file change(s): ` +
      revertedLabels.join(", ") +
      ".";
    appendTelemetryEvent(callbacks.workspacePath, {
      kind: "user_revert",
      fileCount: result.revertedPaths.length,
    });
    callbacks.recordExternalEvent(summaryText, result.revertedPaths);
    await callbacks.addMessage(createAssistantMessage(summaryText));
  }

  if (result.failedReasons.length > 0) {
    await callbacks.postMessage({
      type: "error",
      payload: { message: result.failedReasons.join("\n") },
    });
  }

  await callbacks.refreshWorkspaceFiles();
}
