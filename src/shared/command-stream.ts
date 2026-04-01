/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound command stream and background completion bindings.
 */

import type { CommandTerminalRegistry } from "../runtime/command-terminal-registry";
import type {
  ActiveShellSessionState,
  BackgroundCommandCallbacks,
  BackgroundCommandCompletion,
  CommandStreamCallbacks,
} from "./extension-host";

/** Provider-owned bindings required to mirror terminal command stream events. */
export type ProviderCommandStreamBindings = Readonly<{
  /** Registry that owns buffered VS Code pseudoterminals for tool calls. */
  commandTerminalRegistry: CommandTerminalRegistry;
  /** In-memory shell session state mirrored into the webview. */
  activeShellSessions: Map<string, ActiveShellSessionState>;
  /** Absolute path to the persisted command-context file. */
  commandContextPath: string;
  /** Runtime log sink used to surface command status changes. */
  appendLog: CommandStreamCallbacks["appendLog"];
  /** Webview bridge used to post host messages. */
  postMessage: CommandStreamCallbacks["postMessage"];
}>;

/** Provider-owned bindings required to process finished background terminal commands. */
export type ProviderBackgroundCommandBindings = Readonly<{
  /** Absolute path to the persisted command-context file. */
  commandContextPath: string;
  /** Runtime log sink used to surface queue and repair status changes. */
  appendLog: BackgroundCommandCallbacks["appendLog"];
  /** Converts an absolute path to a workspace-relative label. */
  asWorkspaceRelative: BackgroundCommandCallbacks["asWorkspaceRelative"];
  /** Returns whether the main provider is already processing a turn. */
  getIsRunning: BackgroundCommandCallbacks["getIsRunning"];
  /** Returns whether a background completion follow-up is already running. */
  getBackgroundCompletionRunning: BackgroundCommandCallbacks["getBackgroundCompletionRunning"];
  /** Updates the in-memory flag guarding background completion processing. */
  setBackgroundCompletionRunning: BackgroundCommandCallbacks["setBackgroundCompletionRunning"];
  /** Returns the queued background completions awaiting follow-up. */
  getPendingBackgroundCompletions: BackgroundCommandCallbacks["getPendingBackgroundCompletions"];
  /** Replaces the queued background completions awaiting follow-up. */
  setPendingBackgroundCompletions: BackgroundCommandCallbacks["setPendingBackgroundCompletions"];
  /** Updates the provider status text shown in the UI and status bar. */
  setStatusText: BackgroundCommandCallbacks["setStatusText"];
  /** Reports one progress-line update to the active progress reporter. */
  reportProgress: BackgroundCommandCallbacks["reportProgress"];
  /** Posts the latest running/idle state into the webview. */
  postRunState: BackgroundCommandCallbacks["postRunState"];
  /** Returns the latest effective runtime config snapshot. */
  getEffectiveConfig: BackgroundCommandCallbacks["getEffectiveConfig"];
  /** Returns the currently selected agent type. */
  getSelectedAgent: BackgroundCommandCallbacks["getSelectedAgent"];
  /** Executes one internal repair turn for a completed background command. */
  runInternalRepairTurn: BackgroundCommandCallbacks["runInternalRepairTurn"];
  /** Runs the post-repair validation/review quality gate when needed. */
  runValidationAndReviewFlow: BackgroundCommandCallbacks["runValidationAndReviewFlow"];
}>;

/** Provider-owned bindings required to route tracked change actions. */
export type ProviderTrackedChangeBindings = Readonly<{
  /** Absolute workspace path used for revert actions. */
  workspacePath: string;
  /** Converts absolute file paths into workspace-relative labels. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Posts one host message back into the webview runtime. */
  postMessage: (message: import("./protocol").HostMessage) => Promise<void>;
  /** Records one external history event after revert actions. */
  recordExternalEvent: (
    summaryText: string,
    filePaths: readonly string[],
  ) => void;
  /** Appends one assistant message describing the completed revert action. */
  addMessage: (message: import("./protocol").ChatMessage) => Promise<void>;
  /** Refreshes tracked workspace file state after a revert action. */
  refreshWorkspaceFiles: () => Promise<void>;
}>;
