/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound runtime actions covering tracked changes, approvals, logs, and quality detail updates.
 */

import type * as vscode from "vscode";
import type {
  ChatMessage,
  HostMessage,
  LogEntry,
  QualityDetails,
  ToolApprovalDecision,
} from "./protocol";
import type { PendingApprovalState } from "./extension-host";

/** Input payload used when requesting one tool approval through provider-bound runtime actions. */
export type ProviderToolApprovalRequest = Readonly<{
  /** Stable approval key used by approval persistence and webview state. */
  approvalKey: string;
  /** Tool id requesting approval. */
  toolName: string;
  /** User-facing title shown in native or webview approval prompts. */
  title: string;
  /** Primary approval message shown to the user. */
  message: string;
  /** Additional detail lines shown in the approval prompt. */
  details: readonly string[];
}>;

/** Provider-owned callbacks and state accessors required to build runtime actions. */
export type ProviderRuntimeActionBindings = Readonly<{
  /** Absolute workspace path used for telemetry and tracked-change history events. */
  workspacePath: string;
  /** Absolute path to the runtime debug log file. */
  debugLogPath: string;
  /** Shared output channel used for host runtime logs. */
  outputChannel: vscode.OutputChannel;
  /** Factory used to create stable ids for runtime log entries and approval requests. */
  createMessageId: () => string;
  /** Returns the current in-memory runtime log snapshot. */
  getRuntimeLogs: () => readonly LogEntry[];
  /** Stores the next runtime log snapshot in provider state. */
  setRuntimeLogs: (runtimeLogs: readonly LogEntry[]) => void;
  /** Formats absolute file paths into workspace-relative labels. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Posts one host message back into the live Galaxy webviews. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Records one external history event after revert actions. */
  recordExternalEvent: (
    summaryText: string,
    filePaths: readonly string[],
  ) => void;
  /** Appends one assistant transcript message describing a runtime action. */
  addMessage: (message: ChatMessage) => Promise<void>;
  /** Refreshes tracked workspace file state after a runtime action. */
  refreshWorkspaceFiles: () => Promise<void>;
  /** Returns whether another approval dialog is already pending. */
  hasPendingApproval: () => boolean;
  /** Stores the latest pending-approval state in provider state. */
  setPendingApprovalState: (state: PendingApprovalState) => void;
  /** Refreshes workbench chrome after approval state changes. */
  updateWorkbenchChrome: () => void;
  /** Clears the current pending-approval state from the provider. */
  clearPendingApprovalState: () => void;
  /** Reveals the Galaxy UI when the user requests to inspect the approval. */
  reveal: () => Promise<void>;
  /** Opens the Galaxy output channel when the user requests logs. */
  showLogs: () => void;
  /** Returns the current merged quality detail snapshot. */
  getQualityDetails: () => QualityDetails;
  /** Stores the next merged quality detail snapshot in provider state. */
  setQualityDetails: (qualityDetails: QualityDetails) => void;
}>;

/** Provider-bound runtime actions exposed by extracted host helpers. */
export type ProviderRuntimeActions = Readonly<{
  /** Appends one runtime log entry and mirrors it into the output channel and webview. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  /** Merges one partial quality update into provider state and posts the refreshed payload. */
  updateQualityDetails: (update: Partial<QualityDetails>) => void;
  /** Reverts one tracked file change from the current session. */
  revertTrackedFileChange: (filePath: string) => Promise<void>;
  /** Reverts every tracked file change from the current session. */
  revertAllTrackedChanges: () => Promise<void>;
  /** Requests approval for one pending tool action. */
  requestToolApproval: (
    approval: ProviderToolApprovalRequest,
  ) => Promise<ToolApprovalDecision>;
}>;
