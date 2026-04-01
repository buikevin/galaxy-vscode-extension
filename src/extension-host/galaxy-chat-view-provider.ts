/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Galaxy chat view provider extracted from the extension entrypoint to keep extension.ts focused on activation only.
 */

import * as vscode from "vscode";
import { loadConfig } from "../config/manager";
import { DEFAULT_CONFIG, SELECTED_AGENT_STORAGE_KEY } from "../shared/constants";
import { clearActionApprovals } from "../context/action-approval-store";
import type { ApprovalRequestPayload, ToolApprovalDecision } from "../shared/protocol";
import type { HistoryManager } from "../context/entities/history-manager";
import { ensureProjectStorage, saveProjectMeta } from "../context/project-store";
import type { ProjectStorageInfo } from "../context/entities/project-store";
import { clearSession } from "../runtime/session-tracker";
import { CommandTerminalRegistry } from "../runtime/command-terminal-registry";
import type { FigmaImportRecord } from "../shared/figma";
import type {
  ActiveShellSessionState,
  BackgroundCommandCompletion,
  GalaxyWorkbenchChrome,
  NativeShellViews,
} from "../shared/extension-host";
import type {
  AgentType,
  ChatMessage,
  ChangeSummary,
  FileItem,
  ExtensionToolGroup,
  LogEntry,
  PlanItem,
  QualityPreferences,
  ToolCapabilities,
  ToolToggles,
  QualityDetails,
  WebviewMessage,
} from "../shared/protocol";
import type { ChatRuntimeCallbacks } from "../shared/chat-runtime";
import type { WebviewActionCallbacks } from "../shared/webview-actions";
import type { ProviderWorkspaceToolActions } from "../shared/workspace-tooling";
import type { ProviderQualityGateBindings } from "../shared/quality-gates";
import type { ProviderCommandActions } from "../shared/provider-command-actions";
import type { ProviderMessageActions } from "../shared/provider-message-actions";
import type { ProviderReviewActions } from "../shared/provider-review-actions";
import type { ProviderRuntimeActions } from "../shared/provider-runtime-actions";
import type { ProviderSessionActions } from "../shared/provider-session-actions";
import type { ProviderUtilityActions } from "../shared/provider-utility-actions";
import type { ProviderViewActions } from "../shared/provider-view-actions";
import type { ProviderWorkbenchActions } from "../shared/provider-workbench-actions";
import type { ProviderWorkspaceSyncActions } from "../shared/provider-workspace-sync-actions";
import type { ProviderQualityActions } from "../shared/quality-settings";
import type { ResetWorkspaceSessionOptions } from "../shared/workspace-reset";
import {
  handleProviderMessage,
  resetProviderSessionState,
  runProviderInternalRepairTurn,
  runProviderSelectiveMultiAgentPlan,
  runProviderValidationAndReviewFlow,
} from "./galaxy-chat-view-provider-runtime";
import { initializeGalaxyChatViewProvider, type GalaxyChatViewProviderBootstrapTarget } from "./provider-bootstrap";
import { persistProjectMetaPatch as persistHostedProjectMetaPatch } from "./session-lifecycle";
import { persistSelectedAgent as persistHostedSelectedAgent } from "./workbench-runtime";
import { clearProviderPendingApprovalState } from "./galaxy-chat-view-provider-actions";

/**
 * Main sidebar provider for the Galaxy chat experience.
 *
 * This class now acts mostly as an orchestration shell:
 * - it owns mutable VS Code and workspace state
 * - it wires that state into extracted provider action bundles
 * - it keeps the public provider surface expected by extension activation
 */
export class GalaxyChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "galaxy-code.chatView";
  private static currentProvider: GalaxyChatViewProvider | undefined;

  /** Returns the singleton provider instance used by the extension activation flow. */
  static create(
    context: vscode.ExtensionContext,
    chrome: GalaxyWorkbenchChrome,
  ): GalaxyChatViewProvider {
    if (GalaxyChatViewProvider.currentProvider) {
      return GalaxyChatViewProvider.currentProvider;
    }

    const provider = new GalaxyChatViewProvider(context, chrome);
    GalaxyChatViewProvider.currentProvider = provider;
    return provider;
  }

  /** Clears the current provider-backed session when the command palette asks for it. */
  static clearCurrent(): void {
    GalaxyChatViewProvider.currentProvider?.clearHistory();
  }

  /** Forwards Figma imports into the live provider when the sidebar is already active. */
  static handleImportedFigmaDesign(record: FigmaImportRecord): boolean {
    if (!GalaxyChatViewProvider.currentProvider) {
      return false;
    }

    void GalaxyChatViewProvider.currentProvider
      .utilityActions
      .handleFigmaImport(record);
    return true;
  }

  private readonly context!: vscode.ExtensionContext;
  private readonly chrome!: GalaxyWorkbenchChrome;
  private readonly workspacePath!: string;
  private readonly projectStorage!: ProjectStorageInfo;
  private readonly historyManager!: HistoryManager;
  private readonly selectedFiles = new Set<string>();
  private nativeShellViews: NativeShellViews | null = null;
  private isRunning = false;
  private statusText = "Phase 8 Polish ready";
  private messages: ChatMessage[] = [];
  private selectedAgent: AgentType = "manual";
  private pendingApprovalRequestId: string | null = null;
  private pendingApprovalResolver:
    | ((decision: ToolApprovalDecision) => void)
    | null = null;
  private pendingApprovalTitle: string | null = null;
  private pendingApprovalPayload: ApprovalRequestPayload | null = null;
  private progressReporter: vscode.Progress<{ message?: string }> | null = null;
  private runtimeLogs: LogEntry[] = [];
  private qualityDetails: QualityDetails = Object.freeze({
    validationSummary: "",
    reviewSummary: "",
    reviewFindings: Object.freeze([]),
  });
  private qualityPreferences: QualityPreferences = Object.freeze({
    reviewEnabled: true,
    validateEnabled: true,
    fullAccessEnabled: false,
  });
  private toolCapabilities: ToolCapabilities = Object.freeze({
    ...DEFAULT_CONFIG.toolCapabilities,
  });
  private toolToggles: ToolToggles = Object.freeze({
    ...DEFAULT_CONFIG.toolToggles,
  });
  private extensionToolGroups: readonly ExtensionToolGroup[] = [];
  private extensionToolToggles: Readonly<Record<string, boolean>> =
    Object.freeze({});
  private view: vscode.WebviewView | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private activeShellSessions = new Map<string, ActiveShellSessionState>();
  private readonly commandTerminalRegistry = new CommandTerminalRegistry();
  private streamingAssistant = "";
  private streamingThinking = "";
  private pendingBackgroundCompletions: BackgroundCommandCompletion[] = [];
  private backgroundCompletionRunning = false;
  private readonly qualityActions!: ProviderQualityActions;
  private readonly messageActions!: ProviderMessageActions;
  private readonly workbenchActions!: ProviderWorkbenchActions;
  private readonly utilityActions!: ProviderUtilityActions;
  private readonly workspaceToolActions!: ProviderWorkspaceToolActions;
  private readonly reviewActions!: ProviderReviewActions;
  private readonly commandActions!: ProviderCommandActions;
  private readonly runtimeActions!: ProviderRuntimeActions;
  private readonly sessionActions!: ProviderSessionActions;
  private readonly workspaceSyncActions!: ProviderWorkspaceSyncActions;
  private readonly viewActions!: ProviderViewActions;
  private readonly webviewActionCallbacks!: WebviewActionCallbacks;
  private readonly chatRuntimeCallbacks!: ChatRuntimeCallbacks;

  /**
   * Initializes provider-owned runtime state from workspace storage and current config.
   *
   * The constructor intentionally keeps only bootstrapping logic; nearly all feature
   * behaviors are delegated through the action bundles defined further below.
   */
  private constructor(
    context: vscode.ExtensionContext,
    chrome: GalaxyWorkbenchChrome,
  ) {
    initializeGalaxyChatViewProvider(
      this as unknown as GalaxyChatViewProviderBootstrapTarget,
      context,
      chrome,
    );
  }

  /** Attaches the sidebar webview and sends its initial session payload. */
  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    await this.viewActions.resolveWebviewView(webviewView);
  }

  /** Reveals the sidebar-hosted Galaxy chat view. */
  async reveal(): Promise<void> {
    await this.viewActions.reveal();
  }

  /** Opens or focuses the secondary chat panel shown beside the editor. */
  async openChatRight(): Promise<void> {
    await this.viewActions.openChatRight();
  }

  /** Mirrors current quality preferences into VS Code settings. */
  async syncQualityPreferencesToVsCodeSettings(): Promise<void> {
    await this.qualityActions.syncQualityPreferencesToVsCodeSettings();
  }

  /** Reacts to external VS Code settings changes that affect Galaxy quality controls. */
  async handleVsCodeQualitySettingsChange(): Promise<void> {
    await this.qualityActions.handleVsCodeQualitySettingsChange();
  }

  /** Toggles review preference from a command or status action. */
  async toggleReviewPreference(): Promise<void> {
    await this.qualityActions.toggleReviewPreference();
  }

  /** Toggles validation preference from a command or status action. */
  async toggleValidationPreference(): Promise<void> {
    await this.qualityActions.toggleValidationPreference();
  }

  /**
   * Main ingress point for messages coming back from the Galaxy webview.
   *
   * Non-chat actions are routed through dedicated webview handlers first. The remaining
   * chat-send flow is then delegated to the hosted chat runtime orchestrator.
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    await handleProviderMessage({
      workspacePath: this.workspacePath,
      message,
      webviewActionCallbacks: this.webviewActionCallbacks,
      getMessageActions: () => this.messageActions,
      getQualityActions: () => this.qualityActions,
      getWorkbenchActions: () => this.workbenchActions,
      isRunning: this.isRunning,
      selectedAgent: this.selectedAgent,
      qualityPreferences: this.qualityPreferences,
      toolCapabilities: this.toolCapabilities,
      setSelectedAgent: (agentType) => {
        this.selectedAgent = agentType;
      },
      persistSelectedAgent: () => {
        persistHostedSelectedAgent(
          this.context.workspaceState,
          SELECTED_AGENT_STORAGE_KEY,
          this.selectedAgent,
        );
      },
      appendUserMessage: (nextMessage) => {
        this.messages.push(nextMessage);
      },
      projectStorage: this.projectStorage,
      appendLog: (kind, text) => this.runtimeActions.appendLog(kind, text),
      setRunningState: (isRunning, statusText) => {
        this.isRunning = isRunning;
        this.statusText = statusText;
      },
      clearProgressReporter: () => {
        this.progressReporter = null;
      },
      getEffectiveConfig: () => this.sessionActions.getEffectiveConfig(),
      runSelectiveMultiAgentPlan: (opts) => this.runSelectiveMultiAgentPlan(opts),
      getChatRuntimeCallbacks: () => this.chatRuntimeCallbacks,
      runValidationAndReviewFlow: (agentType) => this.runValidationAndReviewFlow(agentType),
      clearCurrentTurn: () => this.historyManager.clearCurrentTurn(),
      postMessage: (hostMessage) => this.sessionActions.postMessage(hostMessage),
      flushBackgroundCommandCompletions: () => this.commandActions.flushBackgroundCommandCompletions(),
    });
  }

  /** Runs the selective multi-agent plan used by the hosted chat runtime. */
  private async runSelectiveMultiAgentPlan(opts: {
    config: ReturnType<typeof loadConfig>;
    agentType: AgentType;
    originalUserMessage: ChatMessage;
    contextNote?: string;
  }): Promise<
    Readonly<{
      handled: boolean;
      hadError: boolean;
      filesWritten: readonly string[];
    }>
  > {
    return runProviderSelectiveMultiAgentPlan(this.chatRuntimeCallbacks, opts);
  }

  /** Runs one internal repair turn triggered by validation or review follow-up flows. */
  private async runInternalRepairTurn(opts: {
    config: ReturnType<typeof loadConfig>;
    agentType: AgentType;
    userMessage: ChatMessage;
    contextNote?: string;
    emptyContinueAttempt?: number;
  }): Promise<
    Readonly<{ hadError: boolean; filesWritten: readonly string[] }>
  > {
    return runProviderInternalRepairTurn(this.chatRuntimeCallbacks, opts);
  }

  /** Coordinates the hosted validation and review pipeline after a write-producing turn. */
  private async runValidationAndReviewFlow(
    agentType: AgentType,
  ): Promise<Readonly<{ passed: boolean; repaired: boolean }>> {
    const bindings: ProviderQualityGateBindings = {
      workspacePath: this.workspacePath,
      projectStorage: this.projectStorage,
      agentType,
      getEffectiveConfig: () => this.sessionActions.getEffectiveConfig(),
      setStatusText: (statusText) => {
        this.statusText = statusText;
      },
      reportProgress: (statusText) => this.workbenchActions.reportProgress(statusText),
      postRunState: () => this.workbenchActions.postRunState(),
      appendLog: this.runtimeActions.appendLog,
      updateQualityDetails: this.runtimeActions.updateQualityDetails,
      persistProjectMetaPatch: (mutate) => {
        persistHostedProjectMetaPatch({
          projectStorage: this.projectStorage,
          mutate,
        });
      },
      addMessage: async (message) => this.messageActions.addMessage(message),
      runInternalRepairTurn: async (request) =>
        this.runInternalRepairTurn(request),
      emitCommandStreamStart: async (payload) =>
        this.commandActions.emitCommandStreamStart(payload),
      emitCommandStreamChunk: async (payload) =>
        this.commandActions.emitCommandStreamChunk(payload),
      emitCommandStreamEnd: async (payload) =>
        this.commandActions.emitCommandStreamEnd(payload),
    };
    return runProviderValidationAndReviewFlow(bindings);
  }

  /** Clears the current session state while preserving the provider instance itself. */
  clearHistory(): void {
    this.utilityActions.clearHistory();
  }

  /** Opens the runtime log output channel with a short workspace header. */
  async openRuntimeLogs(): Promise<void> {
    await this.utilityActions.openRuntimeLogs();
  }

  /** Prints the persisted telemetry summary for the current workspace. */
  async openTelemetrySummary(): Promise<void> {
    await this.utilityActions.openTelemetrySummary();
  }

  /** Presents the agent quick pick and persists the new selection when changed. */
  async showAgentQuickPick(): Promise<void> {
    await this.utilityActions.showAgentQuickPick();
  }

  /**
   * Resets all provider-owned runtime state tied to the current workspace session.
   *
   * This is the lowest-level reset hook used by clear-history and certain composer actions.
   */
  private resetWorkspaceSession(opts?: ResetWorkspaceSessionOptions): void {
    resetProviderSessionState(
      {
        workspacePath: this.workspacePath,
        projectStorage: this.projectStorage,
        historyManager: this.historyManager,
        recreateProjectStorageState: () => {
          ensureProjectStorage(this.projectStorage);
          saveProjectMeta(this.projectStorage, null);
        },
        clearActionApprovals: () => {
          clearActionApprovals(this.workspacePath);
        },
        clearRuntimeSession: () => {
          clearSession();
        },
        setRuntimeLogs: (runtimeLogs) => {
          this.runtimeLogs = [...runtimeLogs];
        },
        createEmptyQualityDetails: () =>
          Object.freeze({
            validationSummary: "",
            reviewSummary: "",
          }),
        setQualityDetails: (qualityDetails) => {
          this.qualityDetails = qualityDetails;
        },
        setMessages: (messages) => {
          this.messages = [...messages];
        },
        setIsRunning: (value) => {
          this.isRunning = value;
        },
        clearPendingApprovalState: () => this.clearPendingApprovalState(),
        clearProgressReporter: () => {
          this.progressReporter = null;
        },
        activeShellSessions: this.activeShellSessions,
        commandTerminalRegistry: this.commandTerminalRegistry,
        clearStreamingBuffers: () => this.messageActions.clearStreamingBuffers(),
        updateWorkbenchChrome: () => this.workbenchActions.updateWorkbenchChrome(),
      },
      opts,
    );
  }

  /** Clears the active tool approval state after the user responds or a reset occurs. */
  private clearPendingApprovalState(): void {
    clearProviderPendingApprovalState({
      setPendingApprovalResolver: (
        resolver: ((decision: ToolApprovalDecision) => void) | null,
      ) => {
        this.pendingApprovalResolver = resolver;
      },
      setPendingApprovalRequestId: (requestId: string | null) => {
        this.pendingApprovalRequestId = requestId;
      },
      setPendingApprovalTitle: (title: string | null) => {
        this.pendingApprovalTitle = title;
      },
      setPendingApprovalPayload: (payload: ApprovalRequestPayload | null) => {
        this.pendingApprovalPayload = payload;
      },
      updateWorkbenchChrome: () => this.workbenchActions.updateWorkbenchChrome(),
    });
  }
}
