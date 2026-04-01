/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-owned callback binding builders extracted from the extension entrypoint.
 */

import type { OutputChannel } from "vscode";
import type {
  ApprovalWorkflowCallbacks,
  WorkspaceSyncCallbacks,
} from "../shared/extension-host";
import type {
  ProviderBackgroundCommandBindings,
  ProviderCommandStreamBindings,
  ProviderTrackedChangeBindings,
} from "../shared/command-stream";
import type { ProviderRuntimeLogBindings } from "../shared/message-runtime";
import type {
  HostMessage,
  LogEntry,
} from "../shared/protocol";
import type { ToolApprovalDecision } from "../shared/protocol";
import type { BackgroundCommandCompletion } from "../shared/extension-host";

/** Builds the workspace-sync callback bag from provider-owned state and methods. */
export function createWorkspaceSyncCallbacks(params: {
  selectedFiles: WorkspaceSyncCallbacks["selectedFiles"];
  nativeShellViews: WorkspaceSyncCallbacks["nativeShellViews"];
  resolveWorkspaceFilePath: WorkspaceSyncCallbacks["resolveWorkspaceFilePath"];
  getWorkspaceFiles: WorkspaceSyncCallbacks["getWorkspaceFiles"];
  asWorkspaceRelative: WorkspaceSyncCallbacks["asWorkspaceRelative"];
  postMessage: WorkspaceSyncCallbacks["postMessage"];
  openTrackedDiff: WorkspaceSyncCallbacks["openTrackedDiff"];
}): WorkspaceSyncCallbacks {
  return {
    selectedFiles: params.selectedFiles,
    nativeShellViews: params.nativeShellViews,
    resolveWorkspaceFilePath: params.resolveWorkspaceFilePath,
    getWorkspaceFiles: params.getWorkspaceFiles,
    asWorkspaceRelative: params.asWorkspaceRelative,
    postMessage: params.postMessage,
    openTrackedDiff: params.openTrackedDiff,
  };
}

/** Builds command-stream bindings from provider-owned runtime state. */
export function createCommandStreamBindings(params: {
  commandTerminalRegistry: ProviderCommandStreamBindings["commandTerminalRegistry"];
  activeShellSessions: ProviderCommandStreamBindings["activeShellSessions"];
  commandContextPath: ProviderCommandStreamBindings["commandContextPath"];
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  postMessage: (message: HostMessage) => Promise<void>;
}): ProviderCommandStreamBindings {
  return {
    commandTerminalRegistry: params.commandTerminalRegistry,
    activeShellSessions: params.activeShellSessions,
    commandContextPath: params.commandContextPath,
    appendLog: params.appendLog,
    postMessage: params.postMessage,
  };
}

/** Builds background-command completion bindings from provider-owned runtime state. */
export function createBackgroundCommandBindings(params: {
  commandContextPath: ProviderBackgroundCommandBindings["commandContextPath"];
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  asWorkspaceRelative: ProviderBackgroundCommandBindings["asWorkspaceRelative"];
  getIsRunning: ProviderBackgroundCommandBindings["getIsRunning"];
  getBackgroundCompletionRunning: ProviderBackgroundCommandBindings["getBackgroundCompletionRunning"];
  setBackgroundCompletionRunning: ProviderBackgroundCommandBindings["setBackgroundCompletionRunning"];
  getPendingBackgroundCompletions: () => readonly BackgroundCommandCompletion[];
  setPendingBackgroundCompletions: ProviderBackgroundCommandBindings["setPendingBackgroundCompletions"];
  setStatusText: ProviderBackgroundCommandBindings["setStatusText"];
  reportProgress: ProviderBackgroundCommandBindings["reportProgress"];
  postRunState: ProviderBackgroundCommandBindings["postRunState"];
  getEffectiveConfig: ProviderBackgroundCommandBindings["getEffectiveConfig"];
  getSelectedAgent: ProviderBackgroundCommandBindings["getSelectedAgent"];
  runInternalRepairTurn: ProviderBackgroundCommandBindings["runInternalRepairTurn"];
  runValidationAndReviewFlow: ProviderBackgroundCommandBindings["runValidationAndReviewFlow"];
}): ProviderBackgroundCommandBindings {
  return {
    commandContextPath: params.commandContextPath,
    appendLog: params.appendLog,
    asWorkspaceRelative: params.asWorkspaceRelative,
    getIsRunning: params.getIsRunning,
    getBackgroundCompletionRunning: params.getBackgroundCompletionRunning,
    setBackgroundCompletionRunning: params.setBackgroundCompletionRunning,
    getPendingBackgroundCompletions: params.getPendingBackgroundCompletions,
    setPendingBackgroundCompletions: params.setPendingBackgroundCompletions,
    setStatusText: params.setStatusText,
    reportProgress: params.reportProgress,
    postRunState: params.postRunState,
    getEffectiveConfig: params.getEffectiveConfig,
    getSelectedAgent: params.getSelectedAgent,
    runInternalRepairTurn: params.runInternalRepairTurn,
    runValidationAndReviewFlow: params.runValidationAndReviewFlow,
  };
}

/** Builds tracked-change bindings from provider-owned state and methods. */
export function createTrackedChangeBindings(params: {
  workspacePath: ProviderTrackedChangeBindings["workspacePath"];
  asWorkspaceRelative: ProviderTrackedChangeBindings["asWorkspaceRelative"];
  postMessage: ProviderTrackedChangeBindings["postMessage"];
  recordExternalEvent: ProviderTrackedChangeBindings["recordExternalEvent"];
  addMessage: ProviderTrackedChangeBindings["addMessage"];
  refreshWorkspaceFiles: ProviderTrackedChangeBindings["refreshWorkspaceFiles"];
}): ProviderTrackedChangeBindings {
  return {
    workspacePath: params.workspacePath,
    asWorkspaceRelative: params.asWorkspaceRelative,
    postMessage: params.postMessage,
    recordExternalEvent: params.recordExternalEvent,
    addMessage: params.addMessage,
    refreshWorkspaceFiles: params.refreshWorkspaceFiles,
  };
}

/** Builds approval-workflow callbacks from provider-owned state and methods. */
export function createApprovalWorkflowCallbacks(params: {
  pendingApprovalResolver: ((decision: ToolApprovalDecision) => void) | null;
  createRequestId: ApprovalWorkflowCallbacks["createRequestId"];
  appendLog: ApprovalWorkflowCallbacks["appendLog"];
  setPendingApprovalState: ApprovalWorkflowCallbacks["setPendingApprovalState"];
  updateWorkbenchChrome: ApprovalWorkflowCallbacks["updateWorkbenchChrome"];
  clearPendingApprovalState: ApprovalWorkflowCallbacks["clearPendingApprovalState"];
  postMessage: ApprovalWorkflowCallbacks["postMessage"];
  reveal: ApprovalWorkflowCallbacks["reveal"];
  showLogs: ApprovalWorkflowCallbacks["showLogs"];
}): ApprovalWorkflowCallbacks {
  return {
    hasPendingApproval: () => params.pendingApprovalResolver !== null,
    createRequestId: params.createRequestId,
    appendLog: params.appendLog,
    setPendingApprovalState: params.setPendingApprovalState,
    updateWorkbenchChrome: params.updateWorkbenchChrome,
    clearPendingApprovalState: params.clearPendingApprovalState,
    postMessage: params.postMessage,
    reveal: params.reveal,
    showLogs: params.showLogs,
  };
}

/** Builds runtime-log bindings from provider-owned state and methods. */
export function createRuntimeLogBindings(params: {
  createMessageId: ProviderRuntimeLogBindings["createMessageId"];
  runtimeLogs: readonly ProviderRuntimeLogBindings["runtimeLogs"][number][];
  setRuntimeLogs: ProviderRuntimeLogBindings["setRuntimeLogs"];
  debugLogPath: ProviderRuntimeLogBindings["debugLogPath"];
  outputChannel: OutputChannel;
  postMessage: ProviderRuntimeLogBindings["postMessage"];
}): ProviderRuntimeLogBindings {
  return {
    createMessageId: params.createMessageId,
    runtimeLogs: params.runtimeLogs,
    setRuntimeLogs: params.setRuntimeLogs,
    debugLogPath: params.debugLogPath,
    outputChannel: params.outputChannel,
    postMessage: params.postMessage,
  };
}
