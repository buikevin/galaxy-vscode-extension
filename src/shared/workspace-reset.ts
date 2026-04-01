/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared reset contracts for workspace session cleanup extracted from the extension host entrypoint.
 */

/** Options that control how aggressively one workspace session reset should clean persisted state. */
export type ResetWorkspaceSessionOptions = Readonly<{
  /** Removes the workspace project storage directory instead of only clearing the current UI transcript. */
  removeProjectDir?: boolean;
}>;

/** Host callbacks needed to reset one workspace session without keeping reset logic inside the provider class. */
export type WorkspaceResetCallbacks = Readonly<{
  /** Absolute path to the persisted project storage directory for the current workspace. */
  projectDirPath: string;
  /** Absolute path to the persisted command context file used by shell command flows. */
  commandContextPath: string;
  /** Recreates project storage metadata after the persisted project directory has been removed. */
  recreateProjectStorageState: () => void;
  /** Clears only the persisted UI transcript while keeping project storage intact. */
  clearUiTranscript: () => void;
  /** Clears in-memory history snapshots tracked for the current workspace session. */
  clearHistory: () => void;
  /** Removes any persisted approval decisions associated with the current workspace. */
  clearActionApprovals: () => void;
  /** Clears the runtime session tracker that records tracked file changes. */
  clearRuntimeSession: () => void;
  /** Resets the in-memory runtime log buffer shown in the webview and logs view. */
  resetRuntimeLogs: () => void;
  /** Restores quality summary state back to its empty default values. */
  resetQualityDetails: () => void;
  /** Removes all rendered chat transcript messages from in-memory state. */
  resetMessages: () => void;
  /** Updates the running flag so the provider is no longer considered busy. */
  setIsRunning: (value: boolean) => void;
  /** Clears any pending approval request metadata waiting on the user. */
  clearPendingApprovalState: () => void;
  /** Drops the active progress reporter used by the current run, if any. */
  clearProgressReporter: () => void;
  /** Clears shell session and terminal registry state tied to the current workspace run. */
  clearShellState: () => void;
  /** Clears transient streaming buffers for assistant and thinking output. */
  clearStreamingBuffers: () => void;
  /** Recomputes workbench chrome state after the reset completes. */
  updateWorkbenchChrome: () => void;
}>;
