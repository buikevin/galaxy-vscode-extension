/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for session lifecycle helpers extracted from the extension entrypoint.
 */

import type { HistoryManager } from "../context/entities/history-manager";
import type { CommandTerminalRegistry } from "../runtime/command-terminal-registry";
import type {
  ProjectMeta,
  ProjectStorageInfo,
} from "../context/entities/project-store";
import type { ActiveShellSessionState } from "./extension-host";
import type { ChatMessage, LogEntry, QualityDetails } from "./protocol";
import type { ResetWorkspaceSessionOptions } from "./workspace-reset";

/** Parameters required to load the initial transcript state for one workspace session. */
export type LoadInitialMessagesParams = Readonly<{
  /** Project storage info containing the persisted transcript path. */
  projectStorage: ProjectStorageInfo;
  /** Updates the provider status text after transcript recovery. */
  setStatusText: (statusText: string) => void;
  /** Appends one runtime log entry describing transcript recovery state. */
  appendLog: (
    kind: "info" | "status" | "approval" | "validation" | "review" | "error",
    text: string,
  ) => void;
}>;

export type LoadedInitialMessagesResult = Readonly<{
  messages: readonly ChatMessage[];
  hasOlderMessages: boolean;
}>;

/** Parameters required to persist one project-meta mutation. */
export type PersistProjectMetaPatchParams = Readonly<{
  /** Project storage info containing the persisted meta path. */
  projectStorage: ProjectStorageInfo;
  /** Pure mutation applied to the previously stored project metadata. */
  mutate: (previous: ProjectMeta | null) => ProjectMeta | null;
}>;

/** Parameters required to reset one provider workspace session. */
export type ResetProviderWorkspaceSessionParams = Readonly<{
  /** Absolute workspace path used to clear stored action approvals. */
  workspacePath: string;
  /** Project storage info containing persisted project paths. */
  projectStorage: ProjectStorageInfo;
  /** In-memory history manager used by the current provider instance. */
  historyManager: HistoryManager;
  /** Recreates persisted project storage defaults after directory deletion. */
  recreateProjectStorageState: () => void;
  /** Clears persisted action approvals for the current workspace. */
  clearActionApprovals: () => void;
  /** Clears runtime file/session tracking state. */
  clearRuntimeSession: () => void;
  /** Resets in-memory runtime logs. */
  resetRuntimeLogs: () => void;
  /** Resets in-memory quality details back to empty defaults. */
  resetQualityDetails: () => void;
  /** Resets in-memory transcript messages. */
  resetMessages: () => void;
  /** Updates the provider running flag during reset. */
  setIsRunning: (value: boolean) => void;
  /** Clears pending approval metadata. */
  clearPendingApprovalState: () => void;
  /** Clears the active progress reporter. */
  clearProgressReporter: () => void;
  /** Clears shell sessions and terminal registry state. */
  clearShellState: () => void;
  /** Clears transient assistant and thinking buffers. */
  clearStreamingBuffers: () => void;
  /** Recomputes workbench chrome after the reset completes. */
  updateWorkbenchChrome: () => void;
}>;

/** Factory used to build the default empty quality-details snapshot. */
export type CreateEmptyQualityDetails = () => QualityDetails;

/** Provider-owned mutable state bindings used to build reset-session callbacks outside the provider class. */
export type ProviderWorkspaceResetBindings = Readonly<{
  /** Absolute workspace path used to clear stored action approvals. */
  workspacePath: string;
  /** Project storage info containing persisted project paths. */
  projectStorage: ProjectStorageInfo;
  /** In-memory history manager used by the current provider instance. */
  historyManager: HistoryManager;
  /** Recreates persisted project storage defaults after directory deletion. */
  recreateProjectStorageState: () => void;
  /** Clears persisted action approvals for the current workspace. */
  clearActionApprovals: () => void;
  /** Clears runtime file/session tracking state. */
  clearRuntimeSession: () => void;
  /** Stores the next runtime log snapshot in provider state. */
  setRuntimeLogs: (runtimeLogs: readonly LogEntry[]) => void;
  /** Builds the default empty quality-details snapshot. */
  createEmptyQualityDetails: CreateEmptyQualityDetails;
  /** Stores the next quality-details snapshot in provider state. */
  setQualityDetails: (qualityDetails: QualityDetails) => void;
  /** Stores the next transcript message list in provider state. */
  setMessages: (messages: readonly ChatMessage[]) => void;
  /** Updates the provider running flag during reset. */
  setIsRunning: (value: boolean) => void;
  /** Clears pending approval metadata. */
  clearPendingApprovalState: () => void;
  /** Clears the active progress reporter. */
  clearProgressReporter: () => void;
  /** Mutable active shell sessions mirrored into the webview. */
  activeShellSessions: Map<string, ActiveShellSessionState>;
  /** Registry of command terminals associated with tool calls. */
  commandTerminalRegistry: CommandTerminalRegistry;
  /** Clears transient assistant and thinking buffers. */
  clearStreamingBuffers: () => void;
  /** Recomputes workbench chrome after the reset completes. */
  updateWorkbenchChrome: () => void;
}>;

export type { ResetWorkspaceSessionOptions };
