/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Action-bundle builders extracted from GalaxyChatViewProvider.
 */

import * as vscode from "vscode";
import { persistProjectMetaPatch as persistHostedProjectMetaPatch } from "./session-lifecycle";
import { refreshProviderExtensionToolGroups as refreshHostedProviderExtensionToolGroups } from "./workspace-actions";
import { createProviderQualityActions as createHostedProviderQualityActions } from "./provider-quality-actions";
import { createProviderUtilityActions as createHostedProviderUtilityActions } from "./provider-utility-actions";
import { createProviderWorkspaceToolActions as createHostedProviderWorkspaceToolActions } from "./provider-workspace-tools";
import { createProviderWorkspaceSyncActions as createHostedProviderWorkspaceSyncActions } from "./provider-workspace-sync-actions";
import { createProviderViewActions as createHostedProviderViewActions } from "./provider-view-actions";
import { createProviderCommandActions as createHostedProviderCommandActions } from "./provider-command-actions";
import { createProviderRuntimeActions as createHostedProviderRuntimeActions } from "./provider-runtime-actions";
import { createProviderReviewActions as createHostedProviderReviewActions } from "./provider-review-actions";
import { createProviderMessageActions as createHostedProviderMessageActions } from "./provider-message-actions";
import { createProviderWorkbenchActions as createHostedProviderWorkbenchActions } from "./provider-workbench-actions";
import { buildPhasePlanItems as buildHostedPhasePlanItems } from "./workbench-state";
import { createProviderSessionActions as createHostedProviderSessionActions } from "./provider-session-actions";
import {
  getEffectiveConfigForWorkspace as getHostedEffectiveConfig,
} from "./effective-config";
import type { ProviderWorkspaceToolActions } from "../shared/workspace-tooling";
import type { ProviderReviewActions } from "../shared/provider-review-actions";
import type { ProviderMessageActions } from "../shared/provider-message-actions";
import type { ProviderWorkbenchActions } from "../shared/provider-workbench-actions";
import type { ProviderUtilityActions } from "../shared/provider-utility-actions";
import type { ProviderCommandActions } from "../shared/provider-command-actions";
import type { ProviderRuntimeActions } from "../shared/provider-runtime-actions";
import type { ProviderSessionActions } from "../shared/provider-session-actions";
import type { ProviderWorkspaceSyncActions } from "../shared/provider-workspace-sync-actions";
import type { ProviderViewActions } from "../shared/provider-view-actions";
import type { ProviderQualityGateBindings } from "../shared/quality-gates";
import type {
  AgentType,
  ApprovalRequestPayload,
  ChatMessage,
  ChangeSummary,
  ExtensionToolGroup,
  FileItem,
  LogEntry,
  PlanItem,
  QualityDetails,
  QualityPreferences,
  ToolApprovalDecision,
  ToolCapabilities,
  ToolToggles,
  WebviewMessage,
} from "../shared/protocol";
import type { ProviderQualityActions } from "../shared/quality-settings";
import type { ActiveShellSessionState, BackgroundCommandCompletion, GalaxyWorkbenchChrome, NativeShellViews } from "../shared/extension-host";
import type { HistoryManager } from "../context/entities/history-manager";
import type { ProjectMeta, ProjectStorageInfo } from "../context/entities/project-store";
import type { ChatRuntimeCallbacks } from "../shared/chat-runtime";
import type { ResetWorkspaceSessionOptions } from "../shared/workspace-reset";
import type { SessionChangeSummary } from "../shared/runtime";

/**
 * Builds actions for quality preference state, capability toggles, and sync to VS Code settings.
 */
export function buildProviderQualityActions(params: {
  projectStorage: ProjectStorageInfo;
  getExtensionToolGroups: () => readonly ExtensionToolGroup[];
  getQualityPreferences: () => QualityPreferences;
  setQualityPreferences: (next: QualityPreferences) => void;
  setToolCapabilities: (next: ToolCapabilities) => void;
  setToolToggles: (next: ToolToggles) => void;
  setExtensionToolToggles: (next: Readonly<Record<string, boolean>>) => void;
  postMessage: ProviderSessionActions["postMessage"];
  appendLog: ProviderRuntimeActions["appendLog"];
}): ProviderQualityActions {
  return createHostedProviderQualityActions(params);
}

/**
 * Builds actions for transcript updates, streaming buffers, and debug logging.
 */
export function buildProviderMessageActions(params: {
  debugLogPath: string;
  getMessages: () => ChatMessage[];
  appendMessage: (message: ChatMessage) => void;
  getSelectedAgent: () => AgentType;
  appendLog: ProviderRuntimeActions["appendLog"];
  appendTranscriptMessage: (message: ChatMessage) => void;
  sanitizeChatMessageForWebview: (message: ChatMessage) => ChatMessage;
  postMessage: ProviderSessionActions["postMessage"];
  getStreamingAssistant: () => string;
  setStreamingAssistant: (value: string) => void;
  getStreamingThinking: () => string;
  setStreamingThinking: (value: string) => void;
}): ProviderMessageActions {
  return createHostedProviderMessageActions({
    debugLogPath: params.debugLogPath,
    getMessages: params.getMessages,
    appendMessage: params.appendMessage,
    getSelectedAgent: params.getSelectedAgent,
    appendLog: params.appendLog,
    appendTranscriptMessage: params.appendTranscriptMessage,
    sanitizeChatMessageForWebview: params.sanitizeChatMessageForWebview,
    postMessage: params.postMessage,
    getStreamingAssistant: params.getStreamingAssistant,
    setStreamingAssistant: params.setStreamingAssistant,
    getStreamingThinking: params.getStreamingThinking,
    setStreamingThinking: params.setStreamingThinking,
  });
}

/**
 * Builds actions for status bar chrome, progress reporting, and workbench errors.
 */
export function buildProviderWorkbenchActions(params: {
  chrome: GalaxyWorkbenchChrome;
  getIsRunning: () => boolean;
  getStatusText: () => string;
  getSelectedAgent: () => AgentType;
  getPendingApprovalRequestId: () => string | null;
  getPendingApprovalTitle: () => string | null;
  getQualityPreferences: () => QualityPreferences;
  getProgressReporter: () => { report(value: { message?: string }): void } | null;
  postMessage: ProviderSessionActions["postMessage"];
  reveal: () => Promise<void>;
}): ProviderWorkbenchActions {
  return createHostedProviderWorkbenchActions({
    chrome: params.chrome,
    getIsRunning: params.getIsRunning,
    getStatusText: params.getStatusText,
    getSelectedAgent: params.getSelectedAgent,
    getPendingApprovalRequestId: params.getPendingApprovalRequestId,
    getPendingApprovalTitle: params.getPendingApprovalTitle,
    getQualityPreferences: params.getQualityPreferences,
    getProgressReporter: params.getProgressReporter,
    postMessage: async (message) => params.postMessage(message as never),
    reveal: params.reveal,
    showLogs: () => params.chrome.outputChannel.show(true),
  });
}

/**
 * Builds user-facing utility actions such as clear-history, logs, telemetry, and agent switching.
 */
export function buildProviderUtilityActions(params: {
  chrome: GalaxyWorkbenchChrome;
  workspaceName: string;
  workspacePath: string;
  getIsRunning: () => boolean;
  getSelectedAgent: () => AgentType;
  setSelectedAgent: (agentType: AgentType) => void;
  persistSelectedAgent: () => void;
  postSelectedAgentUpdate: () => Promise<void>;
  applyQualityPreferences: ProviderQualityActions["applyQualityPreferences"];
  resetWorkspaceSession: (opts?: ResetWorkspaceSessionOptions) => void;
  setStatusText: (statusText: string) => void;
  updateWorkbenchChrome: () => void;
  postInit: () => Promise<void>;
  appendLog: ProviderRuntimeActions["appendLog"];
}): ProviderUtilityActions {
  return createHostedProviderUtilityActions(params);
}

/**
 * Builds workspace tool actions such as file opening, diff reveal, and tool discovery helpers.
 */
export function buildProviderWorkspaceToolActions(params: {
  workspacePath: string;
  extensionId: string;
  getExtensionToolToggles: () => Readonly<Record<string, boolean>>;
  setExtensionToolGroups: (groups: readonly ExtensionToolGroup[]) => void;
  applyExtensionToolToggles: ProviderQualityActions["applyExtensionToolToggles"];
  asWorkspaceRelative: (filePath: string) => string;
  appendLog: ProviderRuntimeActions["appendLog"];
  postMessage: ProviderSessionActions["postMessage"];
}): ProviderWorkspaceToolActions {
  return createHostedProviderWorkspaceToolActions({
    ...params,
    postMessage: async (message) => params.postMessage(message as never),
  });
}

/**
 * Builds review-oriented actions for findings, apply or dismiss flows, and native review UI.
 */
export function buildProviderReviewActions(params: {
  workspacePath: string;
  projectStorage: ProjectStorageInfo;
  isRunning: () => boolean;
  postMessage: ProviderSessionActions["postMessage"];
  clearStreamingBuffers: () => void;
  setRunningState: (isRunning: boolean, statusText: string) => void;
  postRunState: () => void;
  getEffectiveConfig: () => ReturnType<typeof getHostedEffectiveConfig>;
  getSelectedAgent: () => AgentType;
  runInternalRepairTurn: ProviderQualityGateBindings["runInternalRepairTurn"];
  persistProjectMetaPatch: (mutate: (meta: ProjectMeta | null) => ProjectMeta | null) => void;
  updateQualityDetails: ProviderRuntimeActions["updateQualityDetails"];
  runValidationAndReviewFlow: (agentType: AgentType) => Promise<void>;
  getSummary: () => SessionChangeSummary;
  asWorkspaceRelative: (filePath: string) => string;
  createMessageId: () => string;
  handleMessage: (message: WebviewMessage) => Promise<void>;
  refreshWorkspaceFiles: () => Promise<void>;
}): ProviderReviewActions {
  return createHostedProviderReviewActions(params as never);
}

/**
 * Builds command-stream and background-completion actions for shell-driven tool runs.
 */
export function buildProviderCommandActions(params: {
  commandTerminalRegistry: import("../runtime/command-terminal-registry").CommandTerminalRegistry;
  activeShellSessions: Map<string, ActiveShellSessionState>;
  commandContextPath: string;
  appendLog: ProviderRuntimeActions["appendLog"];
  postMessage: ProviderSessionActions["postMessage"];
  asWorkspaceRelative: (filePath: string) => string;
  getIsRunning: () => boolean;
  getBackgroundCompletionRunning: () => boolean;
  setBackgroundCompletionRunning: (value: boolean) => void;
  getPendingBackgroundCompletions: () => BackgroundCommandCompletion[];
  setPendingBackgroundCompletions: (completions: readonly BackgroundCommandCompletion[]) => void;
  setStatusText: (value: string) => void;
  reportProgress: (statusText: string) => void;
  postRunState: () => void;
  getEffectiveConfig: () => ReturnType<typeof getHostedEffectiveConfig>;
  getSelectedAgent: () => AgentType;
  runInternalRepairTurn: ProviderQualityGateBindings["runInternalRepairTurn"];
  runValidationAndReviewFlow: (agentType: AgentType) => Promise<void>;
}): ProviderCommandActions {
  return createHostedProviderCommandActions(params as never);
}

/**
 * Builds runtime actions for approvals, runtime logs, tracked changes, and quality updates.
 */
export function buildProviderRuntimeActions(params: {
  workspacePath: string;
  debugLogPath: string;
  outputChannel: GalaxyWorkbenchChrome["outputChannel"];
  createMessageId: () => string;
  getRuntimeLogs: () => readonly LogEntry[];
  setRuntimeLogs: (runtimeLogs: readonly LogEntry[]) => void;
  asWorkspaceRelative: (filePath: string) => string;
  postMessage: ProviderSessionActions["postMessage"];
  recordExternalEvent: HistoryManager["recordExternalEvent"];
  addMessage: (message: ChatMessage) => Promise<void>;
  refreshWorkspaceFiles: () => Promise<void>;
  hasPendingApproval: () => boolean;
  setPendingApprovalState: (state: {
    requestId: string;
    title: string;
    payload: ApprovalRequestPayload;
    resolver?: (decision: ToolApprovalDecision) => void;
  }) => void;
  updateWorkbenchChrome: () => void;
  clearPendingApprovalState: () => void;
  reveal: () => Promise<void>;
  showLogs: () => void;
  getQualityDetails: () => QualityDetails;
  setQualityDetails: (qualityDetails: QualityDetails) => void;
}): ProviderRuntimeActions {
  return createHostedProviderRuntimeActions(params);
}

/**
 * Builds session-facing actions used to assemble and broadcast the current provider state.
 */
export function buildProviderSessionActions(params: {
  projectStorage: ProjectStorageInfo;
  selectedFiles: Set<string>;
  updateWorkbenchChrome: () => void;
  refreshExtensionToolGroups: () => void;
  buildChangeSummaryPayload: () => ChangeSummary;
  refreshNativeShellViews: (files?: readonly FileItem[], changeSummary?: ChangeSummary) => Promise<void>;
  getMessages: () => readonly ChatMessage[];
  getHasOlderMessages: () => boolean;
  getSelectedAgent: () => AgentType;
  getIsRunning: () => boolean;
  getStatusText: () => string;
  getPlanItems: () => readonly PlanItem[];
  getRuntimeLogs: () => readonly LogEntry[];
  getQualityDetails: () => QualityDetails;
  getQualityPreferences: () => QualityPreferences;
  getToolCapabilities: () => ToolCapabilities;
  getToolToggles: () => ToolToggles;
  getExtensionToolGroups: () => readonly ExtensionToolGroup[];
  getExtensionToolToggles: () => Readonly<Record<string, boolean>>;
  getStreamingAssistant: () => string;
  getStreamingThinking: () => string;
  getActiveShellSessions: () => readonly ActiveShellSessionState[];
  getApprovalRequest: () => ApprovalRequestPayload | null;
  sanitizeChatMessageForWebview: (message: ChatMessage) => ChatMessage;
  getSidebarWebview: () => vscode.Webview | null;
  getPanelWebview: () => vscode.Webview | null;
  asWorkspaceRelative: (filePath: string) => string;
  getEffectiveConfig: () => ReturnType<typeof getHostedEffectiveConfig>;
  setStatusText: (statusText: string) => void;
  appendLog: ProviderRuntimeActions["appendLog"];
  extensionId: string;
  setExtensionToolGroups: (groups: readonly ExtensionToolGroup[]) => void;
}): ProviderSessionActions {
  return createHostedProviderSessionActions({
    projectStorage: params.projectStorage,
    selectedFiles: params.selectedFiles,
    updateWorkbenchChrome: params.updateWorkbenchChrome,
    refreshExtensionToolGroups: () =>
      refreshHostedProviderExtensionToolGroups({
        extensionId: params.extensionId,
        setExtensionToolGroups: params.setExtensionToolGroups,
      }),
    buildChangeSummaryPayload: params.buildChangeSummaryPayload,
    refreshNativeShellViews: params.refreshNativeShellViews,
    getMessages: params.getMessages,
    getHasOlderMessages: params.getHasOlderMessages,
    getSelectedAgent: params.getSelectedAgent,
    getIsRunning: params.getIsRunning,
    getStatusText: params.getStatusText,
    getPlanItems: params.getPlanItems,
    getRuntimeLogs: params.getRuntimeLogs,
    getQualityDetails: params.getQualityDetails,
    getQualityPreferences: params.getQualityPreferences,
    getToolCapabilities: params.getToolCapabilities,
    getToolToggles: params.getToolToggles,
    getExtensionToolGroups: params.getExtensionToolGroups,
    getExtensionToolToggles: params.getExtensionToolToggles,
    getStreamingAssistant: params.getStreamingAssistant,
    getStreamingThinking: params.getStreamingThinking,
    getActiveShellSessions: params.getActiveShellSessions,
    getApprovalRequest: params.getApprovalRequest,
    sanitizeChatMessageForWebview: params.sanitizeChatMessageForWebview,
    getSidebarWebview: params.getSidebarWebview,
    getPanelWebview: params.getPanelWebview,
    asWorkspaceRelative: params.asWorkspaceRelative,
    getEffectiveConfig: params.getEffectiveConfig,
    setStatusText: params.setStatusText,
    appendLog: params.appendLog,
  });
}

/**
 * Builds workspace synchronization actions for file selection, summaries, and native tree views.
 */
export function buildProviderWorkspaceSyncActions(params: {
  selectedFiles: Set<string>;
  nativeShellViews: NativeShellViews | null;
  resolveWorkspaceFilePath: (filePath: string) => string;
  getWorkspaceFiles: () => Promise<readonly FileItem[]>;
  asWorkspaceRelative: (filePath: string) => string;
  postMessage: ProviderSessionActions["postMessage"];
  openTrackedDiff: ProviderWorkspaceToolActions["openTrackedDiff"];
}): ProviderWorkspaceSyncActions {
  return createHostedProviderWorkspaceSyncActions(params);
}

/**
 * Builds sidebar and panel lifecycle actions for creating and revealing Galaxy webviews.
 */
export function buildProviderViewActions(params: {
  extensionUri: vscode.Uri;
  getPanel: () => vscode.WebviewPanel | null;
  setPanel: (panel: vscode.WebviewPanel | null) => void;
  setView: (view: vscode.WebviewView | null) => void;
  onMessage: (message: WebviewMessage) => void;
  postInit: () => Promise<void>;
  getView: () => vscode.WebviewView | null;
  executeRevealSidebar: () => Promise<void>;
}): ProviderViewActions {
  return createHostedProviderViewActions(params);
}

/**
 * Clears the active tool approval state after the user responds or a reset occurs.
 */
export function clearProviderPendingApprovalState(params: {
  setPendingApprovalResolver: (resolver: ((decision: ToolApprovalDecision) => void) | null) => void;
  setPendingApprovalRequestId: (requestId: string | null) => void;
  setPendingApprovalTitle: (title: string | null) => void;
  setPendingApprovalPayload: (payload: ApprovalRequestPayload | null) => void;
  updateWorkbenchChrome: () => void;
}): void {
  params.setPendingApprovalResolver(null);
  params.setPendingApprovalRequestId(null);
  params.setPendingApprovalTitle(null);
  params.setPendingApprovalPayload(null);
  params.updateWorkbenchChrome();
}
