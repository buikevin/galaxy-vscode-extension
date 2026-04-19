/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared extension-host runtime types reused across the VS Code entrypoint and extracted host modules.
 */

import type * as vscode from "vscode";
import type {
  ProjectMeta,
  ProjectStorageInfo,
} from "../context/entities/project-store";
import type { GalaxyConfig } from "./config";
import type { CommandTerminalRegistry } from "../runtime/command-terminal-registry";
import type {
  AgentType,
  ApprovalRequestPayload,
  ChatMessage,
  ChangeSummary,
  ChangedFileSummary as ChangedFileSummaryPayload,
  ExtensionToolGroup,
  FileItem,
  HostMessage,
  LogEntry,
  PlanItem,
  QualityDetails,
  QualityPreferences,
  SessionInitPayload,
  ToolApprovalDecision,
  ToolCapabilities,
  ToolToggles,
} from "./protocol";

/** Minimal shape required from the context-files provider. */
export type ContextFilesProviderLike = vscode.TreeDataProvider<FileItem> & {
  /** Replace the currently rendered workspace file list. */
  setFiles(files: readonly FileItem[]): void;
  /** Return the first file for default focus behavior. */
  getFirstFile(): FileItem | undefined;
};

/** Minimal shape required from the changed-files provider. */
export type ChangedFilesProviderLike =
  vscode.TreeDataProvider<ChangedFileSummaryPayload> & {
    /** Replace the currently rendered changed-file list. */
    setFiles(files: readonly ChangedFileSummaryPayload[]): void;
    /** Return the first changed file for default focus behavior. */
    getFirstFile(): ChangedFileSummaryPayload | undefined;
  };

/** Status bar and output-channel elements controlled by the host runtime. */
export type GalaxyWorkbenchChrome = Readonly<{
  /** Shared output channel where runtime activity is appended. */
  outputChannel: vscode.OutputChannel;
  /** Status-bar item reflecting run state. */
  runStatusItem: vscode.StatusBarItem;
  /** Status-bar item reflecting selected agent. */
  agentStatusItem: vscode.StatusBarItem;
  /** Status-bar item reflecting approval mode. */
  approvalStatusItem: vscode.StatusBarItem;
}>;

/** Native VS Code tree views attached to the host runtime. */
export type NativeShellViews = Readonly<{
  /** Provider backing the context-files view. */
  contextFilesProvider: ContextFilesProviderLike;
  /** Tree view rendering workspace context files. */
  contextFilesView: vscode.TreeView<FileItem>;
  /** Provider backing the changed-files view. */
  changedFilesProvider: ChangedFilesProviderLike;
  /** Tree view rendering tracked file changes. */
  changedFilesView: vscode.TreeView<ChangedFileSummaryPayload>;
}>;

/** Background command completion captured after terminal execution finishes. */
export type BackgroundCommandCompletion = Readonly<{
  /** Stable tool call id associated with the command. */
  toolCallId: string;
  /** Full command text shown to the user. */
  commandText: string;
  /** Working directory used for execution. */
  cwd: string;
  /** Process exit code returned by the command. */
  exitCode: number;
  /** Whether the command exited successfully. */
  success: boolean;
  /** Runtime duration in milliseconds. */
  durationMs: number;
  /** Captured terminal output tail. */
  output: string;
  /** Whether the command originally ran in background mode. */
  background: boolean;
}>;

/** Active shell-session state mirrored into the webview. */
export type ActiveShellSessionState = Readonly<{
  /** Stable tool call id associated with the command. */
  toolCallId: string;
  /** Full command text shown to the user. */
  commandText: string;
  /** Working directory used for execution. */
  cwd: string;
  /** Unix timestamp in milliseconds when execution started. */
  startedAt: number;
  /** Buffered terminal output preview. */
  output: string;
  /** Optional VS Code terminal title. */
  terminalTitle?: string;
  /** Whether the command completed successfully. */
  success?: boolean;
  /** Exit code returned by the command. */
  exitCode?: number;
  /** Runtime duration in milliseconds. */
  durationMs?: number;
  /** Whether the command continued in background mode. */
  background?: boolean;
}>;

/** Persisted command-context payload stored for follow-up repair turns. */
export type CommandContextFile = Readonly<{
  /** Original command text that produced the context snapshot. */
  command: string;
  /** Working directory used for execution. */
  cwd: string;
  /** Terminal lifecycle status captured at write time. */
  status: "running" | "completed" | "failed";
  /** Optional process exit code. */
  exitCode?: number;
  /** Optional runtime duration in milliseconds. */
  durationMs?: number;
  /** Tail of terminal output kept for prompt context. */
  tailOutput: string;
  /** Human-readable command summary. */
  summary: string;
  /** Files changed while the command was running. */
  changedFiles: readonly string[];
  /** ISO timestamp for the latest update. */
  updatedAt: string;
  /** ISO timestamp when the command finished. */
  completedAt?: string;
}>;

/** Minimal result returned by one internal repair turn. */
export type RepairTurnResult = Readonly<{
  /** Whether the repair turn failed or emitted an unrecoverable runtime error. */
  hadError: boolean;
  /** Files written or modified during the repair turn. */
  filesWritten: readonly string[];
}>;

/** Input payload needed to start one internal repair turn. */
export type RepairTurnRequest = Readonly<{
  /** Effective runtime config used for the repair turn. */
  config: GalaxyConfig;
  /** Agent selected to execute the repair turn. */
  agentType: AgentType;
  /** Internal control message injected as the repair request. */
  userMessage: ChatMessage;
  /** Whether the internal repair prompt should also be mirrored into the visible transcript. */
  showUserMessageInTranscript?: boolean;
  /** Optional prompt context note appended ahead of the repair turn. */
  contextNote?: string;
  /** Optional empty-result retry counter carried across auto-continue attempts. */
  emptyContinueAttempt?: number;
}>;

/** Payload persisted into the command-context file for follow-up actions. */
export type CommandContextWritePayload = Readonly<{
  /** Exact command text that produced the context snapshot. */
  commandText: string;
  /** Working directory used for the command. */
  cwd: string;
  /** Optional success flag when the command has already completed. */
  success?: boolean;
  /** Optional process exit code when the command has already completed. */
  exitCode?: number;
  /** Optional command duration in milliseconds. */
  durationMs?: number;
  /** Optional captured output tail persisted into the snapshot. */
  output?: string;
  /** Optional list of changed files associated with the command. */
  changedFiles?: readonly string[];
  /** Whether the command is still running when the snapshot is written. */
  running?: boolean;
}>;

/** Runtime state required by extracted command-stream helpers. */
export type CommandStreamCallbacks = Readonly<{
  /** Registry that owns buffered VS Code pseudoterminals for tool calls. */
  commandTerminalRegistry: CommandTerminalRegistry;
  /** In-memory shell session state mirrored into the webview. */
  activeShellSessions: Map<string, ActiveShellSessionState>;
  /** Absolute path to the persisted command-context file. */
  commandContextPath: string;
  /** Runtime log sink used to surface command status changes. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  /** Webview bridge used to post host messages. */
  postMessage: (message: HostMessage) => Promise<void>;
}>;

/** Runtime state required by extracted background-command completion helpers. */
export type BackgroundCommandCallbacks = Readonly<{
  /** Absolute path to the persisted command-context file. */
  commandContextPath: string;
  /** Runtime log sink used to surface queue and repair status changes. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  /** Converts an absolute path to a workspace-relative label. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Returns whether the main provider is already processing a turn. */
  getIsRunning: () => boolean;
  /** Returns whether a background completion follow-up is already running. */
  getBackgroundCompletionRunning: () => boolean;
  /** Updates the in-memory flag guarding background completion processing. */
  setBackgroundCompletionRunning: (value: boolean) => void;
  /** Returns the queued background completions awaiting follow-up. */
  getPendingBackgroundCompletions: () => readonly BackgroundCommandCompletion[];
  /** Replaces the queued background completions awaiting follow-up. */
  setPendingBackgroundCompletions: (
    completions: readonly BackgroundCommandCompletion[],
  ) => void;
  /** Updates the provider status text shown in the UI and status bar. */
  setStatusText: (value: string) => void;
  /** Reports one progress-line update to the active progress reporter. */
  reportProgress: (statusText: string) => void;
  /** Posts the latest running/idle state into the webview. */
  postRunState: () => Promise<void>;
  /** Returns the latest effective runtime config snapshot. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Returns the currently selected agent type. */
  getSelectedAgent: () => AgentType;
  /** Executes one internal repair turn for a completed background command. */
  runInternalRepairTurn: (
    request: RepairTurnRequest,
  ) => Promise<RepairTurnResult>;
  /** Runs the post-repair validation/review quality gate when needed. */
  runValidationAndReviewFlow: (agentType: AgentType) => Promise<unknown>;
}>;

/** Minimal approval request shape passed into the approval workflow. */
export type ToolApprovalRequest = Readonly<{
  /** Approval cache key reused across identical tool requests. */
  approvalKey: string;
  /** Tool name requesting approval. */
  toolName: string;
  /** User-facing title shown in the approval UI. */
  title: string;
  /** Primary message explaining why approval is needed. */
  message: string;
  /** Additional detail lines shown under the main approval message. */
  details: readonly string[];
}>;

/** Persisted pending-approval state mirrored in the provider. */
export type PendingApprovalState = Readonly<{
  /** Stable request id used to correlate the webview response. */
  requestId: string;
  /** User-facing approval title shown in status bar and modal surfaces. */
  title: string;
  /** Full approval payload posted to the webview. */
  payload: ApprovalRequestPayload;
  /** Optional resolver used when the approval result is awaited asynchronously. */
  resolver?: (decision: ToolApprovalDecision) => void;
}>;

/** Runtime callbacks required by the extracted approval workflow. */
export type ApprovalWorkflowCallbacks = Readonly<{
  /** Returns whether another approval dialog is already pending. */
  hasPendingApproval: () => boolean;
  /** Creates a new stable request id for the approval attempt. */
  createRequestId: () => string;
  /** Runtime log sink used to report approval prompts and outcomes. */
  appendLog: (kind: "approval", text: string) => void;
  /** Stores the latest pending-approval state in the provider. */
  setPendingApprovalState: (state: PendingApprovalState) => void;
  /** Refreshes status-bar chrome after approval state changes. */
  updateWorkbenchChrome: () => void;
  /** Clears the current pending-approval state from the provider. */
  clearPendingApprovalState: () => void;
  /** Webview bridge used to post approval requests. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Reveals the Galaxy UI when the user wants to inspect the approval. */
  reveal: () => Promise<void>;
  /** Opens the shared output channel when the user requests logs. */
  showLogs: () => void;
}>;

/** Runtime callbacks required by review-finding helper functions. */
export type ReviewFindingCallbacks = Readonly<{
  /** Workspace root used for task-memory updates. */
  workspacePath: string;
  /** Returns whether the provider is already running another turn. */
  isRunning: () => boolean;
  /** Webview bridge used to surface errors and state changes. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Clears in-flight assistant/thinking stream buffers. */
  clearStreamingBuffers: () => void;
  /** Updates the provider run-state fields before posting them. */
  setRunningState: (isRunning: boolean, statusText: string) => void;
  /** Posts the current run-state snapshot into the webview. */
  postRunState: () => Promise<void>;
  /** Returns the latest effective runtime config snapshot. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Returns the currently selected agent type. */
  getSelectedAgent: () => AgentType;
  /** Executes one focused internal repair turn. */
  runInternalRepairTurn: (
    request: RepairTurnRequest,
  ) => Promise<RepairTurnResult>;
  /** Persists project-meta mutations back to workspace storage. */
  persistProjectMetaPatch: (
    mutate: (previous: ProjectMeta | null) => ProjectMeta | null,
  ) => void;
  /** Pushes updated review findings into the provider quality state. */
  updateQualityDetails: (update: Partial<QualityDetails>) => void;
  /** Runs the quality gate after a review finding is applied. */
  runValidationAndReviewFlow: (agentType: AgentType) => Promise<unknown>;
}>;

/** Summary of approval mode shown in the workbench status bar. */
export type ApprovalModeSummary = Readonly<{
  /** Short label rendered beside the approval shield icon. */
  label: string;
  /** Tooltip text explaining the current approval mode. */
  tooltip: string;
}>;

/** Parameters used to update the Galaxy workbench chrome. */
export type WorkbenchChromeUpdateParams = Readonly<{
  /** Shared status bar and output channel references. */
  chrome: GalaxyWorkbenchChrome;
  /** Whether the provider is currently running a turn. */
  isRunning: boolean;
  /** Current status text rendered in the run-status item. */
  statusText: string;
  /** Currently selected agent displayed in the agent-status item. */
  selectedAgent: AgentType;
  /** Optional pending approval request id used to show warning state. */
  pendingApprovalRequestId: string | null;
  /** Optional pending approval title shown in the tooltip. */
  pendingApprovalTitle: string | null;
  /** Effective quality preferences that influence approval labels. */
  qualityPreferences: QualityPreferences;
}>;

/** Parameters used to build the full session-init payload. */
export type BuildSessionInitPayloadParams = Readonly<{
  /** Workspace name shown in the webview header. */
  workspaceName: string;
  /** File list rendered in the file picker. */
  files: readonly SessionInitPayload["files"][number][];
  /** Transcript messages restored into the webview. */
  messages: readonly SessionInitPayload["messages"][number][];
  /** Currently selected agent in the webview composer. */
  selectedAgent: AgentType;
  /** Whether the provider is actively running. */
  isRunning: boolean;
  /** Current status text shown in the UI. */
  statusText: string;
  /** Planning items shown in the plan panel. */
  planItems: readonly PlanItem[];
  /** Runtime log entries shown in the logs panel. */
  logs: readonly LogEntry[];
  /** Current quality summary block. */
  qualityDetails: QualityDetails;
  /** Effective quality preferences selected by the user. */
  qualityPreferences: QualityPreferences;
  /** Effective capability flags for the current session. */
  toolCapabilities: ToolCapabilities;
  /** Effective per-tool toggle flags. */
  toolToggles: ToolToggles;
  /** Extension-provided tool groups available to the user. */
  extensionToolGroups: readonly ExtensionToolGroup[];
  /** Toggle state for extension-provided tools. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Current workspace diff/change summary. */
  changeSummary: ChangeSummary;
  /** Draft local attachments that should be restored into the composer. */
  localAttachments?: SessionInitPayload["localAttachments"];
  /** Whether older transcript history exists beyond the currently loaded batch. */
  hasOlderMessages: boolean;
  /** Optional in-flight assistant stream text. */
  streamingAssistant?: string;
  /** Optional in-flight thinking stream text. */
  streamingThinking?: string;
  /** Optional active shell sessions mirrored into the command panel. */
  activeShellSessions?: readonly ActiveShellSessionState[];
  /** Optional pending approval request restored on load. */
  approvalRequest?: ApprovalRequestPayload | null;
}>;

/** Parameters needed to rebuild and post a session-init payload. */
export type PostSessionInitParams = Readonly<{
  /** Workspace storage metadata used to read persisted project state. */
  projectStorage: ProjectStorageInfo;
  /** File list rendered in the file picker. */
  files: readonly FileItem[];
  /** Transcript messages restored into the webview. */
  messages: readonly ChatMessage[];
  /** Currently selected agent in the webview composer. */
  selectedAgent: AgentType;
  /** Whether the provider is actively running. */
  isRunning: boolean;
  /** Current status text shown in the UI. */
  statusText: string;
  /** Planning items shown in the plan panel. */
  planItems: readonly PlanItem[];
  /** Runtime log entries shown in the logs panel. */
  logs: readonly LogEntry[];
  /** Current quality summary block. */
  qualityDetails: QualityDetails;
  /** Effective quality preferences selected by the user. */
  qualityPreferences: QualityPreferences;
  /** Effective capability flags for the current session. */
  toolCapabilities: ToolCapabilities;
  /** Effective per-tool toggle flags. */
  toolToggles: ToolToggles;
  /** Extension-provided tool groups available to the user. */
  extensionToolGroups: readonly ExtensionToolGroup[];
  /** Toggle state for extension-provided tools. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Current workspace diff/change summary. */
  changeSummary: ChangeSummary;
  /** Whether older transcript history exists beyond the currently loaded batch. */
  hasOlderMessages: boolean;
  /** Optional in-flight assistant stream text. */
  streamingAssistant?: string;
  /** Optional in-flight thinking stream text. */
  streamingThinking?: string;
  /** Optional active shell sessions mirrored into the command panel. */
  activeShellSessions?: readonly ActiveShellSessionState[];
  /** Optional pending approval request restored on load. */
  approvalRequest?: SessionInitPayload["approvalRequest"];
  /** Normalizes transcript messages for safe webview transport. */
  sanitizeChatMessageForWebview: (message: ChatMessage) => ChatMessage;
  /** Webview bridge used to post the final session-init payload. */
  postMessage: (message: HostMessage) => Promise<void>;
}>;

/** Callbacks required by the extracted agent-selection quick pick. */
export type AgentQuickPickCallbacks = Readonly<{
  /** Returns whether the provider is currently executing a turn. */
  isRunning: () => boolean;
  /** Returns the currently selected agent. */
  getSelectedAgent: () => AgentType;
  /** Stores the newly selected agent in provider state. */
  setSelectedAgent: (agentType: AgentType) => void;
  /** Persists the selected agent into workspace storage. */
  persistSelectedAgent: () => void;
  /** Pushes the selected-agent change into the webview and status bar. */
  postSelectedAgentUpdate: () => Promise<void>;
  /** Runtime log sink used to report the agent switch. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
}>;

/** Callbacks required by transcript message/runtime helpers. */
export type MessageRuntimeCallbacks = Readonly<{
  /** Returns the current transcript message list. */
  getMessages: () => readonly ChatMessage[];
  /** Appends one message to the provider transcript state. */
  appendMessage: (message: ChatMessage) => void;
  /** Returns the currently selected agent used for assistant dedupe/debugging. */
  getSelectedAgent: () => string;
  /** Runtime log sink used to report dedupe events. */
  appendLog: (kind: "info", text: string) => void;
  /** Clears in-flight assistant/thinking stream buffers. */
  clearStreamingBuffers: () => void;
  /** Persists one message into the transcript store. */
  appendTranscriptMessage: (message: ChatMessage) => void;
  /** Normalizes transcript messages for safe webview transport. */
  sanitizeChatMessageForWebview: (message: ChatMessage) => ChatMessage;
  /** Webview bridge used to post transcript updates. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Absolute path to the debug log file. */
  debugLogPath: string;
}>;

/** One requested selection toggle originating from the webview file picker. */
export type FileSelectionUpdate = Readonly<{
  /** File path supplied by the webview for selection updates. */
  filePath: string;
  /** Whether the file should be selected or deselected. */
  selected: boolean;
}>;

/** Callbacks required by workspace file-sync and native shell view helpers. */
export type WorkspaceSyncCallbacks = Readonly<{
  /** Mutable set containing the currently selected absolute file paths. */
  selectedFiles: Set<string>;
  /** Optional native shell views that mirror files and changed files. */
  nativeShellViews: NativeShellViews | null;
  /** Resolves a webview-supplied file path against the workspace root. */
  resolveWorkspaceFilePath: (filePath: string) => string;
  /** Returns the latest workspace file list for the file picker. */
  getWorkspaceFiles: () => Promise<readonly FileItem[]>;
  /** Converts an absolute file path into a workspace-relative label. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Webview bridge used to post file and change-summary updates. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Opens the tracked diff for one changed file. */
  openTrackedDiff: (filePath: string) => Promise<void>;
}>;
