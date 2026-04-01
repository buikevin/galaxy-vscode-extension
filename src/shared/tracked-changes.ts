/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared callback contracts for tracked file revert flows extracted from the extension host entrypoint.
 */

import type { ChatMessage, HostMessage } from "./protocol";

/** Host callbacks required to revert one or many session-tracked file changes. */
export type TrackedChangeCallbacks = Readonly<{
  /** Absolute workspace path used for telemetry events associated with revert actions. */
  workspacePath: string;
  /** Formats absolute file paths into workspace-relative labels for user-facing summaries. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Posts one host message back into the webview runtime. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Records one external history event so reverted files remain visible in transcript history. */
  recordExternalEvent: (
    summaryText: string,
    filePaths: readonly string[],
  ) => void;
  /** Appends one assistant message describing the completed revert action. */
  addMessage: (message: ChatMessage) => Promise<void>;
  /** Refreshes tracked workspace file state and dependent native views after a revert action. */
  refreshWorkspaceFiles: () => Promise<void>;
}>;
