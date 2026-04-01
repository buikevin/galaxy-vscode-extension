/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Bootstrap helpers for GalaxyChatViewProvider state and action-bundle wiring.
 */

import * as vscode from "vscode";
import { loadConfig } from "../config/manager";
import { DEFAULT_CONFIG, GALAXY_VIEW_CONTAINER_ID, SELECTED_AGENT_STORAGE_KEY } from "../shared/constants";
import type { ApprovalRequestPayload, AgentType, ChatMessage, ExtensionToolGroup, LogEntry, QualityDetails, QualityPreferences, ToolApprovalDecision, ToolCapabilities, ToolToggles, WebviewMessage } from "../shared/protocol";
import { createHistoryManager } from "../context/history-manager";
import { loadNotes } from "../context/notes";
import { ensureProjectStorage, getProjectStorageInfo, loadProjectMeta, saveProjectMeta } from "../context/project-store";
import { CommandTerminalRegistry } from "../runtime/command-terminal-registry";
import { getSessionChangeSummary } from "../runtime/session-tracker";
import type { HistoryManager } from "../context/entities/history-manager";
import type { ProjectStorageInfo } from "../context/entities/project-store";
import type { BackgroundCommandCompletion, GalaxyWorkbenchChrome, NativeShellViews } from "../shared/extension-host";
import type { ProviderCommandActions } from "../shared/provider-command-actions";
import type { ProviderMessageActions } from "../shared/provider-message-actions";
import type { ProviderQualityActions } from "../shared/quality-settings";
import type { ProviderReviewActions } from "../shared/provider-review-actions";
import type { ProviderRuntimeActions } from "../shared/provider-runtime-actions";
import type { ProviderSessionActions } from "../shared/provider-session-actions";
import type { ProviderUtilityActions } from "../shared/provider-utility-actions";
import type { ProviderViewActions } from "../shared/provider-view-actions";
import type { ProviderWorkbenchActions } from "../shared/provider-workbench-actions";
import type { ProviderWorkspaceSyncActions } from "../shared/provider-workspace-sync-actions";
import type { ProviderWorkspaceToolActions } from "../shared/workspace-tooling";
import type { WebviewActionCallbacks } from "../shared/webview-actions";
import type { ChatRuntimeCallbacks } from "../shared/chat-runtime";
import { refreshExtensionToolGroups as refreshExtensionToolCatalog } from "./extension-tool-catalog";
import {
  buildContinueMessage as buildHostedContinueMessage,
  shouldGateAssistantFinalMessage as shouldHostedGateAssistantFinalMessage,
} from "./chat-runtime-state";
import { buildPhasePlanItems as buildHostedPhasePlanItems } from "./workbench-state";
import { loadSelectedAgent as loadHostedSelectedAgent, persistSelectedAgent as persistHostedSelectedAgent } from "./workbench-runtime";
import { asWorkspaceRelativePath as asHostedWorkspaceRelativePath, getWorkspaceName as getHostedWorkspaceName, resolveStorageWorkspacePath as resolveHostedStorageWorkspacePath } from "./session-sync";
import { appendTranscriptMessage as appendHostedTranscriptMessage, persistProjectMetaPatch as persistHostedProjectMetaPatch } from "./session-lifecycle";
import { refreshProviderExtensionToolGroups as refreshHostedProviderExtensionToolGroups } from "./workspace-actions";
import { createProviderWebviewActionCallbacks as createHostedProviderWebviewActionCallbacks } from "./webview-actions";
import {
  getEffectiveConfigForWorkspace as getHostedEffectiveConfig,
  getQualityPreferencesForWorkspace,
  getWorkspaceExtensionToolToggles,
  getWorkspaceToolCapabilities,
  getWorkspaceToolToggles,
} from "./effective-config";
import { createMessageId, isAgentType, sanitizeChatMessageForWebview } from "./utils";
import {
  buildProviderCommandActions,
  buildProviderMessageActions,
  buildProviderQualityActions,
  buildProviderReviewActions,
  buildProviderRuntimeActions,
  buildProviderSessionActions,
  buildProviderUtilityActions,
  buildProviderViewActions,
  buildProviderWorkbenchActions,
  buildProviderWorkspaceSyncActions,
  buildProviderWorkspaceToolActions,
  buildProviderChatRuntimeCallbacks,
} from "./provider-internal";

/**
 * Mutable provider shape required by the external bootstrap helper.
 *
 * The class instance is cast to this internal bridge so the constructor can stay small
 * while the heavy bootstrap logic lives in one separate module.
 */
export type GalaxyChatViewProviderBootstrapTarget = {
  context: vscode.ExtensionContext;
  chrome: GalaxyWorkbenchChrome;
  workspacePath: string;
  projectStorage: ProjectStorageInfo;
  historyManager: HistoryManager;
  selectedFiles: Set<string>;
  nativeShellViews: NativeShellViews | null;
  isRunning: boolean;
  statusText: string;
  messages: ChatMessage[];
  selectedAgent: AgentType;
  pendingApprovalRequestId: string | null;
  pendingApprovalResolver: ((decision: ToolApprovalDecision) => void) | null;
  pendingApprovalTitle: string | null;
  pendingApprovalPayload: ApprovalRequestPayload | null;
  progressReporter: vscode.Progress<{ message?: string }> | null;
  runtimeLogs: LogEntry[];
  qualityDetails: QualityDetails;
  qualityPreferences: QualityPreferences;
  toolCapabilities: ToolCapabilities;
  toolToggles: ToolToggles;
  extensionToolGroups: readonly ExtensionToolGroup[];
  extensionToolToggles: Readonly<Record<string, boolean>>;
  view: vscode.WebviewView | null;
  panel: vscode.WebviewPanel | null;
  activeShellSessions: Map<string, import("../shared/extension-host").ActiveShellSessionState>;
  commandTerminalRegistry: CommandTerminalRegistry;
  streamingAssistant: string;
  streamingThinking: string;
  pendingBackgroundCompletions: BackgroundCommandCompletion[];
  backgroundCompletionRunning: boolean;
  qualityActions: ProviderQualityActions;
  messageActions: ProviderMessageActions;
  workbenchActions: ProviderWorkbenchActions;
  utilityActions: ProviderUtilityActions;
  workspaceToolActions: ProviderWorkspaceToolActions;
  reviewActions: ProviderReviewActions;
  commandActions: ProviderCommandActions;
  runtimeActions: ProviderRuntimeActions;
  sessionActions: ProviderSessionActions;
  workspaceSyncActions: ProviderWorkspaceSyncActions;
  viewActions: ProviderViewActions;
  webviewActionCallbacks: WebviewActionCallbacks;
  chatRuntimeCallbacks: ChatRuntimeCallbacks;
  reveal(): Promise<void>;
  handleMessage(message: WebviewMessage): Promise<void>;
  runInternalRepairTurn(
    opts: Readonly<{
      config: ReturnType<typeof loadConfig>;
      agentType: AgentType;
      userMessage: ChatMessage;
      contextNote?: string;
      emptyContinueAttempt?: number;
    }>,
  ): Promise<Readonly<{ hadError: boolean; filesWritten: readonly string[] }>>;
  runValidationAndReviewFlow(
    agentType: AgentType,
  ): Promise<Readonly<{ passed: boolean; repaired: boolean }>>;
  resetWorkspaceSession(
    opts?: import("../shared/workspace-reset").ResetWorkspaceSessionOptions,
  ): void;
  clearPendingApprovalState(): void;
};

/** Initializes provider state, config-derived preferences, and all cached action bundles. */
export function initializeGalaxyChatViewProvider(
  provider: GalaxyChatViewProviderBootstrapTarget,
  context: vscode.ExtensionContext,
  chrome: GalaxyWorkbenchChrome,
): void {
  provider.context = context;
  provider.chrome = chrome;
  provider.workspacePath = resolveHostedStorageWorkspacePath();
  provider.projectStorage = getProjectStorageInfo(provider.workspacePath);
  ensureProjectStorage(provider.projectStorage);
  const projectMeta = saveProjectMeta(
    provider.projectStorage,
    loadProjectMeta(provider.projectStorage),
  );
  const config = loadConfig();
  provider.extensionToolGroups = refreshExtensionToolCatalog(context.extension.id);
  provider.toolCapabilities = getWorkspaceToolCapabilities(config, projectMeta);
  provider.toolToggles = getWorkspaceToolToggles(config, projectMeta);
  provider.extensionToolToggles = getWorkspaceExtensionToolToggles(
    config,
    projectMeta,
    provider.extensionToolGroups,
  );
  provider.qualityPreferences = getQualityPreferencesForWorkspace(
    config,
    provider.toolCapabilities,
  );
  provider.historyManager = createHistoryManager({
    workspacePath: provider.workspacePath,
    notes: loadNotes(),
  });
  provider.selectedAgent = loadHostedSelectedAgent(
    provider.context.workspaceState,
    SELECTED_AGENT_STORAGE_KEY,
    isAgentType,
  );

  provider.qualityActions = buildProviderQualityActions({
    projectStorage: provider.projectStorage,
    getExtensionToolGroups: () => provider.extensionToolGroups,
    getQualityPreferences: () => provider.qualityPreferences,
    setQualityPreferences: (next) => {
      provider.qualityPreferences = next;
    },
    setToolCapabilities: (next) => {
      provider.toolCapabilities = next;
    },
    setToolToggles: (next) => {
      provider.toolToggles = next;
    },
    setExtensionToolToggles: (next) => {
      provider.extensionToolToggles = next;
    },
    postMessage: (message) => provider.sessionActions.postMessage(message),
    appendLog: (kind, text) => provider.runtimeActions.appendLog(kind, text),
  });
  provider.messageActions = buildProviderMessageActions({
    debugLogPath: provider.projectStorage.debugLogPath,
    getMessages: () => provider.messages,
    appendMessage: (message) => {
      provider.messages.push(message);
    },
    getSelectedAgent: () => provider.selectedAgent,
    appendLog: (kind, text) => provider.runtimeActions.appendLog(kind, text),
    appendTranscriptMessage: (message) =>
      appendHostedTranscriptMessage(provider.projectStorage, message),
    sanitizeChatMessageForWebview: (message) =>
      sanitizeChatMessageForWebview(message),
    postMessage: (message) => provider.sessionActions.postMessage(message),
    getStreamingAssistant: () => provider.streamingAssistant,
    setStreamingAssistant: (value) => {
      provider.streamingAssistant = value;
    },
    getStreamingThinking: () => provider.streamingThinking,
    setStreamingThinking: (value) => {
      provider.streamingThinking = value;
    },
  });
  provider.workbenchActions = buildProviderWorkbenchActions({
    chrome: provider.chrome,
    getIsRunning: () => provider.isRunning,
    getStatusText: () => provider.statusText,
    getSelectedAgent: () => provider.selectedAgent,
    getPendingApprovalRequestId: () => provider.pendingApprovalRequestId,
    getPendingApprovalTitle: () => provider.pendingApprovalTitle,
    getQualityPreferences: () => provider.qualityPreferences,
    getProgressReporter: () => provider.progressReporter,
    postMessage: (message) => provider.sessionActions.postMessage(message),
    reveal: () => provider.reveal(),
  });
  provider.utilityActions = buildProviderUtilityActions({
    chrome: provider.chrome,
    workspaceName: getHostedWorkspaceName(),
    workspacePath: provider.workspacePath,
    getIsRunning: () => provider.isRunning,
    getSelectedAgent: () => provider.selectedAgent,
    setSelectedAgent: (agentType) => {
      provider.selectedAgent = agentType;
    },
    persistSelectedAgent: () => {
      persistHostedSelectedAgent(
        provider.context.workspaceState,
        SELECTED_AGENT_STORAGE_KEY,
        provider.selectedAgent,
      );
    },
    postSelectedAgentUpdate: () => provider.workbenchActions.postSelectedAgentUpdate(),
    applyQualityPreferences: provider.qualityActions.applyQualityPreferences,
    resetWorkspaceSession: (opts) => provider.resetWorkspaceSession(opts),
    setStatusText: (statusText) => {
      provider.statusText = statusText;
    },
    updateWorkbenchChrome: () => provider.workbenchActions.updateWorkbenchChrome(),
    postInit: () => provider.sessionActions.postInit(),
    appendLog: (kind, text) => provider.runtimeActions.appendLog(kind, text),
  });
  provider.workspaceToolActions = buildProviderWorkspaceToolActions({
    workspacePath: provider.workspacePath,
    extensionId: provider.context.extension.id,
    getExtensionToolToggles: () => provider.extensionToolToggles,
    setExtensionToolGroups: (groups) => {
      provider.extensionToolGroups = groups;
    },
    applyExtensionToolToggles: provider.qualityActions.applyExtensionToolToggles,
    asWorkspaceRelative: asHostedWorkspaceRelativePath,
    appendLog: (kind, text) => provider.runtimeActions.appendLog(kind, text),
    postMessage: (message) => provider.sessionActions.postMessage(message),
  });
  provider.reviewActions = buildProviderReviewActions({
    workspacePath: provider.workspacePath,
    projectStorage: provider.projectStorage,
    isRunning: () => provider.isRunning,
    postMessage: (message) => provider.sessionActions.postMessage(message),
    clearStreamingBuffers: () => provider.messageActions.clearStreamingBuffers(),
    setRunningState: (isRunning, statusText) => {
      provider.isRunning = isRunning;
      provider.statusText = statusText;
    },
    postRunState: () => provider.workbenchActions.postRunState(),
    getEffectiveConfig: () => provider.sessionActions.getEffectiveConfig(),
    getSelectedAgent: () => provider.selectedAgent,
    runInternalRepairTurn: (request) => provider.runInternalRepairTurn(request),
    persistProjectMetaPatch: (mutate) => {
      persistHostedProjectMetaPatch({
        projectStorage: provider.projectStorage,
        mutate,
      });
    },
    updateQualityDetails: (update) => provider.runtimeActions.updateQualityDetails(update),
    runValidationAndReviewFlow: async (agentType) => {
      await provider.runValidationAndReviewFlow(agentType);
    },
    getSummary: () => getSessionChangeSummary(),
    asWorkspaceRelative: asHostedWorkspaceRelativePath,
    createMessageId,
    handleMessage: async (message) => provider.handleMessage(message),
    refreshWorkspaceFiles: async () => provider.workspaceSyncActions.refreshWorkspaceFiles(),
  });
  provider.commandActions = buildProviderCommandActions({
    commandTerminalRegistry: provider.commandTerminalRegistry,
    activeShellSessions: provider.activeShellSessions,
    commandContextPath: provider.projectStorage.commandContextPath,
    appendLog: (kind, text) => provider.runtimeActions.appendLog(kind, text),
    postMessage: (message) => provider.sessionActions.postMessage(message),
    asWorkspaceRelative: asHostedWorkspaceRelativePath,
    getIsRunning: () => provider.isRunning,
    getBackgroundCompletionRunning: () => provider.backgroundCompletionRunning,
    setBackgroundCompletionRunning: (value) => {
      provider.backgroundCompletionRunning = value;
    },
    getPendingBackgroundCompletions: () => provider.pendingBackgroundCompletions,
    setPendingBackgroundCompletions: (completions) => {
      provider.pendingBackgroundCompletions = [...completions];
    },
    setStatusText: (value) => {
      provider.statusText = value;
    },
    reportProgress: (statusText) => provider.workbenchActions.reportProgress(statusText),
    postRunState: () => provider.workbenchActions.postRunState(),
    getEffectiveConfig: () => provider.sessionActions.getEffectiveConfig(),
    getSelectedAgent: () => provider.selectedAgent,
    runInternalRepairTurn: (request) => provider.runInternalRepairTurn(request),
    runValidationAndReviewFlow: async (agentType) => {
      await provider.runValidationAndReviewFlow(agentType);
    },
  });
  provider.runtimeActions = buildProviderRuntimeActions({
    workspacePath: provider.workspacePath,
    debugLogPath: provider.projectStorage.debugLogPath,
    outputChannel: provider.chrome.outputChannel,
    createMessageId,
    getRuntimeLogs: () => provider.runtimeLogs,
    setRuntimeLogs: (runtimeLogs) => {
      provider.runtimeLogs = [...runtimeLogs];
    },
    asWorkspaceRelative: asHostedWorkspaceRelativePath,
    postMessage: (message) => provider.sessionActions.postMessage(message),
    recordExternalEvent: (summaryText, filePaths) => {
      provider.historyManager.recordExternalEvent(summaryText, filePaths);
    },
    addMessage: async (message) => provider.messageActions.addMessage(message),
    refreshWorkspaceFiles: async () => provider.workspaceSyncActions.refreshWorkspaceFiles(),
    hasPendingApproval: () => provider.pendingApprovalResolver !== null,
    setPendingApprovalState: ({ requestId, title, payload, resolver }) => {
      provider.pendingApprovalRequestId = requestId;
      provider.pendingApprovalTitle = title;
      provider.pendingApprovalPayload = payload;
      if (resolver) {
        provider.pendingApprovalResolver = resolver;
      }
    },
    updateWorkbenchChrome: () => provider.workbenchActions.updateWorkbenchChrome(),
    clearPendingApprovalState: () => provider.clearPendingApprovalState(),
    reveal: () => provider.reveal(),
    showLogs: () => provider.chrome.outputChannel.show(true),
    getQualityDetails: () => provider.qualityDetails,
    setQualityDetails: (qualityDetails) => {
      provider.qualityDetails = qualityDetails;
    },
  });
  provider.sessionActions = buildProviderSessionActions({
    projectStorage: provider.projectStorage,
    selectedFiles: provider.selectedFiles,
    updateWorkbenchChrome: () => provider.workbenchActions.updateWorkbenchChrome(),
    refreshExtensionToolGroups: () =>
      refreshHostedProviderExtensionToolGroups({
        extensionId: provider.context.extension.id,
        setExtensionToolGroups: (groups) => {
          provider.extensionToolGroups = groups;
        },
      }),
    buildChangeSummaryPayload: () => provider.workspaceSyncActions.buildChangeSummaryPayload(),
    refreshNativeShellViews: async (files, changeSummary) =>
      provider.workspaceSyncActions.refreshNativeShellViews(files, changeSummary),
    getMessages: () => provider.messages,
    getSelectedAgent: () => provider.selectedAgent,
    getIsRunning: () => provider.isRunning,
    getStatusText: () => provider.statusText,
    getPlanItems: () => buildHostedPhasePlanItems(),
    getRuntimeLogs: () => provider.runtimeLogs,
    getQualityDetails: () => provider.qualityDetails,
    getQualityPreferences: () => provider.qualityPreferences,
    getToolCapabilities: () => provider.toolCapabilities,
    getToolToggles: () => provider.toolToggles,
    getExtensionToolGroups: () => provider.extensionToolGroups,
    getExtensionToolToggles: () => provider.extensionToolToggles,
    getStreamingAssistant: () => provider.streamingAssistant,
    getStreamingThinking: () => provider.streamingThinking,
    getActiveShellSessions: () => [...provider.activeShellSessions.values()],
    getApprovalRequest: () => provider.pendingApprovalPayload,
    sanitizeChatMessageForWebview: (message) => sanitizeChatMessageForWebview(message),
    getSidebarWebview: () => provider.view?.webview ?? null,
    getPanelWebview: () => provider.panel?.webview ?? null,
    asWorkspaceRelative: asHostedWorkspaceRelativePath,
    getEffectiveConfig: () =>
      getHostedEffectiveConfig(
        provider.projectStorage,
        provider.qualityPreferences,
        provider.extensionToolGroups,
      ),
    setStatusText: (statusText) => {
      provider.statusText = statusText;
    },
    appendLog: (kind, text) => provider.runtimeActions.appendLog(kind, text),
    extensionId: provider.context.extension.id,
    setExtensionToolGroups: (groups) => {
      provider.extensionToolGroups = groups;
    },
  });
  provider.workspaceSyncActions = buildProviderWorkspaceSyncActions({
    selectedFiles: provider.selectedFiles,
    nativeShellViews: provider.nativeShellViews,
    resolveWorkspaceFilePath: (filePath) =>
      provider.workspaceToolActions.resolveWorkspaceFilePath(filePath),
    getWorkspaceFiles: () => provider.sessionActions.getWorkspaceFiles(),
    asWorkspaceRelative: asHostedWorkspaceRelativePath,
    postMessage: (message) => provider.sessionActions.postMessage(message),
    openTrackedDiff: provider.workspaceToolActions.openTrackedDiff,
  });
  provider.viewActions = buildProviderViewActions({
    extensionUri: provider.context.extensionUri,
    getPanel: () => provider.panel,
    setPanel: (panel) => {
      provider.panel = panel;
    },
    setView: (view) => {
      provider.view = view;
    },
    onMessage: (message) => {
      void provider.handleMessage(message);
    },
    postInit: () => provider.sessionActions.postInit(),
    getView: () => provider.view,
    executeRevealSidebar: async () => {
      await vscode.commands.executeCommand(
        `workbench.view.extension.${GALAXY_VIEW_CONTAINER_ID}`,
      );
    },
  });
  provider.webviewActionCallbacks = createHostedProviderWebviewActionCallbacks({
    workspacePath: provider.workspacePath,
    pendingApprovalRequestId: provider.pendingApprovalRequestId,
    pendingApprovalResolver: provider.pendingApprovalResolver,
    postInit: () => provider.sessionActions.postInit(),
    updateContextFileSelection: (updates) =>
      provider.workspaceSyncActions.updateContextFileSelection(updates),
    openWorkspaceFile: provider.workspaceToolActions.openWorkspaceFile,
    openTrackedDiff: provider.workspaceToolActions.openTrackedDiff,
    revealShellTerminal: (toolCallId) =>
      provider.commandActions.revealShellTerminal(toolCallId),
    appendLog: provider.runtimeActions.appendLog,
    clearPendingApprovalState: () => provider.clearPendingApprovalState(),
    applyQualityPreferences: provider.qualityActions.applyQualityPreferences,
    applyToolCapabilities: provider.qualityActions.applyToolCapabilities,
    applyToolToggles: provider.qualityActions.applyToolToggles,
    applyExtensionToolToggles: provider.qualityActions.applyExtensionToolToggles,
    handleComposerCommand: (commandId) =>
      provider.utilityActions.handleComposerCommand(commandId),
    postMessage: (hostMessage) => provider.sessionActions.postMessage(hostMessage),
    openNativeReview: provider.reviewActions.openNativeReview,
    dismissReviewFinding: async (findingId) => {
      await provider.reviewActions.dismissReviewFindingTool(findingId);
    },
    applyReviewFinding: async (findingId) => {
      await provider.reviewActions.applyReviewFinding(findingId);
    },
    revertAllTrackedChanges: provider.runtimeActions.revertAllTrackedChanges,
    revertTrackedFileChange: provider.runtimeActions.revertTrackedFileChange,
  });
  provider.chatRuntimeCallbacks = buildProviderChatRuntimeCallbacks({
    workspacePath: provider.workspacePath,
    historyManager: provider.historyManager,
    addMessage: async (message) => provider.messageActions.addMessage(message),
    appendLog: provider.runtimeActions.appendLog,
    setStatusText: (statusText) => {
      provider.statusText = statusText;
    },
    reportProgress: (statusText) => provider.workbenchActions.reportProgress(statusText),
    postRunState: () => provider.workbenchActions.postRunState(),
    postMessage: (message) => provider.sessionActions.postMessage(message),
    emitAssistantStream: async (delta) => provider.messageActions.emitAssistantStream(delta),
    emitAssistantThinking: async (delta) => provider.messageActions.emitAssistantThinking(delta),
    debugChatMessage: (message) => provider.messageActions.debugChatMessage(message),
    requestToolApproval: provider.runtimeActions.requestToolApproval,
    showWorkbenchError: (message) => provider.workbenchActions.showWorkbenchError(message),
    writeDebug: (scope, message) => provider.messageActions.writeDebug(scope, message),
    writeDebugBlock: (scope, content) => provider.messageActions.writeDebugBlock(scope, content),
    shouldGateAssistantFinalMessage: (filesWritten) =>
      shouldHostedGateAssistantFinalMessage(provider.qualityPreferences, filesWritten),
    getEffectiveConfig: () => provider.sessionActions.getEffectiveConfig(),
    runValidationAndReviewFlow: async (agentType) =>
      provider.runValidationAndReviewFlow(agentType),
    hasStreamingBuffers: () =>
      provider.streamingAssistant.length > 0 || provider.streamingThinking.length > 0,
    clearStreamingBuffers: () => provider.messageActions.clearStreamingBuffers(),
    postInit: () => provider.sessionActions.postInit(),
    buildContinueMessage: (opts) => buildHostedContinueMessage(opts),
    tools: {
      revealFile: provider.workspaceToolActions.revealFile,
      refreshWorkspaceFiles: async () => provider.workspaceSyncActions.refreshWorkspaceFiles(),
      openTrackedDiff: provider.workspaceToolActions.openTrackedDiffTool,
      showProblems: provider.workspaceToolActions.showProblemsTool,
      workspaceSearch: provider.workspaceToolActions.workspaceSearchTool,
      findReferences: provider.workspaceToolActions.findReferencesTool,
      executeExtensionCommand: provider.workspaceToolActions.executeExtensionCommandTool,
      invokeLanguageModelTool: provider.workspaceToolActions.invokeLanguageModelToolTool,
      searchExtensionTools: provider.workspaceToolActions.searchExtensionToolsTool,
      activateExtensionTools: provider.workspaceToolActions.activateExtensionToolsTool,
      getLatestTestFailure: provider.reviewActions.getLatestTestFailureTool,
      getLatestReviewFindings: provider.reviewActions.getLatestReviewFindingsTool,
      getNextReviewFinding: provider.reviewActions.getNextReviewFindingTool,
      dismissReviewFinding: provider.reviewActions.dismissReviewFindingTool,
      onProjectCommandStart: provider.commandActions.emitCommandStreamStart,
      onProjectCommandChunk: provider.commandActions.emitCommandStreamChunk,
      onProjectCommandEnd: provider.commandActions.emitCommandStreamEnd,
      onProjectCommandComplete: provider.commandActions.handleBackgroundCommandCompletion,
    },
  });
  provider.messages = provider.sessionActions.loadInitialMessages();
  provider.workbenchActions.updateWorkbenchChrome();
}
