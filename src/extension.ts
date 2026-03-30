import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getAgentConfig, getConfigDir, loadConfig, saveConfig } from './config/manager';
import { DEFAULT_CONFIG, type GalaxyConfig } from './config/types';
import {
  buildAttachmentContextNote,
  buildAttachmentImagePaths,
  buildMessageAttachments,
  commitAttachments,
  createDraftFigmaAttachment,
  createDraftLocalAttachment,
  removeDraftAttachment,
} from './attachments/attachment-store';
import { clearActionApprovals } from './context/action-approval-store';
import type { ApprovalRequestPayload, ToolApprovalDecision } from './shared/protocol';
import { createHistoryManager, type HistoryManager } from './context/history-manager';
import { loadNotes } from './context/notes';
import {
  ensureProjectStorage,
  getProjectStorageInfo,
  loadProjectMeta,
  type ProjectMeta,
  saveProjectMeta,
  type ProjectStorageInfo,
} from './context/project-store';
import { appendTaskMemoryEntry, replaceTaskMemoryFindings, updateTaskMemoryFindingStatus } from './context/rag-metadata-store';
import { appendTelemetryEvent, formatTelemetrySummary, loadTelemetrySummary } from './context/telemetry';
import {
  appendUiTranscriptMessage,
  clearUiTranscript,
  loadUiTranscript,
} from './context/ui-transcript-store';
import { buildSelectedFilesContextNote } from './runtime/context-builder';
import { buildBaseComponentContextNote } from './runtime/base-component-profile';
import {
  clearSession,
  getOriginalContent,
  getSessionChangeSummary,
  getSessionFiles,
  revertAllSessionFiles,
  revertFile,
  type ChangedFileSummary,
} from './runtime/session-tracker';
import { formatReviewSummary, runCodeReview, type ReviewResult } from './runtime/code-reviewer';
import { runExtensionChat } from './runtime/run-chat';
import { CommandTerminalRegistry } from './runtime/command-terminal-registry';
import { discoverExtensionToolGroups, searchExtensionToolGroups } from './runtime/extension-tool-discovery';
import {
  buildCoderSubAgentConfig,
  buildSelectiveMultiAgentPlanMessage,
  buildSelectiveMultiAgentSubtaskMessage,
  maybeBuildSelectiveMultiAgentPlan,
} from './runtime/selective-multi-agent';
import { formatValidationSummary, runFinalValidation } from './validation/project-validator';
import type { FinalValidationResult } from './validation/types';
import type { ToolResult } from './tools/file-tools';
import {
  appendFigmaImport,
  buildAttachedFigmaContextNote,
  buildFigmaAttachment,
  buildFigmaClipboardToken,
} from './figma/design-store';
import { FIGMA_BRIDGE_HOST, FIGMA_BRIDGE_PORT, startFigmaBridgeServer, type FigmaBridgeServer } from './figma/bridge-server';
import type { FigmaImportRecord } from './figma/design-types';
import type {
  AgentType,
  ChatMessage,
  ChangeSummary,
  ChangedFileSummary as ChangedFileSummaryPayload,
  FileItem,
  FigmaAttachment,
  HostMessage,
  CommandStreamChunkPayload,
  CommandStreamEndPayload,
  CommandStreamStartPayload,
  ExtensionToolGroup,
  LocalAttachmentPayload,
  LogEntry,
  PlanItem,
  QualityPreferences,
  ToolCapabilities,
  ToolToggles,
  QualityDetails,
  SessionInitPayload,
  WebviewMessage,
} from './shared/protocol';

const MAX_AUTO_REPAIR_ATTEMPTS = 2;
const MAX_AUTO_REVIEW_REPAIR_ATTEMPTS = 1;
const MAX_EMPTY_CONTINUE_ATTEMPTS = 3;
const MAX_LOG_ENTRIES = 120;
const MAX_DEBUG_BLOCK_CHARS = 20_000;
const MAX_COMMAND_CONTEXT_OUTPUT_CHARS = 12_000;
let figmaBridge: FigmaBridgeServer | null = null;
const GALAXY_VIEW_CONTAINER_ID = 'galaxy-code-sidebar';
const CONTEXT_FILES_VIEW_ID = 'galaxy-code.contextFilesView';
const CHANGED_FILES_VIEW_ID = 'galaxy-code.changedFilesView';
const OPEN_CONTEXT_FILE_COMMAND_ID = 'galaxy-code.internal.openContextFile';
const OPEN_CHANGED_FILE_DIFF_COMMAND_ID = 'galaxy-code.internal.openChangedFileDiff';
const TOGGLE_REVIEW_COMMAND_ID = 'galaxy-code.toggleReview';
const TOGGLE_VALIDATION_COMMAND_ID = 'galaxy-code.toggleValidation';
const GALAXY_CONFIGURATION_SECTION = 'galaxyCode';
const QUALITY_REVIEW_SETTING_KEY = 'quality.reviewEnabled';
const QUALITY_VALIDATE_SETTING_KEY = 'quality.validateEnabled';
const QUALITY_FULL_ACCESS_SETTING_KEY = 'quality.fullAccessEnabled';
const SELECTED_AGENT_STORAGE_KEY = 'galaxy-code.selectedAgent';
const AGENT_TYPES: readonly AgentType[] = ['manual', 'ollama', 'gemini', 'claude', 'codex'];

function getToolCapabilitiesFromConfig(config: GalaxyConfig): ToolCapabilities {
  return Object.freeze({
    ...config.toolCapabilities,
  });
}

function getToolTogglesFromConfig(config: GalaxyConfig): ToolToggles {
  return Object.freeze({
    ...config.toolToggles,
  });
}

function getWorkspaceToolCapabilities(config: GalaxyConfig, meta: ProjectMeta | null): ToolCapabilities {
  return Object.freeze({
    ...config.toolCapabilities,
    ...(meta?.toolCapabilities ?? {}),
  });
}

function getWorkspaceToolToggles(config: GalaxyConfig, meta: ProjectMeta | null): ToolToggles {
  return Object.freeze({
    ...config.toolToggles,
    ...((meta?.toolToggles ?? {}) as Partial<ToolToggles>),
  });
}

function getDefaultExtensionToolToggles(
  groups: readonly ExtensionToolGroup[],
): Readonly<Record<string, boolean>> {
  return Object.freeze(
    Object.fromEntries(
      groups.flatMap((group) =>
        group.recommended || group.source === 'mcp_curated'
          ? group.tools.map((tool) => [tool.key, true] as const)
          : [],
      ),
    ),
  );
}

function getWorkspaceExtensionToolToggles(
  config: GalaxyConfig,
  meta: ProjectMeta | null,
  groups: readonly ExtensionToolGroup[],
): Readonly<Record<string, boolean>> {
  return Object.freeze({
    ...getDefaultExtensionToolToggles(groups),
    ...config.extensionToolToggles,
    ...(meta?.extensionToolToggles ?? {}),
  });
}

function getQualityPreferencesForWorkspace(
  config: GalaxyConfig,
  capabilities: ToolCapabilities,
): QualityPreferences {
  return Object.freeze({
    reviewEnabled: capabilities.review,
    validateEnabled: capabilities.validation,
    fullAccessEnabled: isFullAccessEnabled(config),
  });
}

function buildEffectiveConfig(
  config: GalaxyConfig,
  meta: ProjectMeta | null,
  qualityPreferences: QualityPreferences,
  availableExtensionToolGroups: readonly ExtensionToolGroup[],
): GalaxyConfig {
  const toolCapabilities = getWorkspaceToolCapabilities(config, meta);
  const toolToggles = getWorkspaceToolToggles(config, meta);
  const quality = {
    ...config.quality,
    review: qualityPreferences.reviewEnabled,
    test: qualityPreferences.validateEnabled,
  };

  return Object.freeze({
    ...config,
    quality,
    toolSafety: applyFullAccessToToolSafety(
      {
        ...config,
        quality,
        toolCapabilities,
        toolToggles,
      },
      qualityPreferences.fullAccessEnabled,
    ),
    toolCapabilities: Object.freeze({
      ...toolCapabilities,
      review: qualityPreferences.reviewEnabled,
      validation: qualityPreferences.validateEnabled,
      runCommands: toolCapabilities.runCommands,
    }),
    toolToggles,
    extensionToolToggles: getWorkspaceExtensionToolToggles(config, meta, availableExtensionToolGroups),
    availableExtensionToolGroups,
  });
}

function isFullAccessEnabled(config: GalaxyConfig): boolean {
  return !config.toolSafety.requireApprovalForGitPull
    && !config.toolSafety.requireApprovalForGitPush
    && !config.toolSafety.requireApprovalForGitCheckout
    && !config.toolSafety.requireApprovalForDeletePath
    && !config.toolSafety.requireApprovalForScaffold
    && !config.toolSafety.requireApprovalForProjectCommand;
}

function applyFullAccessToToolSafety(config: GalaxyConfig, enabled: boolean): GalaxyConfig['toolSafety'] {
  if (enabled) {
    return {
      ...config.toolSafety,
      requireApprovalForGitPull: false,
      requireApprovalForGitPush: false,
      requireApprovalForGitCheckout: false,
      requireApprovalForDeletePath: false,
      requireApprovalForScaffold: false,
      requireApprovalForProjectCommand: false,
    };
  }

  return {
    ...config.toolSafety,
    requireApprovalForGitPull: DEFAULT_CONFIG.toolSafety.requireApprovalForGitPull,
    requireApprovalForGitPush: DEFAULT_CONFIG.toolSafety.requireApprovalForGitPush,
    requireApprovalForGitCheckout: DEFAULT_CONFIG.toolSafety.requireApprovalForGitCheckout,
    requireApprovalForDeletePath: DEFAULT_CONFIG.toolSafety.requireApprovalForDeletePath,
    requireApprovalForScaffold: DEFAULT_CONFIG.toolSafety.requireApprovalForScaffold,
    requireApprovalForProjectCommand: DEFAULT_CONFIG.toolSafety.requireApprovalForProjectCommand,
  };
}

type GalaxyWorkbenchChrome = Readonly<{
  outputChannel: vscode.OutputChannel;
  runStatusItem: vscode.StatusBarItem;
  agentStatusItem: vscode.StatusBarItem;
  approvalStatusItem: vscode.StatusBarItem;
}>;

type NativeShellViews = Readonly<{
  contextFilesProvider: ContextFilesTreeProvider;
  contextFilesView: vscode.TreeView<FileItem>;
  changedFilesProvider: ChangedFilesTreeProvider;
  changedFilesView: vscode.TreeView<ChangedFileSummaryPayload>;
}>;

type BackgroundCommandCompletion = Readonly<{
  toolCallId: string;
  commandText: string;
  cwd: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
  output: string;
  background: boolean;
}>;

type ActiveShellSessionState = Readonly<{
  toolCallId: string;
  commandText: string;
  cwd: string;
  startedAt: number;
  output: string;
  terminalTitle?: string;
  success?: boolean;
  exitCode?: number;
  durationMs?: number;
  background?: boolean;
}>;

type CommandContextFile = Readonly<{
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
  durationMs?: number;
  tailOutput: string;
  summary: string;
  changedFiles: readonly string[];
  updatedAt: string;
  completedAt?: string;
}>;

function normalizeRelativeDisplayPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function getRelativePathDescription(relativePath: string): string | undefined {
  const normalized = normalizeRelativeDisplayPath(relativePath);
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex <= 0) {
    return undefined;
  }

  return normalized.slice(0, separatorIndex);
}

function getChangedFileDescription(file: ChangedFileSummaryPayload): string {
  const parts = [
    getRelativePathDescription(file.label),
    file.wasNew ? 'new' : undefined,
    `+${file.addedLines} -${file.deletedLines}`,
  ].filter((value): value is string => Boolean(value));

  return parts.join(' · ');
}

function writeDebugLine(filePath: string, scope: string, message: string): void {
  try {
    const timestamp = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(filePath, `[${timestamp}] [${scope}] ${message}\n`, 'utf-8');
  } catch {
    // ignore debug logging failures
  }
}

const MAX_WEBVIEW_MESSAGE_COUNT = 160;
const MAX_WEBVIEW_TOOL_CONTENT_CHARS = 12_000;
const MAX_WEBVIEW_PARAM_STRING_CHARS = 1_200;
const MAX_WEBVIEW_META_ARRAY_ITEMS = 24;

function truncateWebviewText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n\n...[truncated ${value.length - maxChars} chars]`;
}

function sanitizeWebviewValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateWebviewText(value, MAX_WEBVIEW_PARAM_STRING_CHARS);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_WEBVIEW_META_ARRAY_ITEMS).map((item) => sanitizeWebviewValue(item, depth + 1));
    if (value.length > MAX_WEBVIEW_META_ARRAY_ITEMS) {
      items.push(`[...${value.length - MAX_WEBVIEW_META_ARRAY_ITEMS} more items]`);
    }
    return items;
  }
  if (typeof value === 'object') {
    if (depth >= 2) {
      return '[object truncated]';
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 32);
    return Object.fromEntries(entries.map(([key, nested]) => [key, sanitizeWebviewValue(nested, depth + 1)]));
  }
  return String(value);
}

function sanitizeChatMessageForWebview(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool') {
    return message;
  }

  return Object.freeze({
    ...message,
    content: truncateWebviewText(message.content, MAX_WEBVIEW_TOOL_CONTENT_CHARS),
    ...(message.toolParams ? { toolParams: sanitizeWebviewValue(message.toolParams) as Record<string, unknown> } : {}),
    ...(message.toolMeta ? { toolMeta: sanitizeWebviewValue(message.toolMeta) as Record<string, unknown> } : {}),
  });
}

function isAgentType(value: string | undefined): value is AgentType {
  return value === 'manual' || value === 'ollama' || value === 'gemini' || value === 'claude' || value === 'codex';
}

function getAgentLabel(agentType: AgentType): string {
  switch (agentType) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'ollama':
      return 'Ollama';
    case 'manual':
      return 'Manual';
  }
}

class ContextFilesTreeProvider implements vscode.TreeDataProvider<FileItem> {
  private readonly didChangeTreeData = new vscode.EventEmitter<FileItem | FileItem[] | undefined | null | void>();
  private files: readonly FileItem[] = [];

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  setFiles(files: readonly FileItem[]): void {
    this.files = [...files];
    this.didChangeTreeData.fire();
  }

  getFirstFile(): FileItem | undefined {
    return this.files[0];
  }

  getChildren(element?: FileItem): FileItem[] {
    return element ? [] : [...this.files];
  }

  getParent(_element: FileItem): undefined {
    return undefined;
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    const fileUri = vscode.Uri.file(element.path);
    const treeItem = new vscode.TreeItem(fileUri, vscode.TreeItemCollapsibleState.None);
    treeItem.id = element.path;
    treeItem.description = getRelativePathDescription(element.label);
    treeItem.tooltip = element.label;
    treeItem.command = {
      command: OPEN_CONTEXT_FILE_COMMAND_ID,
      title: 'Open Context File',
      arguments: [element.path],
    };
    treeItem.contextValue = 'galaxy-code.context-file';
    treeItem.checkboxState = element.selected
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return treeItem;
  }
}

class ChangedFilesTreeProvider implements vscode.TreeDataProvider<ChangedFileSummaryPayload> {
  private readonly didChangeTreeData = new vscode.EventEmitter<
    ChangedFileSummaryPayload | ChangedFileSummaryPayload[] | undefined | null | void
  >();
  private files: readonly ChangedFileSummaryPayload[] = [];

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  setFiles(files: readonly ChangedFileSummaryPayload[]): void {
    this.files = [...files];
    this.didChangeTreeData.fire();
  }

  getFirstFile(): ChangedFileSummaryPayload | undefined {
    return this.files[0];
  }

  getChildren(element?: ChangedFileSummaryPayload): ChangedFileSummaryPayload[] {
    return element ? [] : [...this.files];
  }

  getParent(_element: ChangedFileSummaryPayload): undefined {
    return undefined;
  }

  getTreeItem(element: ChangedFileSummaryPayload): vscode.TreeItem {
    const fileUri = vscode.Uri.file(element.filePath);
    const treeItem = new vscode.TreeItem(fileUri, vscode.TreeItemCollapsibleState.None);
    treeItem.id = element.filePath;
    treeItem.description = getChangedFileDescription(element);
    treeItem.tooltip = `${element.label}${element.wasNew ? ' (new)' : ''}\n+${element.addedLines} / -${element.deletedLines}`;
    treeItem.command = {
      command: OPEN_CHANGED_FILE_DIFF_COMMAND_ID,
      title: 'Open Changed File Diff',
      arguments: [element.filePath],
    };
    treeItem.contextValue = 'galaxy-code.changed-file';
    return treeItem;
  }
}

class GalaxyChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'galaxy-code.chatView';
  private static currentProvider: GalaxyChatViewProvider | undefined;

  static create(context: vscode.ExtensionContext, chrome: GalaxyWorkbenchChrome): GalaxyChatViewProvider {
    if (GalaxyChatViewProvider.currentProvider) {
      return GalaxyChatViewProvider.currentProvider;
    }

    const provider = new GalaxyChatViewProvider(context, chrome);
    GalaxyChatViewProvider.currentProvider = provider;
    return provider;
  }

  static clearCurrent(): void {
    GalaxyChatViewProvider.currentProvider?.clearHistory();
  }

  static handleImportedFigmaDesign(record: FigmaImportRecord): boolean {
    if (!GalaxyChatViewProvider.currentProvider) {
      return false;
    }

    void GalaxyChatViewProvider.currentProvider.handleFigmaImport(record);
    return true;
  }

  private readonly context: vscode.ExtensionContext;
  private readonly chrome: GalaxyWorkbenchChrome;
  private readonly workspacePath: string;
  private readonly projectStorage: ProjectStorageInfo;
  private readonly historyManager: HistoryManager;
  private readonly selectedFiles = new Set<string>();
  private nativeShellViews: NativeShellViews | null = null;
  private isRunning = false;
  private statusText = 'Phase 8 Polish ready';
  private messages: ChatMessage[] = [];
  private selectedAgent: AgentType = 'manual';
  private pendingApprovalRequestId: string | null = null;
  private pendingApprovalResolver: ((decision: ToolApprovalDecision) => void) | null = null;
  private pendingApprovalTitle: string | null = null;
  private pendingApprovalPayload: ApprovalRequestPayload | null = null;
  private progressReporter: vscode.Progress<{ message?: string }> | null = null;
  private runtimeLogs: LogEntry[] = [];
  private qualityDetails: QualityDetails = Object.freeze({
    validationSummary: '',
    reviewSummary: '',
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
  private extensionToolToggles: Readonly<Record<string, boolean>> = Object.freeze({});
  private view: vscode.WebviewView | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private activeShellSessions = new Map<string, ActiveShellSessionState>();
  private readonly commandTerminalRegistry = new CommandTerminalRegistry();
  private streamingAssistant = '';
  private streamingThinking = '';
  private pendingBackgroundCompletions: BackgroundCommandCompletion[] = [];
  private backgroundCompletionRunning = false;

  private constructor(context: vscode.ExtensionContext, chrome: GalaxyWorkbenchChrome) {
    this.context = context;
    this.chrome = chrome;
    this.workspacePath = this.resolveStorageWorkspacePath();
    this.projectStorage = getProjectStorageInfo(this.workspacePath);
    ensureProjectStorage(this.projectStorage);
    const projectMeta = saveProjectMeta(this.projectStorage, loadProjectMeta(this.projectStorage));
    const config = loadConfig();
    this.extensionToolGroups = discoverExtensionToolGroups(context.extension.id);
    this.toolCapabilities = getWorkspaceToolCapabilities(config, projectMeta);
    this.toolToggles = getWorkspaceToolToggles(config, projectMeta);
    this.extensionToolToggles = getWorkspaceExtensionToolToggles(config, projectMeta, this.extensionToolGroups);
    this.qualityPreferences = getQualityPreferencesForWorkspace(config, this.toolCapabilities);
    this.historyManager = createHistoryManager({
      workspacePath: this.workspacePath,
      notes: loadNotes(),
    });
    this.selectedAgent = this.loadSelectedAgent();
    this.messages = this.loadInitialMessages();
    this.updateWorkbenchChrome();
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    this.configureWebview(webviewView.webview);
    webviewView.webview.html = this.getHtml(webviewView.webview);

    await this.postInit();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`workbench.view.extension.${GALAXY_VIEW_CONTAINER_ID}`);
    this.view?.show?.(true);
  }

  async openChatRight(): Promise<void> {
    if (this.panel) {
      await this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'galaxy-code.chatPanel',
      'Galaxy Code',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      },
    );

    this.panel = panel;
    this.configureWebview(panel.webview);
    panel.webview.html = this.getHtml(panel.webview);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = null;
      }
    });

    await this.postInit();
  }

  attachNativeShellViews(nativeShellViews: NativeShellViews): void {
    this.nativeShellViews = nativeShellViews;
    void this.refreshNativeShellViews();
  }

  async syncQualityPreferencesToVsCodeSettings(): Promise<void> {
    await this.syncQualityPreferencesToVsCodeSettingsInternal(this.qualityPreferences);
  }

  async handleVsCodeQualitySettingsChange(): Promise<void> {
    const next = this.readQualityPreferencesFromVsCodeSettings();
    if (
      next.reviewEnabled === this.qualityPreferences.reviewEnabled &&
      next.validateEnabled === this.qualityPreferences.validateEnabled &&
      next.fullAccessEnabled === this.qualityPreferences.fullAccessEnabled
    ) {
      return;
    }

    await this.applyQualityPreferences(next, {
      syncVsCodeSettings: false,
      logMessage: `Quality preferences updated from VS Code settings: review=${String(next.reviewEnabled)}, validate=${String(next.validateEnabled)}, fullAccess=${String(next.fullAccessEnabled)}.`,
    });
  }

  async toggleReviewPreference(): Promise<void> {
    await this.applyQualityPreferences(
      Object.freeze({
        ...this.qualityPreferences,
        reviewEnabled: !this.qualityPreferences.reviewEnabled,
      }),
      {
        syncVsCodeSettings: true,
        logMessage: `Review ${this.qualityPreferences.reviewEnabled ? 'disabled' : 'enabled'} from the Command Palette.`,
      },
    );
  }

  async toggleValidationPreference(): Promise<void> {
    await this.applyQualityPreferences(
      Object.freeze({
        ...this.qualityPreferences,
        validateEnabled: !this.qualityPreferences.validateEnabled,
      }),
      {
        syncVsCodeSettings: true,
        logMessage: `Validation ${this.qualityPreferences.validateEnabled ? 'disabled' : 'enabled'} from the Command Palette.`,
      },
    );
  }

  async openContextFile(filePath: string): Promise<void> {
    await this.openWorkspaceFile(filePath);
  }

  async openChangedFileDiff(filePath: string): Promise<void> {
    await this.openTrackedDiff(filePath);
  }

  async applyContextFileSelectionUpdates(
    updates: readonly Readonly<{ filePath: string; selected: boolean }>[],
  ): Promise<void> {
    await this.updateContextFileSelection(updates);
  }

  private readQualityPreferencesFromVsCodeSettings(): QualityPreferences {
    const configuration = vscode.workspace.getConfiguration(GALAXY_CONFIGURATION_SECTION);
    return Object.freeze({
      reviewEnabled: configuration.get<boolean>(QUALITY_REVIEW_SETTING_KEY, this.qualityPreferences.reviewEnabled),
      validateEnabled: configuration.get<boolean>(QUALITY_VALIDATE_SETTING_KEY, this.qualityPreferences.validateEnabled),
      fullAccessEnabled: configuration.get<boolean>(QUALITY_FULL_ACCESS_SETTING_KEY, this.qualityPreferences.fullAccessEnabled),
    });
  }

  private async syncQualityPreferencesToVsCodeSettingsInternal(preferences: QualityPreferences): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(GALAXY_CONFIGURATION_SECTION);
    const updates: Thenable<void>[] = [];

    if (configuration.get<boolean>(QUALITY_REVIEW_SETTING_KEY) !== preferences.reviewEnabled) {
      updates.push(
        configuration.update(
          QUALITY_REVIEW_SETTING_KEY,
          preferences.reviewEnabled,
          vscode.ConfigurationTarget.Global,
        ),
      );
    }

    if (configuration.get<boolean>(QUALITY_VALIDATE_SETTING_KEY) !== preferences.validateEnabled) {
      updates.push(
        configuration.update(
          QUALITY_VALIDATE_SETTING_KEY,
          preferences.validateEnabled,
          vscode.ConfigurationTarget.Global,
        ),
      );
    }

    if (configuration.get<boolean>(QUALITY_FULL_ACCESS_SETTING_KEY) !== preferences.fullAccessEnabled) {
      updates.push(
        configuration.update(
          QUALITY_FULL_ACCESS_SETTING_KEY,
          preferences.fullAccessEnabled,
          vscode.ConfigurationTarget.Global,
        ),
      );
    }

    if (updates.length > 0) {
      await Promise.all(updates);
    }
  }

  private async applyQualityPreferences(
    next: QualityPreferences,
    opts?: Readonly<{
      syncVsCodeSettings?: boolean;
      logMessage?: string;
    }>,
  ): Promise<void> {
    this.qualityPreferences = Object.freeze({
      reviewEnabled: next.reviewEnabled,
      validateEnabled: next.validateEnabled,
      fullAccessEnabled: next.fullAccessEnabled,
    });

    const config = loadConfig();
    const previousMeta = loadProjectMeta(this.projectStorage);
    saveConfig({
      ...config,
      quality: {
        ...config.quality,
        review: this.qualityPreferences.reviewEnabled,
        test: this.qualityPreferences.validateEnabled,
      },
      toolSafety: {
        ...applyFullAccessToToolSafety(config, this.qualityPreferences.fullAccessEnabled),
      },
    });
    saveProjectMeta(this.projectStorage, previousMeta ? {
      ...previousMeta,
      toolCapabilities: {
        ...(previousMeta.toolCapabilities ?? {}),
        review: this.qualityPreferences.reviewEnabled,
        validation: this.qualityPreferences.validateEnabled,
      },
      toolToggles: previousMeta.toolToggles,
      extensionToolToggles: previousMeta.extensionToolToggles,
    } : null);
    this.toolCapabilities = getWorkspaceToolCapabilities(loadConfig(), loadProjectMeta(this.projectStorage));
    this.toolToggles = getWorkspaceToolToggles(loadConfig(), loadProjectMeta(this.projectStorage));
    this.extensionToolToggles = getWorkspaceExtensionToolToggles(
      loadConfig(),
      loadProjectMeta(this.projectStorage),
      this.extensionToolGroups,
    );

    if (opts?.syncVsCodeSettings !== false) {
      await this.syncQualityPreferencesToVsCodeSettingsInternal(this.qualityPreferences);
    }

    await this.postMessage({
      type: 'quality-preferences-updated',
      payload: this.qualityPreferences,
    });
    await this.postMessage({
      type: 'tool-capabilities-updated',
      payload: this.toolCapabilities,
    });
    await this.postMessage({
      type: 'tool-toggles-updated',
      payload: this.toolToggles,
    });

    if (opts?.logMessage) {
      this.appendLog('info', opts.logMessage);
    }
  }

  private async applyToolCapabilities(
    next: ToolCapabilities,
    opts?: Readonly<{
      logMessage?: string;
    }>,
  ): Promise<void> {
    const config = loadConfig();
    const previousMeta = loadProjectMeta(this.projectStorage);
    saveConfig({
      ...config,
      quality: {
        ...config.quality,
        review: next.review,
        test: next.validation,
      },
      toolSafety: {
        ...config.toolSafety,
        enableProjectCommandTool: next.runCommands,
      },
      toolCapabilities: {
        ...config.toolCapabilities,
        ...next,
      },
    });
    saveProjectMeta(this.projectStorage, previousMeta ? {
      ...previousMeta,
      toolCapabilities: next,
      toolToggles: previousMeta.toolToggles,
      extensionToolToggles: previousMeta.extensionToolToggles,
	    } : {
	      workspaceId: this.projectStorage.workspaceId,
	      workspaceName: this.projectStorage.workspaceName,
	      workspacePath: this.projectStorage.workspacePath,
	      projectDirName: this.projectStorage.projectDirName,
	      createdAt: Date.now(),
	      lastOpenedAt: Date.now(),
	      storageVersion: 1,
	      toolCapabilities: next,
	      toolToggles: loadConfig().toolToggles,
        extensionToolToggles: loadConfig().extensionToolToggles,
	    });

    const persisted = loadConfig();
    this.toolCapabilities = getWorkspaceToolCapabilities(persisted, loadProjectMeta(this.projectStorage));
    this.toolToggles = getWorkspaceToolToggles(persisted, loadProjectMeta(this.projectStorage));
    this.extensionToolToggles = getWorkspaceExtensionToolToggles(
      persisted,
      loadProjectMeta(this.projectStorage),
      this.extensionToolGroups,
    );
    this.qualityPreferences = Object.freeze({
      reviewEnabled: this.toolCapabilities.review,
      validateEnabled: this.toolCapabilities.validation,
      fullAccessEnabled: isFullAccessEnabled(persisted),
    });

    await this.syncQualityPreferencesToVsCodeSettingsInternal(this.qualityPreferences);
    await this.postMessage({
      type: 'tool-capabilities-updated',
      payload: this.toolCapabilities,
    });
    await this.postMessage({
      type: 'tool-toggles-updated',
      payload: this.toolToggles,
    });
    await this.postMessage({
      type: 'quality-preferences-updated',
      payload: this.qualityPreferences,
    });

    if (opts?.logMessage) {
      this.appendLog('info', opts.logMessage);
    }
  }

  private async applyToolToggles(
    next: ToolToggles,
    opts?: Readonly<{
      logMessage?: string;
    }>,
  ): Promise<void> {
    const config = loadConfig();
    const previousMeta = loadProjectMeta(this.projectStorage);
    saveConfig({
      ...config,
      toolToggles: next,
    });
    saveProjectMeta(this.projectStorage, previousMeta ? {
      ...previousMeta,
      toolCapabilities: previousMeta.toolCapabilities,
      toolToggles: next,
      extensionToolToggles: previousMeta.extensionToolToggles,
    } : {
      workspaceId: this.projectStorage.workspaceId,
      workspaceName: this.projectStorage.workspaceName,
      workspacePath: this.projectStorage.workspacePath,
      projectDirName: this.projectStorage.projectDirName,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      storageVersion: 1,
      toolCapabilities: undefined,
      toolToggles: next,
      extensionToolToggles: loadConfig().extensionToolToggles,
    });

    const persisted = loadConfig();
    this.toolToggles = getWorkspaceToolToggles(persisted, loadProjectMeta(this.projectStorage));

    await this.postMessage({
      type: 'tool-toggles-updated',
      payload: this.toolToggles,
    });

    if (opts?.logMessage) {
      this.appendLog('info', opts.logMessage);
    }
  }

  private async applyExtensionToolToggles(
    next: Readonly<Record<string, boolean>>,
    opts?: Readonly<{
      logMessage?: string;
    }>,
  ): Promise<void> {
    const config = loadConfig();
    const previousMeta = loadProjectMeta(this.projectStorage);
    saveConfig({
      ...config,
      extensionToolToggles: next,
    });
    saveProjectMeta(this.projectStorage, previousMeta ? {
      ...previousMeta,
      toolCapabilities: previousMeta.toolCapabilities,
      toolToggles: previousMeta.toolToggles,
      extensionToolToggles: next,
    } : {
      workspaceId: this.projectStorage.workspaceId,
      workspaceName: this.projectStorage.workspaceName,
      workspacePath: this.projectStorage.workspacePath,
      projectDirName: this.projectStorage.projectDirName,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      storageVersion: 1,
      toolCapabilities: undefined,
      toolToggles: loadConfig().toolToggles,
      extensionToolToggles: next,
    });

    const persisted = loadConfig();
    this.extensionToolToggles = getWorkspaceExtensionToolToggles(
      persisted,
      loadProjectMeta(this.projectStorage),
      this.extensionToolGroups,
    );

    await this.postMessage({
      type: 'extension-tool-toggles-updated',
      payload: this.extensionToolToggles,
    });

    if (opts?.logMessage) {
      this.appendLog('info', opts.logMessage);
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'webview-ready':
        await this.postInit();
        return;
      case 'file-toggle':
        await this.updateContextFileSelection([message.payload]);
        return;
      case 'file-open':
        await this.openWorkspaceFile(message.payload.filePath);
        return;
      case 'file-diff':
        await this.openTrackedDiff(message.payload.filePath);
        return;
      case 'link-open':
        await vscode.env.openExternal(vscode.Uri.parse(message.payload.href));
        return;
      case 'terminal-snippet-run': {
        const terminal = vscode.window.createTerminal({
          name: `Galaxy Snippet${message.payload.language ? ` (${message.payload.language})` : ''}`,
          cwd: this.workspacePath,
          isTransient: true,
        });
        terminal.show(true);
        terminal.sendText(message.payload.code, true);
        return;
      }
      case 'shell-open-terminal':
        await this.revealShellTerminal(message.payload.toolCallId);
        return;
      case 'approval-response':
        if (this.pendingApprovalResolver && this.pendingApprovalRequestId === message.payload.requestId) {
          this.appendLog('approval', `User selected ${message.payload.decision} for the pending approval request.`);
          const resolve = this.pendingApprovalResolver;
          this.clearPendingApprovalState();
          resolve(message.payload.decision);
        }
        return;
      case 'quality-set':
        await this.applyQualityPreferences(message.payload, {
          syncVsCodeSettings: true,
          logMessage: `Quality preferences updated from the Galaxy Code sidebar: review=${String(message.payload.reviewEnabled)}, validate=${String(message.payload.validateEnabled)}, fullAccess=${String(message.payload.fullAccessEnabled)}.`,
        });
        return;
      case 'tool-capabilities-set':
        await this.applyToolCapabilities(message.payload, {
          logMessage: 'Tool capabilities updated from the Galaxy Code sidebar.',
        });
        return;
      case 'tool-toggles-set':
        await this.applyToolToggles(message.payload, {
          logMessage: 'Tool toggles updated from the Galaxy Code sidebar.',
        });
        return;
      case 'extension-tool-toggles-set':
        await this.applyExtensionToolToggles(message.payload, {
          logMessage: 'Extension tool toggles updated from the Galaxy Code sidebar.',
        });
        return;
      case 'composer-command':
        await this.handleComposerCommand(message.payload.id);
        return;
      case 'attachment-add-local': {
        const attachment = createDraftLocalAttachment({
          workspacePath: this.workspacePath,
          name: message.payload.name,
          mimeType: message.payload.mimeType,
          dataUrl: message.payload.dataUrl,
        });
        await this.postMessage({
          type: 'local-attachment-added',
          payload: { attachment },
        });
        return;
      }
      case 'attachment-remove':
        removeDraftAttachment(this.workspacePath, message.payload.attachmentId);
        return;
      case 'review-open':
        await this.openReviewPanel();
        return;
      case 'review-finding-dismiss':
        await this.dismissReviewFindingTool(message.payload.findingId);
        return;
      case 'review-finding-apply':
        await this.applyReviewFinding(message.payload.findingId);
        return;
      case 'revert-all-changes':
        await this.revertAllTrackedChanges();
        return;
      case 'revert-file-change':
        await this.revertTrackedFileChange(message.payload.filePath);
        return;
      case 'resolve-figma-attachment': {
        const attachment = message.payload.purpose === 'attach'
          ? createDraftFigmaAttachment(this.workspacePath, message.payload.importId)
          : buildFigmaAttachment(this.workspacePath, message.payload.importId);
        if (!attachment) {
          await this.postMessage({
            type: 'error',
            payload: { message: `Figma import not found in this workspace: ${message.payload.importId}` },
          });
          return;
        }

        await this.postMessage({
          type: 'figma-attachment-resolved',
          payload: { attachment, purpose: message.payload.purpose },
        });
        return;
      }
      case 'chat-send': {
        const content = message.payload.content.trim();
        const figmaImportIds = [...new Set(message.payload.figmaImportIds ?? [])];
        if ((!content && figmaImportIds.length === 0) || this.isRunning) {
          return;
        }

        this.selectedAgent = message.payload.agent;
        this.persistSelectedAgent();
        this.updateWorkbenchChrome();
        const nextQualityPreferences = Object.freeze({
          reviewEnabled: message.payload.reviewEnabled ?? this.qualityPreferences.reviewEnabled,
          validateEnabled: message.payload.validateEnabled ?? this.qualityPreferences.validateEnabled,
          fullAccessEnabled: message.payload.fullAccessEnabled ?? this.qualityPreferences.fullAccessEnabled,
        });
        if (
          nextQualityPreferences.reviewEnabled !== this.qualityPreferences.reviewEnabled ||
          nextQualityPreferences.validateEnabled !== this.qualityPreferences.validateEnabled ||
          nextQualityPreferences.fullAccessEnabled !== this.qualityPreferences.fullAccessEnabled
        ) {
          await this.applyQualityPreferences(nextQualityPreferences, {
            syncVsCodeSettings: true,
          });
        }
        const clientMessageId = createMessageId();
        const attachmentIds = message.payload.attachmentIds ?? [];
        if (attachmentIds.length) {
          commitAttachments(this.workspacePath, attachmentIds, clientMessageId);
        }
        const messageAttachments = buildMessageAttachments(this.workspacePath, attachmentIds);
        const messageImages = buildAttachmentImagePaths(this.workspacePath, attachmentIds);
        const figmaAttachments = figmaImportIds
          .map((importId) => buildFigmaAttachment(this.workspacePath, importId))
          .filter((item): item is FigmaAttachment => item !== null);
        const transcriptFigmaAttachments = figmaAttachments.map((attachment) => ({
          importId: attachment.importId,
          label: attachment.label,
          summary: attachment.summary,
        }));
        const userContent = content || 'Implement the attached Figma design in the current workspace.';
        const userMessage: ChatMessage = {
          id: clientMessageId,
          role: 'user',
          content: userContent,
          ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
          ...(messageImages.length > 0 ? { images: messageImages } : {}),
          ...(transcriptFigmaAttachments.length > 0 ? { figmaAttachments: transcriptFigmaAttachments } : {}),
          timestamp: Date.now(),
        };
        this.messages.push(userMessage);
        this.appendTranscriptMessage(userMessage);
        this.appendLog('info', `User prompt sent with agent ${this.selectedAgent}.`);
        this.appendLog(
          'info',
          `Capability snapshot: ${Object.entries(this.toolCapabilities)
            .filter(([, enabled]) => enabled)
            .map(([capability]) => capability)
            .sort()
            .join(', ') || 'none'}.`,
        );
        this.debugChatMessage(userMessage);
        this.clearStreamingBuffers();

        this.isRunning = true;
        this.statusText = `Running ${this.selectedAgent}`;
        await this.postRunState();

        this.progressReporter = null;

        let hadError = false;
        let thinkingLogged = false;
        let emptyContinueAttempt = 0;
        try {
              const config = this.getEffectiveConfig();
              const selectedFilesContext = await buildSelectedFilesContextNote({
                selectedFiles: message.payload.selectedFiles,
                workspaceRoot: this.getWorkspaceRoot(),
              });
              const attachmentContext = await buildAttachmentContextNote(
                this.workspacePath,
                attachmentIds,
                userMessage.content,
              );
              const figmaContext = buildAttachedFigmaContextNote(this.workspacePath, figmaImportIds);
              const baseComponentContext = buildBaseComponentContextNote(this.workspacePath);
              const contextNote = [selectedFilesContext, attachmentContext, figmaContext, baseComponentContext]
                .filter(Boolean)
                .join('\n\n');
              this.writeDebug(
                'turn-context',
                `agent=${this.selectedAgent} selected_files=${message.payload.selectedFiles.length} attachments=${attachmentIds.length} figma=${figmaImportIds.length} context_len=${contextNote.length}`,
              );
              if (contextNote.trim()) {
                this.writeDebugBlock('turn-context-note', contextNote);
              }
              const multiAgentResult = await this.runSelectiveMultiAgentPlan({
                config,
                agentType: this.selectedAgent,
                originalUserMessage: userMessage,
                ...(contextNote ? { contextNote } : {}),
              });

              const result = multiAgentResult.handled
                ? {
                    assistantText: '',
                    assistantThinking: '',
                    errorMessage: undefined,
                    filesWritten: multiAgentResult.filesWritten,
                  }
                : await (async () => {
                    this.historyManager.startTurn(userMessage, contextNote);
                    return runExtensionChat({
                      config,
                      agentType: this.selectedAgent,
                      historyManager: this.historyManager,
                      toolContext: {
                        workspaceRoot: this.workspacePath,
                        config,
                        revealFile: async (filePath, range) => this.revealFile(filePath, range),
                        refreshWorkspaceFiles: async () => this.refreshWorkspaceFiles(),
                        openTrackedDiff: async (filePath) => this.openTrackedDiffTool(filePath),
                        showProblems: async (filePath) => this.showProblemsTool(filePath),
                        workspaceSearch: async (query, options) => this.workspaceSearchTool(query, options),
                        findReferences: async (filePath, options) => this.findReferencesTool(filePath, options),
                        executeExtensionCommand: async (commandId, title, extensionId) =>
                          this.executeExtensionCommandTool(commandId, title, extensionId),
                        invokeLanguageModelTool: async (toolName, title, extensionId, input) =>
                          this.invokeLanguageModelToolTool(toolName, title, extensionId, input),
                        searchExtensionTools: async (query, maxResults) =>
                          this.searchExtensionToolsTool(query, maxResults),
                        activateExtensionTools: async (toolKeys) =>
                          this.activateExtensionToolsTool(toolKeys),
                        getLatestTestFailure: async () => this.getLatestTestFailureTool(),
                        getLatestReviewFindings: async () => this.getLatestReviewFindingsTool(),
                        getNextReviewFinding: async () => this.getNextReviewFindingTool(),
                        dismissReviewFinding: async (findingId) => this.dismissReviewFindingTool(findingId),
                        onProjectCommandStart: async (payload) => this.emitCommandStreamStart(payload),
                        onProjectCommandChunk: async (payload) => this.emitCommandStreamChunk(payload),
                        onProjectCommandEnd: async (payload) => this.emitCommandStreamEnd(payload),
                        onProjectCommandComplete: async (payload) => {
                          await this.handleBackgroundCommandCompletion(payload);
                        },
                      },
                      onChunk: async (chunk) => {
                        if (chunk.type === 'text') {
                          await this.emitAssistantStream(chunk.delta);
                          return;
                        }

                        if (chunk.type === 'thinking') {
                          if (!thinkingLogged && chunk.delta.trim()) {
                            thinkingLogged = true;
                            this.appendLog('status', `Received thinking stream from ${this.selectedAgent}.`);
                          }
                          await this.emitAssistantThinking(chunk.delta);
                          return;
                        }

                        if (chunk.type === 'error') {
                          hadError = true;
                          await this.postMessage({
                            type: 'error',
                            payload: { message: chunk.message },
                          });
                          this.showWorkbenchError(chunk.message);
                        }
                      },
                      onMessage: async (chatMessage) => {
                        this.debugChatMessage(chatMessage);
                        await this.addMessage(chatMessage);
                      },
                      onToolCalls: async (toolCalls) => {
                        this.writeDebugBlock(
                          'turn-tool-calls',
                          JSON.stringify(
                            toolCalls.map((toolCall) => ({
                              id: toolCall.id,
                              name: toolCall.name,
                              params: toolCall.params,
                            })),
                            null,
                            2,
                          ),
                        );
                      },
                      onStatus: async (statusText) => {
                        this.statusText = statusText;
                        this.appendLog('status', statusText);
                        this.reportProgress(statusText);
                        await this.postRunState();
                      },
                      onEvidenceContext: async (payload) => {
                        if (payload.manualReadBatchItems?.length) {
                          this.appendLog('info', `Manual read plan: ${payload.manualReadBatchItems[0]}`);
                        }
                        if (payload.readPlanProgressItems?.length) {
                          this.appendLog(
                            'info',
                            `Read plan progress: ${payload.confirmedReadCount ?? 0}/${payload.readPlanProgressItems.length} confirmed`,
                          );
                        }
                        this.writeDebugBlock(
                          'manual-read-plan',
                          [
                            payload.focusSymbols?.length ? `Focus symbols: ${payload.focusSymbols.join(', ')}` : '',
                            payload.manualPlanningContent ?? '',
                            payload.manualReadBatchItems?.map((item, index) => `Batch ${index + 1}: ${item}`).join('\n') ?? '',
                            payload.readPlanProgressItems
                              ?.map((item) => `${item.confirmed ? '[confirmed]' : '[pending]'} ${item.label}`)
                              .join('\n') ?? '',
                          ]
                            .filter(Boolean)
                            .join('\n\n'),
                        );
                        await this.postMessage({
                          type: 'evidence-context',
                          payload,
                        });
                      },
                      requestToolApproval: async (approval) => this.requestToolApproval(approval),
                    });
                  })();

              if (multiAgentResult.handled) {
                hadError = multiAgentResult.hadError;
              }

              if (multiAgentResult.handled) {
                this.writeDebug(
                  'turn-result',
                  `agent=${this.selectedAgent} phase4 handled had_error=${hadError} files_written=${result.filesWritten.length}`,
                );
                if (!hadError && result.filesWritten.length > 0) {
                  await this.runValidationAndReviewFlow(this.selectedAgent);
                }
              } else if (result.errorMessage && !hadError) {
                hadError = true;
                this.historyManager.clearCurrentTurn();
                this.writeDebug(
                  'turn-result',
                  `agent=${this.selectedAgent} error text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
                );
                if (result.assistantThinking.trim()) {
                  this.writeDebugBlock('turn-error-thinking', result.assistantThinking);
                }
                if (result.assistantText.trim()) {
                  this.writeDebugBlock('turn-error-content', result.assistantText);
                }
                await this.postMessage({
                  type: 'error',
                  payload: { message: result.errorMessage },
                });
                this.showWorkbenchError(result.errorMessage);
              } else if (result.assistantText.trim()) {
                this.writeDebug(
                  'turn-result',
                  `agent=${this.selectedAgent} success text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
                );
                this.writeDebugBlock('turn-final-content', result.assistantText);
                if (result.assistantThinking.trim()) {
                  this.writeDebugBlock('turn-final-thinking', result.assistantThinking);
                }
                if (!result.assistantThinking.trim()) {
                  this.appendLog('status', `No thinking stream was returned by ${this.selectedAgent} for this turn.`);
                }
                const gateFinalConclusion = this.shouldGateAssistantFinalMessage(result.filesWritten);
                this.historyManager.finalizeTurn({
                  assistantText: result.assistantText,
                  commitConclusion: !gateFinalConclusion,
                });
                let publishAssistantMessage = true;
                if (gateFinalConclusion) {
                  if (this.streamingAssistant || this.streamingThinking) {
                    this.clearStreamingBuffers();
                    await this.postInit();
                  }
                  const qualityOutcome = await this.runValidationAndReviewFlow(this.selectedAgent);
                  publishAssistantMessage = qualityOutcome.passed && !qualityOutcome.repaired;
                } else if (result.filesWritten.length > 0) {
                  await this.runValidationAndReviewFlow(this.selectedAgent);
                }
                if (publishAssistantMessage) {
                  const assistantMessage: ChatMessage = {
                    id: createMessageId(),
                    role: 'assistant',
                    content: result.assistantText,
                    ...(result.assistantThinking.trim() ? { thinking: result.assistantThinking } : {}),
                    timestamp: Date.now(),
                  };
                  await this.addMessage(assistantMessage);
                }
              } else if (!hadError) {
                this.writeDebug(
                  'turn-result',
                  `agent=${this.selectedAgent} empty text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
                );
                if (result.assistantThinking.trim()) {
                  this.writeDebugBlock('turn-empty-thinking', result.assistantThinking);
                }
                const previousTurn = this.historyManager.getWorkingTurn();
                this.historyManager.clearCurrentTurn();
                if (emptyContinueAttempt < MAX_EMPTY_CONTINUE_ATTEMPTS) {
                  emptyContinueAttempt += 1;
                  this.appendLog('status', `Empty assistant result detected. Auto-continuing (${emptyContinueAttempt}/${MAX_EMPTY_CONTINUE_ATTEMPTS})...`);
                  this.writeDebug(
                    'turn-empty-continue',
                    `agent=${this.selectedAgent} attempt=${emptyContinueAttempt}`,
                  );
                  const continueResult = await this.runInternalRepairTurn({
                    config: this.getEffectiveConfig(),
                    agentType: this.selectedAgent,
                    userMessage: this.buildContinueMessage({
                      attempt: emptyContinueAttempt,
                      lastUserGoal: previousTurn?.userMessage.content,
                      lastThinking: result.assistantThinking,
                      filesWritten: result.filesWritten,
                      recentToolSummaries: previousTurn?.toolDigests.map((digest) => digest.summary) ?? [],
                    }),
                  });
                  hadError = continueResult.hadError;
                  if (!hadError && continueResult.filesWritten.length > 0) {
                    await this.runValidationAndReviewFlow(this.selectedAgent);
                  }
                }
              }
        } catch (error) {
          hadError = true;
          this.historyManager.clearCurrentTurn();
          this.appendLog('error', `Runtime error: ${String(error)}`);
          this.writeDebug('turn-crash', String(error));
          const runtimeError = `Runtime error: ${String(error)}`;
          await this.postMessage({
            type: 'error',
            payload: { message: runtimeError },
          });
          this.showWorkbenchError(runtimeError);
        } finally {
          this.isRunning = false;
          this.statusText = hadError ? 'Run failed' : 'Ready';
          await this.postRunState();
          await this.flushBackgroundCommandCompletions();
          this.progressReporter = null;
        }
        return;
      }
    }
  }

  private buildStructuredValidationRepairPrompt(result: FinalValidationResult): string {
    const issueLines = result.runs
      .flatMap((run) => run.issues.map((issue) => {
        const location = [
          issue.filePath ?? '',
          typeof issue.line === 'number' ? `:${issue.line}` : '',
          typeof issue.column === 'number' ? `:${issue.column}` : '',
        ].join('');
        return `- [${issue.severity.toUpperCase()}] ${location || run.command}: ${issue.message}`;
      }))
      .slice(0, 20);

    const lines = [
      'Final validation failed.',
      'Fix the reported issues with the smallest safe changes possible.',
      'Prioritize compiler, type, and syntax errors first.',
      '',
      ...issueLines,
    ];

    if (issueLines.length === 0) {
      lines.push(result.summary);
    }

    return lines.join('\n').trim();
  }

  private buildValidationRepairMessage(result: FinalValidationResult, attempt: number): ChatMessage {
    return Object.freeze({
      id: `validation-repair-${Date.now()}-${attempt}`,
      role: 'user',
      content:
        '[SYSTEM VALIDATION FEEDBACK]\n' +
        'Final validation failed after the previous implementation attempt.\n\n' +
        'You must fix the reported issues with the smallest safe code changes possible.\n' +
        'Do not restart the task. Continue from the current workspace state.\n\n' +
        this.buildStructuredValidationRepairPrompt(result),
      timestamp: Date.now(),
    });
  }

  private buildStructuredReviewRepairPrompt(review: ReviewResult): string {
    const lines = review.findings
      .filter((finding) => finding.severity === 'critical' || finding.severity === 'warning')
      .slice(0, 20)
      .map((finding) => `- [${finding.severity.toUpperCase()}] ${finding.location}: ${finding.message}`);

    if (lines.length === 0) {
      lines.push(review.review.trim());
    }

    return [
      'Code review found issues that should be fixed before finishing.',
      'Treat review findings as advisory, not ground truth.',
      'Prioritize critical issues first, then warnings that affect correctness or maintainability.',
      'Before editing, verify each finding against the current workspace state.',
      'If a finding is stale, already fixed, or incorrect after user edits/reverts, do not change code for it.',
      'Make the smallest safe changes needed.',
      '',
      ...lines,
    ].join('\n').trim();
  }

  private buildReviewRepairMessage(review: ReviewResult, attempt: number): ChatMessage {
    return Object.freeze({
      id: `review-repair-${Date.now()}-${attempt}`,
      role: 'user',
      content:
        '[SYSTEM CODE REVIEW FEEDBACK]\n' +
        'The reviewer found issues after the last implementation attempt.\n\n' +
        'Fix the reported issues with the smallest safe changes possible.\n' +
        'Verify each finding against the current files before editing.\n' +
        'Do not blindly trust stale or incorrect review findings.\n' +
        'Do not restart the task. Continue from the current workspace state.\n\n' +
        this.buildStructuredReviewRepairPrompt(review),
      timestamp: Date.now(),
    });
  }

  private buildContinueMessage(opts: {
    attempt: number;
    lastUserGoal?: string;
    lastThinking?: string;
    filesWritten?: readonly string[];
    recentToolSummaries?: readonly string[];
  }): ChatMessage {
    const lines = [
      '[SYSTEM CONTINUATION]',
      'The previous reply ended without a final user-facing answer.',
      'Continue from the current workspace state.',
      'Do not restart the task and do not repeat the same read/edit cycle unless fresh evidence is truly required.',
      'If you already inspected or edited a file in the previous attempt, prefer moving forward to completion instead of reopening the same file again.',
    ];

    if (opts.lastUserGoal?.trim()) {
      lines.push(`Last user goal: ${opts.lastUserGoal.trim()}`);
    }

    if (opts.filesWritten?.length) {
      lines.push(`Files already changed in the previous attempt: ${opts.filesWritten.join(', ')}`);
    }

    if (opts.recentToolSummaries?.length) {
      lines.push('Recent tool actions:');
      opts.recentToolSummaries.slice(-6).forEach((item) => lines.push(`- ${item}`));
    }

    if (opts.lastThinking?.trim()) {
      lines.push(`Last thinking snapshot: ${opts.lastThinking.trim().slice(0, 400)}`);
    }

    lines.push('Return either the next concrete action that advances the task or the final answer if the task is already complete.');

    return Object.freeze({
      id: `continue-${Date.now()}-${opts.attempt}`,
      role: 'user',
      content: lines.join('\n\n'),
      timestamp: Date.now(),
    });
  }

  private shouldGateAssistantFinalMessage(filesWritten: readonly string[]): boolean {
    if (filesWritten.length === 0) {
      return false;
    }
    return this.qualityPreferences.reviewEnabled || this.qualityPreferences.validateEnabled;
  }

  private async runSelectiveMultiAgentPlan(opts: {
    config: ReturnType<typeof loadConfig>;
    agentType: AgentType;
    originalUserMessage: ChatMessage;
    contextNote?: string;
  }): Promise<Readonly<{ handled: boolean; hadError: boolean; filesWritten: readonly string[] }>> {
    const plan = maybeBuildSelectiveMultiAgentPlan(opts.agentType, opts.originalUserMessage.content);
    if (!plan) {
      return Object.freeze({ handled: false, hadError: false, filesWritten: Object.freeze([]) });
    }

    await this.addMessage({
      ...createAssistantMessage(buildSelectiveMultiAgentPlanMessage(plan)),
      agentType: opts.agentType,
    });
    this.appendLog('info', `Selective multi-agent plan activated: ${plan.subtasks.map((subtask) => subtask.id).join(', ')}.`);

    const coderConfig = buildCoderSubAgentConfig(opts.config);
    const written = new Set<string>();
    let hadError = false;
    const hasDesignContext =
      Boolean(opts.originalUserMessage.images?.length) ||
      Boolean(opts.originalUserMessage.figmaAttachments?.length) ||
      Boolean(
        opts.originalUserMessage.attachments?.some(
          (attachment) => attachment.kind === 'figma' || attachment.kind === 'image',
        ),
      );

    for (let index = 0; index < plan.subtasks.length; index += 1) {
      const subtask = plan.subtasks[index]!;
      const subtaskLabel = `Sub-agent ${index + 1}/${plan.subtasks.length}: ${subtask.title}`;
      this.statusText = subtaskLabel;
      this.appendLog('status', subtaskLabel);
      this.reportProgress(subtaskLabel);
      await this.postRunState();

      const result = await this.runInternalRepairTurn({
        config: coderConfig,
        agentType: opts.agentType,
        userMessage: buildSelectiveMultiAgentSubtaskMessage({
          originalUserMessage: opts.originalUserMessage,
          subtask,
        }),
        ...(
          opts.contextNote &&
          (index === 0 || (hasDesignContext && (subtask.id === 'frontend' || subtask.id === 'integration')))
            ? { contextNote: opts.contextNote }
            : {}
        ),
      });

      for (const filePath of result.filesWritten) {
        written.add(filePath);
      }
      appendTelemetryEvent(this.workspacePath, {
        kind: 'sub_agent_turn',
        scope: subtask.id,
        filesWritten: result.filesWritten.length,
        hadError: result.hadError,
      });

      if (result.hadError) {
        hadError = true;
        break;
      }
    }

    appendTelemetryEvent(this.workspacePath, {
      kind: 'multi_agent_plan',
      subtaskCount: plan.subtasks.length,
      scopes: plan.subtasks.map((subtask) => subtask.id),
      completed: !hadError,
      filesWritten: written.size,
    });

    return Object.freeze({
      handled: true,
      hadError,
      filesWritten: Object.freeze([...written]),
    });
  }

  private async runInternalRepairTurn(opts: {
    config: ReturnType<typeof loadConfig>;
    agentType: AgentType;
    userMessage: ChatMessage;
    contextNote?: string;
    emptyContinueAttempt?: number;
  }): Promise<Readonly<{ hadError: boolean; filesWritten: readonly string[] }>> {
    let hadError = false;
    let thinkingLogged = false;
    this.historyManager.startTurn(opts.userMessage, opts.contextNote);
    this.debugChatMessage(opts.userMessage);

    const result = await runExtensionChat({
      config: opts.config,
      agentType: opts.agentType,
      historyManager: this.historyManager,
      toolContext: {
        workspaceRoot: this.workspacePath,
        config: opts.config,
        revealFile: async (filePath, range) => this.revealFile(filePath, range),
        refreshWorkspaceFiles: async () => this.refreshWorkspaceFiles(),
        openTrackedDiff: async (filePath) => this.openTrackedDiffTool(filePath),
        showProblems: async (filePath) => this.showProblemsTool(filePath),
        workspaceSearch: async (query, options) => this.workspaceSearchTool(query, options),
        findReferences: async (filePath, options) => this.findReferencesTool(filePath, options),
        executeExtensionCommand: async (commandId, title, extensionId) =>
          this.executeExtensionCommandTool(commandId, title, extensionId),
        invokeLanguageModelTool: async (toolName, title, extensionId, input) =>
          this.invokeLanguageModelToolTool(toolName, title, extensionId, input),
        searchExtensionTools: async (query, maxResults) =>
          this.searchExtensionToolsTool(query, maxResults),
        activateExtensionTools: async (toolKeys) =>
          this.activateExtensionToolsTool(toolKeys),
        getLatestTestFailure: async () => this.getLatestTestFailureTool(),
        getLatestReviewFindings: async () => this.getLatestReviewFindingsTool(),
        getNextReviewFinding: async () => this.getNextReviewFindingTool(),
        dismissReviewFinding: async (findingId) => this.dismissReviewFindingTool(findingId),
        onProjectCommandStart: async (payload) => this.emitCommandStreamStart(payload),
        onProjectCommandChunk: async (payload) => this.emitCommandStreamChunk(payload),
        onProjectCommandEnd: async (payload) => this.emitCommandStreamEnd(payload),
        onProjectCommandComplete: async (payload) => {
          await this.handleBackgroundCommandCompletion(payload);
        },
      },
      onChunk: async (chunk) => {
        if (chunk.type === 'text') {
          await this.emitAssistantStream(chunk.delta);
          return;
        }

        if (chunk.type === 'thinking') {
          if (!thinkingLogged && chunk.delta.trim()) {
            thinkingLogged = true;
            this.appendLog('status', `Received thinking stream from ${opts.agentType}.`);
          }
          await this.emitAssistantThinking(chunk.delta);
          return;
        }

        if (chunk.type === 'error') {
          hadError = true;
          await this.postMessage({
            type: 'error',
            payload: { message: chunk.message },
          });
          this.showWorkbenchError(chunk.message);
        }
      },
      onMessage: async (chatMessage) => {
        this.debugChatMessage(chatMessage);
        await this.addMessage(chatMessage);
      },
      onToolCalls: async (toolCalls) => {
        this.writeDebugBlock(
          'repair-turn-tool-calls',
          JSON.stringify(
            toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              params: toolCall.params,
            })),
            null,
            2,
          ),
        );
      },
      onStatus: async (statusText) => {
        this.statusText = statusText;
        this.reportProgress(statusText);
        await this.postRunState();
      },
      onEvidenceContext: async (payload) => {
        this.writeDebugBlock(
          'repair-manual-read-plan',
          [
            payload.focusSymbols?.length ? `Focus symbols: ${payload.focusSymbols.join(', ')}` : '',
            payload.manualPlanningContent ?? '',
            payload.manualReadBatchItems?.map((item, index) => `Batch ${index + 1}: ${item}`).join('\n') ?? '',
            payload.readPlanProgressItems
              ?.map((item) => `${item.confirmed ? '[confirmed]' : '[pending]'} ${item.label}`)
              .join('\n') ?? '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
        await this.postMessage({
          type: 'evidence-context',
          payload,
        });
      },
      requestToolApproval: async (approval) => this.requestToolApproval(approval),
    });

    if (result.errorMessage && !hadError) {
      hadError = true;
      this.historyManager.clearCurrentTurn();
      this.writeDebug(
        'repair-turn-result',
        `agent=${opts.agentType} error text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
      );
      if (result.assistantThinking.trim()) {
        this.writeDebugBlock('repair-turn-thinking', result.assistantThinking);
      }
      if (result.assistantText.trim()) {
        this.writeDebugBlock('repair-turn-content', result.assistantText);
      }
      await this.postMessage({
        type: 'error',
        payload: { message: result.errorMessage },
      });
    } else if (result.assistantText.trim()) {
      this.writeDebug(
        'repair-turn-result',
        `agent=${opts.agentType} success text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
      );
      this.writeDebugBlock('repair-turn-content', result.assistantText);
      if (result.assistantThinking.trim()) {
        this.writeDebugBlock('repair-turn-thinking', result.assistantThinking);
      }
      if (!result.assistantThinking.trim()) {
        this.appendLog('status', `No thinking stream was returned by ${opts.agentType} for this turn.`);
      }
      this.historyManager.finalizeTurn({
        assistantText: result.assistantText,
        commitConclusion: !this.shouldGateAssistantFinalMessage(result.filesWritten),
      });
      if (!this.shouldGateAssistantFinalMessage(result.filesWritten)) {
        const assistantMessage: ChatMessage = {
          id: createMessageId(),
          role: 'assistant',
          content: result.assistantText,
          agentType: this.selectedAgent,
          ...(result.assistantThinking.trim() ? { thinking: result.assistantThinking } : {}),
          timestamp: Date.now(),
        };
        await this.addMessage(assistantMessage);
      } else if (this.streamingAssistant || this.streamingThinking) {
        this.clearStreamingBuffers();
        await this.postInit();
      }
    } else if (!hadError) {
      this.writeDebug(
        'repair-turn-result',
        `agent=${opts.agentType} empty text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
      );
      const previousTurn = this.historyManager.getWorkingTurn();
      this.historyManager.clearCurrentTurn();

      const emptyContinueAttempt = opts.emptyContinueAttempt ?? 0;
      if (emptyContinueAttempt < MAX_EMPTY_CONTINUE_ATTEMPTS) {
        const nextAttempt = emptyContinueAttempt + 1;
        this.appendLog('status', `Empty assistant result detected. Auto-continuing (${nextAttempt}/${MAX_EMPTY_CONTINUE_ATTEMPTS})...`);
        this.writeDebug(
          'turn-empty-continue',
          `agent=${opts.agentType} attempt=${nextAttempt} repair_turn=true`,
        );

        const nextResult = await this.runInternalRepairTurn({
          ...opts,
          userMessage: this.buildContinueMessage({
            attempt: nextAttempt,
            lastUserGoal: previousTurn?.userMessage.content,
            lastThinking: result.assistantThinking,
            filesWritten: result.filesWritten,
            recentToolSummaries: previousTurn?.toolDigests.map((digest) => digest.summary) ?? [],
          }),
          emptyContinueAttempt: nextAttempt,
        });

        return Object.freeze({
          hadError: nextResult.hadError,
          filesWritten: Object.freeze([...new Set([...result.filesWritten, ...nextResult.filesWritten])]),
        });
      }

      hadError = true;
      const message =
        result.filesWritten.length > 0
          ? `Agent stopped after writing ${result.filesWritten.length} file(s) but still returned no final summary after ${MAX_EMPTY_CONTINUE_ATTEMPTS} auto-continue attempts.`
          : `Agent returned an empty result after ${MAX_EMPTY_CONTINUE_ATTEMPTS} auto-continue attempts.`;
      this.appendLog('error', message);
      await this.postMessage({
        type: 'error',
        payload: { message },
      });
      this.showWorkbenchError(message);
    }

    return Object.freeze({
      hadError,
      filesWritten: result.filesWritten,
    });
  }

  private async runValidationAndReviewFlow(agentType: AgentType): Promise<Readonly<{ passed: boolean; repaired: boolean }>> {
    const initialConfig = this.getEffectiveConfig();
    const shouldRunValidation = initialConfig.toolCapabilities.validation;
    const shouldRunReview = initialConfig.toolCapabilities.review;

    if (!shouldRunValidation && !shouldRunReview) {
      return Object.freeze({ passed: true, repaired: false });
    }

    let validationRepairAttempt = 0;
    let reviewRepairAttempt = 0;
    let currentAgent = agentType;
    let repaired = false;

    for (;;) {
      const sessionFiles = getSessionFiles();
      if (sessionFiles.length === 0) {
        return Object.freeze({ passed: true, repaired });
      }

      if (shouldRunReview) {
        this.statusText = 'Running review quality gate';
        this.reportProgress(this.statusText);
        await this.postRunState();
        this.appendLog('review', 'Running blocking review quality gate...');
        const reviewResult = await runCodeReview({
          sessionFiles,
          config: this.getEffectiveConfig(),
          agentType: currentAgent,
        });

        if (!reviewResult) {
          return Object.freeze({ passed: false, repaired });
        }

        if (!reviewResult.success) {
          this.appendLog('review', 'Code reviewer failed to complete successfully.');
          await this.postMessage({
            type: 'error',
            payload: { message: reviewResult.review },
          });
          this.showWorkbenchError(reviewResult.review);
          return Object.freeze({ passed: false, repaired });
        }

        const structuredFindings = Object.freeze(
          reviewResult.findings.map((finding, index) =>
            Object.freeze({
              id: `review-${Date.now()}-${index + 1}`,
              severity: finding.severity,
              location: finding.location,
              message: finding.message,
              status: 'open' as const,
            }),
          ),
        );
        this.updateQualityDetails({
          reviewSummary: formatReviewSummary(reviewResult),
          reviewFindings: structuredFindings,
        });
        this.persistProjectMetaPatch((previousMeta) =>
          previousMeta
            ? {
                ...previousMeta,
                latestReviewFindings: Object.freeze({
                  capturedAt: Date.now(),
                  summary: reviewResult.hadCritical
                    ? 'Critical review findings available.'
                    : reviewResult.hadWarnings
                      ? 'Review warnings available.'
                      : 'Review completed with no actionable findings.',
                  findings: structuredFindings,
                }),
              }
            : null,
        );
        const reviewEntryTurnId = `review-${Date.now()}`;
        appendTaskMemoryEntry(this.workspacePath, {
          workspaceId: this.projectStorage.workspaceId,
          turnId: reviewEntryTurnId,
          turnKind: 'review',
          userIntent: 'Code review findings after implementation.',
          assistantConclusion: reviewResult.review.slice(0, 2_400),
          filesJson: JSON.stringify(sessionFiles.map((file) => file.filePath)),
          confidence: 0.9,
          freshnessScore: 1,
          createdAt: Date.now(),
        });
        replaceTaskMemoryFindings(
          this.workspacePath,
          reviewEntryTurnId,
          structuredFindings.map((finding) =>
            Object.freeze({
              id: finding.id,
              entryTurnId: reviewEntryTurnId,
              kind: 'review_finding' as const,
              summary: `${finding.location}: ${finding.message}`,
              status: finding.status ?? 'open',
              createdAt: Date.now(),
            }),
          ),
        );
        this.appendLog(
          'review',
          !reviewResult.hadCritical && !reviewResult.hadWarnings
            ? 'Code review completed with no actionable findings.'
            : 'Code review produced actionable findings.',
        );

        if (reviewResult.hadCritical || reviewResult.hadWarnings) {
          if (reviewRepairAttempt >= MAX_AUTO_REVIEW_REPAIR_ATTEMPTS) {
            return Object.freeze({ passed: false, repaired });
          }

          reviewRepairAttempt += 1;
          repaired = true;
          await this.addMessage(
            createAssistantMessage(
              `Attempting automatic repair from code review findings (${reviewRepairAttempt}/${MAX_AUTO_REVIEW_REPAIR_ATTEMPTS})...`,
            ),
          );

          const repairResult = await this.runInternalRepairTurn({
            config: this.getEffectiveConfig(),
            agentType: currentAgent,
            userMessage: this.buildReviewRepairMessage(reviewResult, reviewRepairAttempt),
          });

          if (repairResult.hadError || repairResult.filesWritten.length === 0) {
            return Object.freeze({ passed: false, repaired });
          }

          continue;
        }
      }

      if (!shouldRunValidation) {
        return Object.freeze({ passed: true, repaired });
      }

      this.appendLog('validation', `Running blocking validation quality gate for ${sessionFiles.length} changed files.`);
      this.statusText = 'Running validation quality gate';
      this.reportProgress(this.statusText);
      await this.postRunState();
      const validationResult = await runFinalValidation({
        workspacePath: this.workspacePath,
        sessionFiles,
        config: this.getEffectiveConfig(),
        streamCallbacks: {
          onStart: async (payload) => this.emitCommandStreamStart(payload),
          onChunk: async (payload) => this.emitCommandStreamChunk(payload),
          onEnd: async (payload) => this.emitCommandStreamEnd(payload),
        },
      });
      this.appendLog('validation', validationResult.selectionSummary);
      this.updateQualityDetails({
        validationSummary: formatValidationSummary(validationResult),
      });
      const latestFailedRun = validationResult.runs.find((run) => !run.success && run.category === 'test')
        ?? validationResult.runs.find((run) => !run.success);
      this.persistProjectMetaPatch((previousMeta) =>
        previousMeta
          ? {
              ...previousMeta,
              ...(latestFailedRun
                ? {
                    latestTestFailure: Object.freeze({
                      capturedAt: Date.now(),
                      summary: latestFailedRun.summary,
                      command: latestFailedRun.command,
                      profile: latestFailedRun.profile,
                      category: latestFailedRun.category,
                      issues: latestFailedRun.issues,
                    }),
                  }
                : { latestTestFailure: undefined }),
              }
            : null,
      );
      if (latestFailedRun) {
        const validationEntryTurnId = `validation-${Date.now()}`;
        appendTaskMemoryEntry(this.workspacePath, {
          workspaceId: this.projectStorage.workspaceId,
          turnId: validationEntryTurnId,
          turnKind: 'validation',
          userIntent: 'Final validation result for changed files.',
          assistantConclusion: latestFailedRun.summary.slice(0, 2_400),
          filesJson: JSON.stringify(sessionFiles.map((file) => file.filePath)),
          confidence: 0.95,
          freshnessScore: 1,
          createdAt: Date.now(),
        });
        replaceTaskMemoryFindings(
          this.workspacePath,
          validationEntryTurnId,
          (latestFailedRun.issues.length > 0
            ? latestFailedRun.issues.map((issue, index) =>
                Object.freeze({
                  id: `validation-${validationEntryTurnId}-${index + 1}`,
                  entryTurnId: validationEntryTurnId,
                  kind: 'validation_failure' as const,
                  summary: issue.message,
                  ...(issue.filePath ? { filePath: issue.filePath } : {}),
                  ...(typeof issue.line === 'number' ? { line: issue.line } : {}),
                  status: 'open' as const,
                  createdAt: Date.now(),
                }),
              )
            : [
                Object.freeze({
                  id: `validation-${validationEntryTurnId}-summary`,
                  entryTurnId: validationEntryTurnId,
                  kind: 'validation_failure' as const,
                  summary: latestFailedRun.summary,
                  status: 'open' as const,
                  createdAt: Date.now(),
                }),
              ]),
        );
      }
      this.appendLog(
        'validation',
        validationResult.success ? 'Final validation passed.' : 'Final validation failed.',
      );

      if (validationResult.success) {
        return Object.freeze({ passed: true, repaired });
      }

      if (validationRepairAttempt >= MAX_AUTO_REPAIR_ATTEMPTS) {
        return Object.freeze({ passed: false, repaired });
      }

      validationRepairAttempt += 1;
      repaired = true;
      await this.addMessage(
        createAssistantMessage(
          `Attempting automatic repair from final validation errors (${validationRepairAttempt}/${MAX_AUTO_REPAIR_ATTEMPTS})...`,
        ),
      );

      const repairResult = await this.runInternalRepairTurn({
        config: this.getEffectiveConfig(),
        agentType: currentAgent,
        userMessage: this.buildValidationRepairMessage(validationResult, validationRepairAttempt),
      });

      if (repairResult.hadError || repairResult.filesWritten.length === 0) {
        return Object.freeze({ passed: false, repaired });
      }
    }
  }

  clearHistory(): void {
    this.resetWorkspaceSession();
    this.statusText = 'Session cleared';
    this.appendLog('info', 'Session history and runtime state were cleared.');
    this.updateWorkbenchChrome();

    void this.postInit();
  }

  private loadSelectedAgent(): AgentType {
    const stored = this.context.workspaceState.get<string>(SELECTED_AGENT_STORAGE_KEY);
    return isAgentType(stored) ? stored : 'manual';
  }

  private persistSelectedAgent(): void {
    void this.context.workspaceState.update(SELECTED_AGENT_STORAGE_KEY, this.selectedAgent);
  }

  private getSelectedAgentDetail(): string {
    const config = loadConfig();
    const agentConfig = getAgentConfig(config, this.selectedAgent);
    if (!agentConfig) {
      return 'No configured model';
    }

    const parts = [
      agentConfig.model?.trim(),
      agentConfig.baseUrl?.trim(),
    ].filter((value): value is string => Boolean(value));

    return parts.join(' · ') || 'Configured in ~/.galaxy/config.json';
  }

  private getApprovalModeSummary(): Readonly<{ label: string; tooltip: string }> {
    if (this.pendingApprovalRequestId) {
      return Object.freeze({
        label: 'Pending',
        tooltip: this.pendingApprovalTitle ?? 'A Galaxy Code tool is waiting for approval.',
      });
    }

    const config = loadConfig();
    const approvalFlags = [
      ['Git pull', config.toolSafety.requireApprovalForGitPull],
      ['Git push', config.toolSafety.requireApprovalForGitPush],
      ['Git checkout', config.toolSafety.requireApprovalForGitCheckout],
      ['Delete path', config.toolSafety.requireApprovalForDeletePath],
      ['Scaffold', config.toolSafety.requireApprovalForScaffold],
      ['Project command', config.toolSafety.requireApprovalForProjectCommand],
    ] as const;
    const enabled = approvalFlags.filter(([, requiresApproval]) => requiresApproval).map(([label]) => label);

    if (enabled.length === 0) {
      return Object.freeze({
        label: this.qualityPreferences.fullAccessEnabled ? 'Full' : 'Off',
        tooltip: this.qualityPreferences.fullAccessEnabled
          ? 'run_project_command, git pull/push/checkout, delete_path, and scaffold actions can run without asking for approval.'
          : 'No tool approvals are currently required.',
      });
    }

    if (enabled.length === approvalFlags.length) {
      return Object.freeze({
        label: 'On',
        tooltip: 'All supported write-capable tools currently require approval.',
      });
    }

    return Object.freeze({
      label: 'Mixed',
      tooltip: `Approvals required for: ${enabled.join(', ')}`,
    });
  }

  private updateWorkbenchChrome(): void {
    const runIcon = this.isRunning ? 'sync~spin' : 'check';
    this.chrome.runStatusItem.text = `$(${runIcon}) Galaxy ${this.statusText}`;
    this.chrome.runStatusItem.tooltip = this.isRunning
      ? `Galaxy Code is running.\n${this.statusText}\n\nClick to open runtime logs.`
      : `Galaxy Code is idle.\n${this.statusText}\n\nClick to open runtime logs.`;

    const agentLabel = getAgentLabel(this.selectedAgent);
    const agentDetail = this.getSelectedAgentDetail();
    this.chrome.agentStatusItem.text = `$(hubot) ${agentLabel}`;
    this.chrome.agentStatusItem.tooltip = `Current agent: ${agentLabel}\n${agentDetail}\n\nClick to switch agent.`;

    const approval = this.getApprovalModeSummary();
    const approvalIcon = this.pendingApprovalRequestId ? 'warning' : 'shield';
    this.chrome.approvalStatusItem.text = `$(${approvalIcon}) Approvals ${approval.label}`;
    this.chrome.approvalStatusItem.tooltip = `${approval.tooltip}\n\nClick to open the Galaxy Code config folder.`;
  }

  private async postSelectedAgentUpdate(): Promise<void> {
    this.updateWorkbenchChrome();
    await this.postMessage({
      type: 'selected-agent-updated',
      payload: { selectedAgent: this.selectedAgent },
    });
  }

  private persistProjectMetaPatch(
    mutate: (previous: ProjectMeta | null) => ProjectMeta | null,
  ): void {
    const previousMeta = loadProjectMeta(this.projectStorage);
    saveProjectMeta(this.projectStorage, mutate(previousMeta));
  }

  private async getLatestTestFailureTool(): Promise<ToolResult> {
    const meta = loadProjectMeta(this.projectStorage);
    const latest = meta?.latestTestFailure;
    if (!latest) {
      return Object.freeze({
        success: false,
        content: '',
        error: 'No latest test failure is stored for this workspace.',
      });
    }

    const lines = [
      `Latest test failure: ${latest.summary}`,
      `Command: ${latest.command}`,
      `Profile: ${latest.profile} / ${latest.category}`,
      '',
      ...latest.issues.slice(0, 20).map((issue) => {
        const location = [
          issue.filePath ?? '',
          typeof issue.line === 'number' ? `:${issue.line}` : '',
          typeof issue.column === 'number' ? `:${issue.column}` : '',
        ].join('');
        return `- [${issue.severity.toUpperCase()}] ${location || issue.source}: ${issue.message}`;
      }),
    ];

    return Object.freeze({
      success: true,
      content: lines.join('\n').trim(),
      meta: Object.freeze({
        capturedAt: latest.capturedAt,
        issuesCount: latest.issues.length,
      }),
    });
  }

  private async getLatestReviewFindingsTool(): Promise<ToolResult> {
    const meta = loadProjectMeta(this.projectStorage);
    const latest = meta?.latestReviewFindings;
    if (!latest) {
      return Object.freeze({
        success: false,
        content: '',
        error: 'No latest review findings are stored for this workspace.',
      });
    }

    const lines = [
      `Latest review findings: ${latest.summary}`,
      '',
      ...latest.findings.slice(0, 20).map(
        (finding) => `- [${finding.severity.toUpperCase()}] (${finding.id}) [${finding.status ?? 'open'}] ${finding.location}: ${finding.message}`,
      ),
    ];

    return Object.freeze({
      success: true,
      content: lines.join('\n').trim(),
      meta: Object.freeze({
        capturedAt: latest.capturedAt,
        findingsCount: latest.findings.length,
      }),
    });
  }

  private async getNextReviewFindingTool(): Promise<ToolResult> {
    const meta = loadProjectMeta(this.projectStorage);
    const latest = meta?.latestReviewFindings;
    const finding = latest?.findings.find((item) => (item.status ?? 'open') !== 'dismissed');
    if (!latest || !finding) {
      return Object.freeze({
        success: false,
        content: '',
        error: 'No open review finding is stored for this workspace.',
      });
    }

    return Object.freeze({
      success: true,
      content: `Next review finding (${finding.id})\n[${finding.severity.toUpperCase()}] ${finding.location}: ${finding.message}`,
      meta: Object.freeze({
        findingId: finding.id,
        severity: finding.severity,
        location: finding.location,
      }),
    });
  }

  private async dismissReviewFindingTool(findingId: string): Promise<ToolResult> {
    const trimmedId = findingId.trim();
    if (!trimmedId) {
      return Object.freeze({
        success: false,
        content: '',
        error: 'finding_id is required.',
      });
    }

    const previousMeta = loadProjectMeta(this.projectStorage);
    const latest = previousMeta?.latestReviewFindings;
    if (!previousMeta || !latest) {
      return Object.freeze({
        success: false,
        content: '',
        error: 'No latest review findings are stored for this workspace.',
      });
    }

    const nextFindings = latest.findings.map((finding) =>
      finding.id === trimmedId ? Object.freeze({ ...finding, status: 'dismissed' as const }) : finding,
    );
    const updated = nextFindings.find((finding) => finding.id === trimmedId);
    if (!updated) {
      return Object.freeze({
        success: false,
        content: '',
        error: `Review finding not found: ${trimmedId}`,
      });
    }

    this.persistProjectMetaPatch((current) =>
      current
        ? {
            ...current,
            latestReviewFindings: Object.freeze({
              ...latest,
              findings: Object.freeze(nextFindings),
            }),
          }
        : null,
    );
    this.updateQualityDetails({
      reviewFindings: Object.freeze(nextFindings),
    });
    updateTaskMemoryFindingStatus(this.workspacePath, trimmedId, 'dismissed');

    return Object.freeze({
      success: true,
      content: `Dismissed review finding ${trimmedId}`,
      meta: Object.freeze({
        findingId: trimmedId,
      }),
    });
  }

  private async applyReviewFinding(findingId: string): Promise<void> {
    if (this.isRunning) {
      return;
    }

    const meta = loadProjectMeta(this.projectStorage);
    const latest = meta?.latestReviewFindings;
    const finding = latest?.findings.find((item) => item.id === findingId && (item.status ?? 'open') !== 'dismissed');
    if (!finding) {
      await this.postMessage({
        type: 'error',
        payload: { message: `Review finding not found or already dismissed: ${findingId}` },
      });
      return;
    }

    const repairMessage: ChatMessage = Object.freeze({
      id: `review-finding-apply-${Date.now()}`,
      role: 'user',
      content:
        '[SYSTEM REVIEW FINDING APPLY]\n' +
        'Fix exactly this review finding with the smallest safe change.\n' +
        'Verify the finding against the current workspace state before editing.\n' +
        'Do not rewrite unrelated code and do not restart the task.\n\n' +
        `Finding id: ${finding.id}\n` +
        `Severity: ${finding.severity}\n` +
        `Location: ${finding.location}\n` +
        `Message: ${finding.message}`,
      timestamp: Date.now(),
    });

    this.clearStreamingBuffers();
    this.isRunning = true;
    this.statusText = 'Applying review finding';
    await this.postRunState();

    const result = await this.runInternalRepairTurn({
      config: this.getEffectiveConfig(),
      agentType: this.selectedAgent,
      userMessage: repairMessage,
    });

    this.isRunning = false;
    this.statusText = result.hadError ? 'Review finding apply failed' : 'Review finding applied';
    await this.postRunState();

    if (result.hadError) {
      return;
    }

    if (result.filesWritten.length > 0) {
      await this.dismissReviewFindingTool(finding.id);
      await this.runValidationAndReviewFlow(this.selectedAgent);
    }
  }

  private async postRunState(): Promise<void> {
    this.updateWorkbenchChrome();
    await this.postMessage({
      type: 'run-state',
      payload: { isRunning: this.isRunning, statusText: this.statusText },
    });
  }

  private reportProgress(message: string): void {
    this.progressReporter?.report({ message });
  }

  private showWorkbenchError(message: string): void {
    void vscode.window.showErrorMessage(message, 'Open Galaxy Code', 'Show Logs').then(async (selection) => {
      if (selection === 'Open Galaxy Code') {
        await this.reveal();
        return;
      }

      if (selection === 'Show Logs') {
        this.chrome.outputChannel.show(true);
      }
    });
  }

  private showApprovalNotification(title: string): void {
    void vscode.window.showWarningMessage(title, 'Open Galaxy Code', 'Show Logs').then(async (selection) => {
      if (selection === 'Open Galaxy Code') {
        await this.reveal();
        return;
      }

      if (selection === 'Show Logs') {
        this.chrome.outputChannel.show(true);
      }
    });
  }

  private async postInit(): Promise<void> {
    this.updateWorkbenchChrome();
    this.refreshExtensionToolGroups();
    const files = await this.getWorkspaceFiles();
    const changeSummary = this.buildChangeSummaryPayload();
    const meta = loadProjectMeta(this.projectStorage);
    await this.refreshNativeShellViews(files, changeSummary);
    const payload: SessionInitPayload = {
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? 'Workspace',
      files,
      messages: this.messages.slice(-MAX_WEBVIEW_MESSAGE_COUNT).map((message) => sanitizeChatMessageForWebview(message)),
      selectedAgent: this.selectedAgent,
      phase: 'phase-8',
      isRunning: this.isRunning,
      statusText: this.statusText,
      planItems: this.buildPhasePlanItems(),
      logs: [...this.runtimeLogs],
      qualityDetails: Object.freeze({
        ...this.qualityDetails,
        reviewFindings: meta?.latestReviewFindings?.findings ?? this.qualityDetails.reviewFindings ?? Object.freeze([]),
      }),
      qualityPreferences: this.qualityPreferences,
      toolCapabilities: this.toolCapabilities,
      toolToggles: this.toolToggles,
      extensionToolGroups: this.extensionToolGroups,
      extensionToolToggles: this.extensionToolToggles,
      changeSummary,
      ...(this.streamingAssistant ? { streamingAssistant: this.streamingAssistant } : {}),
      ...(this.streamingThinking ? { streamingThinking: this.streamingThinking } : {}),
      ...(this.activeShellSessions.size > 0
        ? { activeShellSessions: [...this.activeShellSessions.values()].sort((a, b) => a.startedAt - b.startedAt) }
        : {}),
      ...(this.pendingApprovalPayload ? { approvalRequest: this.pendingApprovalPayload } : {}),
    };

    await this.postMessage({ type: 'session-init', payload });
  }

  private async postMessage(message: HostMessage): Promise<void> {
    const targets: vscode.Webview[] = [];
    if (this.view) {
      targets.push(this.view.webview);
    }
    if (this.panel) {
      targets.push(this.panel.webview);
    }
    if (targets.length === 0) {
      return;
    }
    await Promise.all(targets.map((target) => target.postMessage(message)));
  }

  private async getWorkspaceFiles(): Promise<SessionInitPayload['files']> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [];
    }

    const activePath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : '';

    if (activePath) {
      this.selectedFiles.add(activePath);
    }

    const uris = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,dist,out,.git,.next,.nuxt,coverage,.turbo,build}/**',
      250,
    );

    return uris
      .filter((uri) => uri.scheme === 'file')
      .map((uri) => uri.fsPath)
      .sort((left, right) => this.asWorkspaceRelative(left).localeCompare(this.asWorkspaceRelative(right)))
      .map((filePath) => ({
        path: filePath,
        label: this.asWorkspaceRelative(filePath),
        selected: this.selectedFiles.has(filePath),
      }));
  }

  private getWorkspaceName(): string {
    return vscode.workspace.workspaceFolders?.[0]?.name ?? 'Workspace';
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getEffectiveConfig(): GalaxyConfig {
    return buildEffectiveConfig(
      loadConfig(),
      loadProjectMeta(this.projectStorage),
      this.qualityPreferences,
      this.extensionToolGroups,
    );
  }

  private resolveStorageWorkspacePath(): string {
    return this.getWorkspaceRoot() ?? path.join(os.homedir(), '.galaxy', '__vscode-no-workspace__');
  }

  private loadInitialMessages(): ChatMessage[] {
    const transcript = loadUiTranscript(this.projectStorage.uiTranscriptPath, { maxMessages: 200 });
    if (transcript.length > 0) {
      this.statusText = `Resumed ${transcript.length} messages`;
      this.appendLog('info', `Resumed ${transcript.length} transcript messages for this workspace.`);
      return [...transcript];
    }

    this.appendLog('info', 'Started a fresh Galaxy Code VS Code session.');
    return [];
  }

  private appendTranscriptMessage(message: ChatMessage): void {
    appendUiTranscriptMessage(this.projectStorage.uiTranscriptPath, message);
  }

  private async handleFigmaImport(record: FigmaImportRecord): Promise<void> {
    this.appendLog('info', `Received Figma import ${record.importId}.`);
  }

  private async handleComposerCommand(commandId: 'config' | 'reset' | 'clear'): Promise<void> {
    if (commandId === 'config') {
      loadConfig();
      await openGalaxyConfigDir();
      this.appendLog('info', `Opened Galaxy config directory: ${getConfigDir()}`);
      return;
    }

    if (commandId === 'reset') {
      await this.applyQualityPreferences(Object.freeze({
        reviewEnabled: false,
        validateEnabled: false,
        fullAccessEnabled: false,
      }), {
        syncVsCodeSettings: true,
      });
      this.appendLog('info', 'Reset config: review=false, validate=false, fullAccess=false.');
      return;
    }

    this.resetWorkspaceSession({ removeProjectDir: true });
    this.statusText = 'Workspace cleared';
    this.appendLog('info', `Cleared current workspace storage under ${path.join(getConfigDir(), 'projects')}.`);
    await this.postInit();
  }

  async openRuntimeLogs(): Promise<void> {
    this.chrome.outputChannel.appendLine('');
    this.chrome.outputChannel.appendLine(`[Galaxy Code] Runtime logs for ${this.getWorkspaceName()}`);
    this.chrome.outputChannel.appendLine('[Galaxy Code] Use the VS Code Terminal for live command output.');
    this.chrome.outputChannel.show(true);
  }

  async openTelemetrySummary(): Promise<void> {
    const summary = loadTelemetrySummary(this.workspacePath);
    this.chrome.outputChannel.appendLine('');
    this.chrome.outputChannel.appendLine(formatTelemetrySummary(summary));
    this.chrome.outputChannel.show(true);
  }

  async showAgentQuickPick(): Promise<void> {
    if (this.isRunning) {
      vscode.window.showInformationMessage('Galaxy Code is currently running. Switch the agent after the current turn finishes.');
      return;
    }

    const config = loadConfig();
    const quickPickItems = AGENT_TYPES.map((agentType) => {
      const agentConfig = getAgentConfig(config, agentType);
      const detail = [agentConfig?.model?.trim(), agentConfig?.baseUrl?.trim()]
        .filter((value): value is string => Boolean(value))
        .join(' · ') || 'Configured in ~/.galaxy/config.json';

      return Object.freeze({
        label: getAgentLabel(agentType),
        description: agentType === this.selectedAgent ? 'Current' : '',
        detail,
        agentType,
      });
    });

    const selection = await vscode.window.showQuickPick(quickPickItems, {
      title: 'Galaxy Code Agent',
      placeHolder: 'Select the agent for the next Galaxy Code run',
      ignoreFocusOut: true,
    });

    if (!selection || selection.agentType === this.selectedAgent) {
      return;
    }

    this.selectedAgent = selection.agentType;
    this.persistSelectedAgent();
    await this.postSelectedAgentUpdate();
    this.appendLog('info', `Selected agent changed to ${this.selectedAgent}.`);
  }

  private resetWorkspaceSession(opts?: { removeProjectDir?: boolean }): void {
    if (opts?.removeProjectDir) {
      try {
        fs.rmSync(this.projectStorage.projectDirPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
      ensureProjectStorage(this.projectStorage);
      saveProjectMeta(this.projectStorage, null);
    } else {
      clearUiTranscript(this.projectStorage.uiTranscriptPath);
    }

    this.historyManager.clearAll();
    clearActionApprovals(this.workspacePath);
    clearSession();
    this.runtimeLogs = [];
    this.qualityDetails = Object.freeze({
      validationSummary: '',
      reviewSummary: '',
    });
    this.messages = [];
    this.isRunning = false;
    this.pendingApprovalRequestId = null;
    this.pendingApprovalResolver = null;
    this.pendingApprovalTitle = null;
    this.pendingApprovalPayload = null;
    this.progressReporter = null;
    this.activeShellSessions.clear();
    this.commandTerminalRegistry.clear();
    try {
      fs.rmSync(this.projectStorage.commandContextPath, { force: true });
    } catch {
      // ignore context cleanup failures
    }
    this.streamingAssistant = '';
    this.streamingThinking = '';
    this.updateWorkbenchChrome();
  }

  private async addMessage(message: ChatMessage): Promise<void> {
    const lastMessage = this.messages[this.messages.length - 1];
    if (
      message.role === 'assistant' &&
      lastMessage?.role === 'assistant' &&
      (message.agentType ?? this.selectedAgent) === (lastMessage.agentType ?? this.selectedAgent) &&
      (
        (
          message.content.trim() === lastMessage.content.trim() &&
          (message.thinking ?? '').trim() === (lastMessage.thinking ?? '').trim()
        ) ||
        (
          Boolean(lastMessage.toolCalls?.length) &&
          message.content.trim().length > 0 &&
          message.content.trim() === lastMessage.content.trim()
        )
      )
    ) {
      this.appendLog('info', 'Skipped duplicate assistant message.');
      return;
    }

    this.messages.push(message);
    if (message.role === 'assistant') {
      this.clearStreamingBuffers();
    }
    this.appendTranscriptMessage(message);
    await this.postMessage({
      type: 'message-added',
      payload: sanitizeChatMessageForWebview(message),
    });
  }

  private writeDebug(scope: string, message: string): void {
    writeDebugLine(this.projectStorage.debugLogPath, scope, message);
  }

  private writeDebugBlock(scope: string, content: string): void {
    if (!content.trim()) {
      this.writeDebug(scope, '(empty)');
      return;
    }

    const normalized = content.replace(/\r\n/g, '\n');
    const truncated =
      normalized.length > MAX_DEBUG_BLOCK_CHARS
        ? `${normalized.slice(0, MAX_DEBUG_BLOCK_CHARS)}\n\n...[truncated ${normalized.length - MAX_DEBUG_BLOCK_CHARS} chars]`
        : normalized;
    const lines = truncated.split('\n');
    this.writeDebug(scope, `BEGIN (${normalized.length} chars)`);
    for (const line of lines) {
      writeDebugLine(this.projectStorage.debugLogPath, scope, line);
    }
    this.writeDebug(scope, 'END');
  }

  private debugChatMessage(message: ChatMessage): void {
    if (message.role === 'assistant') {
      const agentLabel = message.agentType ?? this.selectedAgent;
      this.writeDebug(
        'assistant-message',
        `agent=${agentLabel} text_len=${message.content.length} thinking_len=${message.thinking?.length ?? 0} tool_calls=${message.toolCalls?.length ?? 0}`,
      );
      this.writeDebugBlock('assistant-content', message.content);
      if (message.thinking?.trim()) {
        this.writeDebugBlock('assistant-thinking', message.thinking);
      }
      if (message.toolCalls?.length) {
        this.writeDebugBlock(
          'assistant-tool-calls',
          JSON.stringify(
            message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              params: toolCall.params,
            })),
            null,
            2,
          ),
        );
      }
      return;
    }

    if (message.role === 'tool') {
      this.writeDebug(
        'tool-message',
        `name=${message.toolName ?? '(unknown)'} success=${String(message.toolSuccess ?? false)} call_id=${message.toolCallId ?? '(none)'}`,
      );
      if (message.toolParams) {
        this.writeDebugBlock('tool-params', JSON.stringify(message.toolParams, null, 2));
      }
      this.writeDebugBlock('tool-content', message.content);
      return;
    }

    if (message.role === 'user') {
      this.writeDebug(
        'user-message',
        `text_len=${message.content.length} attachments=${message.attachments?.length ?? 0} figma=${message.figmaAttachments?.length ?? 0} images=${message.images?.length ?? 0}`,
      );
    }
  }

  private async createTempFile(name: string, content: string): Promise<vscode.Uri> {
    const diffDir = vscode.Uri.file(path.join(os.tmpdir(), 'galaxy-code-vscode-diffs'));
    await vscode.workspace.fs.createDirectory(diffDir);
    const target = vscode.Uri.file(path.join(diffDir.fsPath, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    return target;
  }

  private resolveWorkspaceFilePath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(this.workspacePath, filePath);
  }

  private async openWorkspaceFile(filePath: string): Promise<void> {
    const targetPath = this.resolveWorkspaceFilePath(filePath);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async revealFile(filePath: string, range?: { startLine: number; endLine: number }): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    if (!range) {
      return;
    }

    const maxStartLine = Math.max(0, Math.min(range.startLine - 1, document.lineCount - 1));
    const maxEndLine = Math.max(maxStartLine, Math.min(range.endLine - 1, document.lineCount - 1));
    const selection = new vscode.Range(
      new vscode.Position(maxStartLine, 0),
      new vscode.Position(maxEndLine, document.lineAt(maxEndLine).range.end.character),
    );
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(selection.start, selection.end);
  }

  private async openDiff(originalUri: vscode.Uri, modifiedPath: string, title: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', originalUri, vscode.Uri.file(modifiedPath), title);
  }

  private async openTrackedDiff(filePath: string): Promise<void> {
    const originalContent = getOriginalContent(filePath);
    if (typeof originalContent === 'undefined') {
      this.appendLog('info', `No tracked diff snapshot exists yet for ${this.asWorkspaceRelative(filePath)}.`);
      await this.postMessage({
        type: 'error',
        payload: { message: `No tracked diff snapshot exists yet for ${this.asWorkspaceRelative(filePath)}.` },
      });
      return;
    }

    const originalUri = await this.createTempFile(
      `${path.basename(filePath)}.original`,
      originalContent ?? '',
    );
    this.appendLog('info', `Opened tracked diff for ${this.asWorkspaceRelative(filePath)}.`);
    await this.openDiff(originalUri, filePath, `Session Diff: ${this.asWorkspaceRelative(filePath)}`);
  }

  private async openTrackedDiffTool(filePath: string): Promise<ToolResult> {
    try {
      const targetPath = this.resolveWorkspaceFilePath(filePath);
      if (typeof getOriginalContent(targetPath) === 'undefined') {
        return Object.freeze({
          success: false,
          content: '',
          error: `No tracked diff snapshot exists yet for ${this.asWorkspaceRelative(targetPath)}.`,
        });
      }
      await this.openTrackedDiff(targetPath);
      return Object.freeze({
        success: true,
        content: `Opened native diff for ${this.asWorkspaceRelative(targetPath)}.`,
        meta: Object.freeze({
          filePath: targetPath,
          operation: 'open_diff',
        }),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        content: '',
        error: String(error),
      });
    }
  }

  private async showProblemsTool(filePath?: string): Promise<ToolResult> {
    try {
      const targetPath = filePath ? this.resolveWorkspaceFilePath(filePath) : '';
      const targetUri = targetPath ? vscode.Uri.file(targetPath) : undefined;
      const diagnostics = targetUri
        ? vscode.languages.getDiagnostics(targetUri)
        : vscode.languages.getDiagnostics().flatMap((entry) => entry[1]);
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      const summaryLines = diagnostics.slice(0, 20).map((diagnostic) => {
        const severity =
          diagnostic.severity === vscode.DiagnosticSeverity.Error
            ? 'error'
            : diagnostic.severity === vscode.DiagnosticSeverity.Warning
            ? 'warning'
            : diagnostic.severity === vscode.DiagnosticSeverity.Information
            ? 'info'
            : 'hint';
        return `- [${severity}] line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`;
      });
      return Object.freeze({
        success: true,
        content:
          summaryLines.length > 0
            ? summaryLines.join('\n')
            : targetPath
            ? `No diagnostics for ${this.asWorkspaceRelative(targetPath)}.`
            : 'No diagnostics in Problems view.',
        meta: Object.freeze({
          ...(targetPath ? { filePath: targetPath } : {}),
          issuesCount: diagnostics.length,
          operation: 'show_problems',
        }),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        content: '',
        error: String(error),
      });
    }
  }

  private async workspaceSearchTool(
    query: string,
    options?: Readonly<{
      includes?: string;
      maxResults?: number;
      isRegex?: boolean;
      isCaseSensitive?: boolean;
      matchWholeWord?: boolean;
    }>,
  ): Promise<ToolResult> {
    try {
      const maxResults = Math.max(1, Math.min(options?.maxResults ?? 20, 100));
      const matches: Array<{ filePath: string; line: number; preview: string }> = [];
      await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query,
        triggerSearch: true,
        isRegex: Boolean(options?.isRegex),
        isCaseSensitive: Boolean(options?.isCaseSensitive),
        matchWholeWord: Boolean(options?.matchWholeWord),
        ...(options?.includes ? { filesToInclude: options.includes } : {}),
      });
      const uris = await vscode.workspace.findFiles(
        options?.includes ? new vscode.RelativePattern(this.workspacePath, options.includes) : '**/*',
        '**/{node_modules,dist,build,.git,.next,.turbo,.cache}/**',
        Math.max(maxResults * 5, 50),
      );
      const regex = options?.isRegex
        ? new RegExp(query, `${options.isCaseSensitive ? '' : 'i'}g`)
        : null;
      const needle = options?.isCaseSensitive ? query : query.toLowerCase();
      for (const uri of uris) {
        if (matches.length >= maxResults) {
          break;
        }
        try {
          const document = await vscode.workspace.openTextDocument(uri);
          for (let index = 0; index < document.lineCount; index += 1) {
            if (matches.length >= maxResults) {
              break;
            }
            const text = document.lineAt(index).text;
            const haystack = options?.isCaseSensitive ? text : text.toLowerCase();
            const matched = regex ? regex.test(text) : haystack.includes(needle);
            if (!matched) {
              if (regex) {
                regex.lastIndex = 0;
              }
              continue;
            }
            if (regex) {
              regex.lastIndex = 0;
            }
            const preview = text.trim().replace(/\s+/g, ' ');
            matches.push({
              filePath: uri.fsPath,
              line: index,
              preview,
            });
          }
        } catch {
          continue;
        }
      }
      const lines =
        matches.length > 0
          ? matches.map((match) => `- ${this.asWorkspaceRelative(match.filePath)}:${match.line + 1} — ${match.preview}`)
          : ['(no matches)'];
      return Object.freeze({
        success: true,
        content: lines.join('\n'),
        meta: Object.freeze({
          query,
          matches: matches.length,
          ...(options?.includes ? { includes: options.includes } : {}),
          operation: 'workspace_search',
        }),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        content: '',
        error: String(error),
      });
    }
  }

  private async findReferencesTool(
    filePath: string,
    options?: Readonly<{
      line?: number;
      character?: number;
      symbol?: string;
      maxResults?: number;
    }>,
  ): Promise<ToolResult> {
    try {
      const targetPath = this.resolveWorkspaceFilePath(filePath);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });

      let position: vscode.Position | null = null;
      if (typeof options?.line === 'number') {
        const line = Math.max(0, Math.min(options.line - 1, document.lineCount - 1));
        const character = Math.max(0, Math.min((options.character ?? 1) - 1, document.lineAt(line).text.length));
        position = new vscode.Position(line, character);
      } else if (options?.symbol) {
        const text = document.getText();
        const index = text.indexOf(options.symbol);
        if (index >= 0) {
          position = document.positionAt(index);
        }
      }

      if (!position) {
        return Object.freeze({
          success: false,
          content: '',
          error: 'Unable to determine a symbol position for vscode_find_references. Provide line/character or a symbol that exists in the file.',
        });
      }

      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      const references =
        (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          document.uri,
          position,
        )) ?? [];
      const maxResults = Math.max(1, Math.min(options?.maxResults ?? 20, 100));
      const lines = references.slice(0, maxResults).map((location) => {
        const relative = this.asWorkspaceRelative(location.uri.fsPath);
        return `- ${relative}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
      });
      return Object.freeze({
        success: true,
        content: lines.length > 0 ? lines.join('\n') : '(no references)',
        meta: Object.freeze({
          filePath: targetPath,
          referencesCount: references.length,
          operation: 'find_references',
        }),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        content: '',
        error: String(error),
      });
    }
  }

  private async executeExtensionCommandTool(
    commandId: string,
    title: string,
    extensionId: string,
  ): Promise<ToolResult> {
    try {
      await vscode.commands.executeCommand(commandId);
      const label = title.trim() || commandId;
      this.appendLog('info', `Executed public extension command ${commandId} from ${extensionId}.`);
      return Object.freeze({
        success: true,
        content: `Executed extension command "${label}" from ${extensionId}.`,
        meta: Object.freeze({
          commandId,
          extensionId,
          operation: 'extension_command',
        }),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        content: '',
        error: `Extension command failed (${commandId}): ${String(error)}`,
      });
    }
  }

  private async invokeLanguageModelToolTool(
    toolName: string,
    title: string,
    extensionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<ToolResult> {
    try {
      const result = await vscode.lm.invokeTool(
        toolName,
        {
          toolInvocationToken: undefined,
          input: { ...input },
        },
      );
      const parts = result.content.map((part) => {
        if (part instanceof vscode.LanguageModelTextPart) {
          return part.value;
        }
        if (part instanceof vscode.LanguageModelDataPart) {
          const decoded = Buffer.from(part.data).toString('utf8');
          if (part.mimeType.includes('json')) {
            return decoded;
          }
          return decoded;
        }
        if (part instanceof vscode.LanguageModelPromptTsxPart) {
          return JSON.stringify(part.value, null, 2);
        }
        try {
          return JSON.stringify(part, null, 2);
        } catch {
          return String(part);
        }
      });
      const label = title.trim() || toolName;
      const content = parts.filter(Boolean).join('\n').trim();
      this.appendLog('info', `Invoked LM tool ${toolName} from ${extensionId}.`);
      return Object.freeze({
        success: true,
        content: content || `Invoked language model tool "${label}" from ${extensionId}.`,
        meta: Object.freeze({
          toolName,
          extensionId,
          operation: 'lm_tool',
        }),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        content: '',
        error: `Language model tool failed (${toolName}): ${String(error)}`,
      });
    }
  }

  private refreshExtensionToolGroups(): void {
    this.extensionToolGroups = discoverExtensionToolGroups(this.context.extension.id);
  }

  private async searchExtensionToolsTool(query: string, maxResults = 8): Promise<ToolResult> {
    try {
      this.refreshExtensionToolGroups();
      const trimmed = query.trim();
      if (!trimmed) {
        return Object.freeze({
          success: false,
          content: '',
          error: 'search_extension_tools requires a non-empty query.',
        });
      }

      const groups = searchExtensionToolGroups(
        this.extensionToolGroups,
        trimmed,
        Math.max(1, Math.min(maxResults, 12)),
        8,
      );

      if (groups.length === 0) {
        return Object.freeze({
          success: true,
          content: '(no matching local extension tools)',
          meta: Object.freeze({
            query: trimmed,
            groups: 0,
            operation: 'search_extension_tools',
          }),
        });
      }

      const lines: string[] = [];
      for (const group of groups) {
        lines.push(`## ${group.label} [${group.extensionId}]`);
        lines.push(group.description);
        lines.push(`source=${group.source}${group.recommended ? ' recommended' : ''}`);
        for (const tool of group.tools) {
          const enabled = this.extensionToolToggles[tool.key] === true ? 'enabled' : 'disabled';
          lines.push(`- key=${tool.key}`);
          lines.push(`  tool=${tool.runtimeName}`);
          lines.push(`  invocation=${tool.invocation}`);
          if (tool.commandId) {
            lines.push(`  command=${tool.commandId}`);
          }
          lines.push(`  status=${enabled}`);
          lines.push(`  desc=${tool.description}`);
        }
        lines.push('');
      }

      return Object.freeze({
        success: true,
        content: lines.join('\n').trim(),
        meta: Object.freeze({
          query: trimmed,
          groups: groups.length,
          operation: 'search_extension_tools',
        }),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        content: '',
        error: String(error),
      });
    }
  }

  private async activateExtensionToolsTool(toolKeys: readonly string[]): Promise<ToolResult> {
    try {
      this.refreshExtensionToolGroups();
      const normalizedKeys = [...new Set(toolKeys.map((item) => item.trim()).filter(Boolean))];
      if (normalizedKeys.length === 0) {
        return Object.freeze({
          success: false,
          content: '',
          error: 'activate_extension_tools requires at least one tool key.',
        });
      }

      const discovered = new Map(
        this.extensionToolGroups.flatMap((group) =>
          group.tools.map((tool) => [tool.key, { group, tool }] as const),
        ),
      );
      const valid = normalizedKeys.filter((key) => discovered.has(key));
      if (valid.length === 0) {
        return Object.freeze({
          success: false,
          content: '',
          error: 'None of the provided tool keys matched the local extension tool catalog.',
        });
      }

      const nextToggles = {
        ...this.extensionToolToggles,
        ...Object.fromEntries(valid.map((key) => [key, true])),
      };
      await this.applyExtensionToolToggles(nextToggles, {
        logMessage: `Activated ${valid.length} extension tool(s) from local catalog.`,
      });

      const lines = valid.map((key) => {
        const item = discovered.get(key)!;
        return `- ${item.tool.runtimeName} (${item.group.label})`;
      });

      return Object.freeze({
        success: true,
        content: `Activated extension tools:\n${lines.join('\n')}`,
        meta: Object.freeze({
          activatedCount: valid.length,
          operation: 'activate_extension_tools',
          toolKeys: Object.freeze(valid),
        }),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        content: '',
        error: String(error),
      });
    }
  }

  private async updateContextFileSelection(
    updates: readonly Readonly<{ filePath: string; selected: boolean }>[],
  ): Promise<void> {
    if (updates.length === 0) {
      return;
    }

    for (const update of updates) {
      const filePath = this.resolveWorkspaceFilePath(update.filePath);
      if (update.selected) {
        this.selectedFiles.add(filePath);
      } else {
        this.selectedFiles.delete(filePath);
      }
    }

    const files = await this.getWorkspaceFiles();
    await this.refreshNativeShellViews(files, this.buildChangeSummaryPayload());
    await this.postMessage({
      type: 'files-updated',
      payload: { files },
    });
    await this.postMessage({
      type: 'selection-updated',
      payload: { selectedFiles: [...this.selectedFiles] },
    });
  }

  private async refreshWorkspaceFiles(): Promise<void> {
    for (const selectedPath of [...this.selectedFiles]) {
      if (!fs.existsSync(selectedPath)) {
        this.selectedFiles.delete(selectedPath);
      }
    }

    const files = await this.getWorkspaceFiles();
    const changeSummary = this.buildChangeSummaryPayload();
    await this.refreshNativeShellViews(files, changeSummary);
    await this.postMessage({
      type: 'files-updated',
      payload: { files },
    });
    await this.postMessage({
      type: 'selection-updated',
      payload: { selectedFiles: [...this.selectedFiles] },
    });
    await this.postChangeSummary(changeSummary);
  }

  private buildChangeSummaryPayload(): ChangeSummary {
    const summary = getSessionChangeSummary();
    return Object.freeze({
      fileCount: summary.fileCount,
      createdCount: summary.createdCount,
      addedLines: summary.addedLines,
      deletedLines: summary.deletedLines,
      files: Object.freeze(summary.files.map((file): ChangedFileSummaryPayload => Object.freeze({
        filePath: file.filePath,
        label: this.asWorkspaceRelative(file.filePath),
        language: file.language,
        wasNew: file.wasNew,
        addedLines: file.addedLines,
        deletedLines: file.deletedLines,
        originalContent: file.originalContent,
        currentContent: file.currentContent,
        diffText: file.diffText,
      }))),
    });
  }

  private async postChangeSummary(changeSummary = this.buildChangeSummaryPayload()): Promise<void> {
    await this.postMessage({
      type: 'change-summary-updated',
      payload: changeSummary,
    });
  }

  private async refreshNativeShellViews(
    files?: readonly FileItem[],
    changeSummary?: ChangeSummary,
  ): Promise<void> {
    if (!this.nativeShellViews) {
      return;
    }

    const nextFiles = files ?? await this.getWorkspaceFiles();
    const nextChangeSummary = changeSummary ?? this.buildChangeSummaryPayload();
    const selectedFileCount = nextFiles.filter((file) => file.selected).length;

    this.nativeShellViews.contextFilesProvider.setFiles(nextFiles);
    this.nativeShellViews.contextFilesView.description =
      nextFiles.length > 0 ? `${selectedFileCount}/${nextFiles.length} selected` : undefined;
    this.nativeShellViews.contextFilesView.message =
      nextFiles.length === 0 ? 'No workspace files found.' : undefined;
    this.nativeShellViews.contextFilesView.badge = selectedFileCount > 0
      ? {
          value: selectedFileCount,
          tooltip: `${selectedFileCount} file(s) selected for prompt context.`,
        }
      : undefined;

    this.nativeShellViews.changedFilesProvider.setFiles(nextChangeSummary.files);
    this.nativeShellViews.changedFilesView.description = nextChangeSummary.fileCount > 0
      ? `+${nextChangeSummary.addedLines} -${nextChangeSummary.deletedLines}`
      : undefined;
    this.nativeShellViews.changedFilesView.message = nextChangeSummary.fileCount === 0
      ? 'No tracked changes in this session.'
      : undefined;
    this.nativeShellViews.changedFilesView.badge = nextChangeSummary.fileCount > 0
      ? {
          value: nextChangeSummary.fileCount,
          tooltip: `${nextChangeSummary.fileCount} tracked file change(s) are ready for review.`,
        }
      : undefined;
  }

  private async focusChangedFilesView(file?: ChangedFileSummaryPayload): Promise<void> {
    await vscode.commands.executeCommand(`workbench.view.extension.${GALAXY_VIEW_CONTAINER_ID}`);
    await vscode.commands.executeCommand(`${CHANGED_FILES_VIEW_ID}.focus`);

    if (!file || !this.nativeShellViews) {
      return;
    }

    try {
      await this.nativeShellViews.changedFilesView.reveal(file, { focus: true, select: true });
    } catch {
      // ignore reveal failures when the view has not resolved its current tree state yet
    }
  }

  private async openNativeReview(): Promise<void> {
    await this.openReviewPanel();
  }

  private async openLegacyChangedFilesReview(): Promise<void> {
    const changeSummary = this.buildChangeSummaryPayload();
    await this.refreshNativeShellViews(undefined, changeSummary);

    if (changeSummary.fileCount === 0) {
      void vscode.window.showInformationMessage('No tracked changes to review in this session.');
      return;
    }

    if (changeSummary.fileCount === 1) {
      const [file] = changeSummary.files;
      if (file) {
        await this.focusChangedFilesView(file);
        await this.openTrackedDiff(file.filePath);
      }
      return;
    }

    const [firstFile] = changeSummary.files;
    await this.focusChangedFilesView(firstFile);
    void vscode.window.showInformationMessage(
      `Review the ${changeSummary.fileCount} changed files in the Changed Files view.`,
    );
  }

  private clearPendingApprovalState(): void {
    this.pendingApprovalResolver = null;
    this.pendingApprovalRequestId = null;
    this.pendingApprovalTitle = null;
    this.pendingApprovalPayload = null;
    this.updateWorkbenchChrome();
  }

  private clearStreamingBuffers(): void {
    this.streamingAssistant = '';
    this.streamingThinking = '';
  }

  private truncateCommandContextOutput(value: string): string {
    if (value.length <= MAX_COMMAND_CONTEXT_OUTPUT_CHARS) {
      return value;
    }
    return value.slice(-MAX_COMMAND_CONTEXT_OUTPUT_CHARS);
  }

  private writeCommandContextFile(payload: Readonly<{
    commandText: string;
    cwd: string;
    success?: boolean;
    exitCode?: number;
    durationMs?: number;
    output?: string;
    changedFiles?: readonly string[];
    running?: boolean;
  }>): CommandContextFile {
    const trimmedOutput = this.truncateCommandContextOutput((payload.output ?? '').trim());
    const status: CommandContextFile['status'] = payload.running
      ? 'running'
      : payload.success === false
        ? 'failed'
        : 'completed';
    const summary = payload.running
      ? 'Command is still running in the VS Code terminal.'
      : payload.success === false
        ? `Command failed with exit code ${payload.exitCode ?? 1}.`
        : `Command completed with exit code ${payload.exitCode ?? 0}.`;
    const nowIso = new Date().toISOString();
    const record: CommandContextFile = Object.freeze({
      command: payload.commandText,
      cwd: payload.cwd,
      status,
      ...(typeof payload.exitCode === 'number' ? { exitCode: payload.exitCode } : {}),
      ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
      tailOutput: trimmedOutput,
      summary,
      changedFiles: Object.freeze([...(payload.changedFiles ?? [])]),
      updatedAt: nowIso,
      ...(!payload.running ? { completedAt: nowIso } : {}),
    });
    fs.writeFileSync(this.projectStorage.commandContextPath, JSON.stringify(record, null, 2), 'utf-8');
    return record;
  }

  private async revealShellTerminal(toolCallId: string): Promise<void> {
    if (this.commandTerminalRegistry.reveal(toolCallId)) {
      return;
    }
    await vscode.window.showWarningMessage('Terminal for this command is no longer available.');
  }

  private async emitAssistantStream(delta: string): Promise<void> {
    this.streamingAssistant += delta;
    await this.postMessage({
      type: 'assistant-stream',
      payload: { delta },
    });
  }

  private async emitAssistantThinking(delta: string): Promise<void> {
    this.streamingThinking += delta;
    await this.postMessage({
      type: 'assistant-thinking',
      payload: { delta },
    });
  }

  private async emitCommandStreamStart(payload: CommandStreamStartPayload): Promise<void> {
    const terminalTitle = this.commandTerminalRegistry.start(
      payload.toolCallId,
      payload.commandText,
      payload.cwd,
    );
    this.activeShellSessions.set(
      payload.toolCallId,
      Object.freeze({
        toolCallId: payload.toolCallId,
        commandText: payload.commandText,
        cwd: payload.cwd,
        startedAt: payload.startedAt,
        output: '',
        terminalTitle,
      }),
    );
    this.writeCommandContextFile({
      commandText: payload.commandText,
      cwd: payload.cwd,
      running: true,
    });
    this.appendLog(
      'status',
      `Terminal command started: ${payload.commandText} (cwd: ${payload.cwd}). Open the VS Code terminal to follow live output.`,
    );
    await this.postMessage({
      type: 'command-stream-start',
      payload: {
        ...payload,
        terminalTitle,
      },
    });
  }

  private async emitCommandStreamChunk(payload: CommandStreamChunkPayload): Promise<void> {
    this.commandTerminalRegistry.append(payload.toolCallId, payload.chunk);
  }

  private async emitCommandStreamEnd(payload: CommandStreamEndPayload): Promise<void> {
    const current = this.activeShellSessions.get(payload.toolCallId);
    if (current) {
      const next = Object.freeze({
        ...current,
        success: payload.success,
        exitCode: payload.exitCode,
        durationMs: payload.durationMs,
        ...(payload.background ? { background: true } : {}),
      });
      this.activeShellSessions.set(payload.toolCallId, next);
      this.appendLog(
        payload.success ? 'status' : 'error',
        `Terminal command ${payload.success ? 'completed' : 'failed'}: ${current.commandText} ` +
        `(exit ${payload.exitCode}, ${Math.max(0, Math.round(payload.durationMs / 1000))}s).`,
      );
    }
    this.commandTerminalRegistry.complete(payload.toolCallId, payload);
    await this.postMessage({
      type: 'command-stream-end',
      payload,
    });
  }

  private shouldUseNativeApprovalPrompt(approval: {
    toolName: string;
    details: readonly string[];
  }): boolean {
    if (approval.toolName !== 'run_project_command' && approval.toolName !== 'run_terminal_command') {
      return false;
    }

    if (approval.details.length === 0 || approval.details.length > 2) {
      return false;
    }

    return approval.details.every((detail) => detail.length <= 160 && !detail.includes('\n'));
  }

  private async requestNativeToolApproval(approval: {
    title: string;
    message: string;
    details: readonly string[];
  }): Promise<ToolApprovalDecision> {
    const allowItem: vscode.MessageItem = { title: 'Cho phep luon' };
    const askItem: vscode.MessageItem = { title: 'Hoi lai' };
    const denyItem: vscode.MessageItem = { title: 'Tu choi', isCloseAffordance: true };
    const selection = await vscode.window.showWarningMessage(
      approval.title,
      {
        modal: true,
        detail: [approval.message, ...approval.details].join('\n'),
      },
      allowItem,
      askItem,
      denyItem,
    );

    if (selection === allowItem) {
      return 'allow';
    }

    if (selection === askItem) {
      return 'ask';
    }

    return 'deny';
  }

  private async revertTrackedFileChange(filePath: string): Promise<void> {
    const result = revertFile(filePath);
    if (!result.success) {
      await this.postMessage({
        type: 'error',
        payload: { message: result.reason },
      });
      return;
    }

    const relativePath = this.asWorkspaceRelative(result.filePath);
    const summaryText = result.wasNew
      ? `User reverted a newly created file: ${relativePath}.`
      : `User reverted changes in file: ${relativePath}.`;
    appendTelemetryEvent(this.workspacePath, {
      kind: 'user_revert',
      fileCount: 1,
    });
    this.historyManager.recordExternalEvent(summaryText, [result.filePath]);
    await this.addMessage(createAssistantMessage(summaryText));
    await this.refreshWorkspaceFiles();
  }

  private async revertAllTrackedChanges(): Promise<void> {
    const result = revertAllSessionFiles();
    if (result.revertedPaths.length === 0 && result.failedReasons.length === 0) {
      return;
    }

    if (result.revertedPaths.length > 0) {
      const revertedLabels = result.revertedPaths.map((filePath) => this.asWorkspaceRelative(filePath));
      const summaryText =
        `User reverted ${result.revertedPaths.length} tracked file change(s): ` +
        revertedLabels.join(', ') +
        '.';
      appendTelemetryEvent(this.workspacePath, {
        kind: 'user_revert',
        fileCount: result.revertedPaths.length,
      });
      this.historyManager.recordExternalEvent(summaryText, result.revertedPaths);
      await this.addMessage(createAssistantMessage(summaryText));
    }

    if (result.failedReasons.length > 0) {
      await this.postMessage({
        type: 'error',
        payload: { message: result.failedReasons.join('\n') },
      });
    }

    await this.refreshWorkspaceFiles();
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private buildReviewRows(file: ChangedFileSummary): readonly Readonly<Record<string, unknown>>[] {
    const originalLines = (file.originalContent ?? '').split('\n');
    const currentLines = (file.currentContent ?? '').split('\n');

    let prefix = 0;
    while (
      prefix < originalLines.length &&
      prefix < currentLines.length &&
      originalLines[prefix] === currentLines[prefix]
    ) {
      prefix += 1;
    }

    let suffix = 0;
    while (
      suffix < originalLines.length - prefix &&
      suffix < currentLines.length - prefix &&
      originalLines[originalLines.length - 1 - suffix] === currentLines[currentLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }

    const rows: Array<Readonly<Record<string, unknown>>> = [];
    if (prefix > 0) {
      rows.push(Object.freeze({ type: 'collapsed', count: prefix }));
    }

    const originalChanged = originalLines.slice(prefix, originalLines.length - suffix);
    const currentChanged = currentLines.slice(prefix, currentLines.length - suffix);
    const maxChanged = Math.max(originalChanged.length, currentChanged.length);
    for (let index = 0; index < maxChanged; index += 1) {
      const leftText = originalChanged[index];
      const rightText = currentChanged[index];
      const leftNumber = typeof leftText === 'string' ? prefix + index + 1 : null;
      const rightNumber = typeof rightText === 'string' ? prefix + index + 1 : null;
      const kind =
        typeof leftText === 'string' && typeof rightText === 'string'
          ? 'modified'
          : typeof leftText === 'string'
            ? 'deleted'
            : 'added';
      rows.push(
        Object.freeze({
          type: 'line',
          kind,
          leftNumber,
          rightNumber,
          leftText: leftText ?? '',
          rightText: rightText ?? '',
        }),
      );
    }

    if (suffix > 0) {
      rows.push(Object.freeze({ type: 'collapsed', count: suffix }));
    }

    if (rows.length === 0) {
      rows.push(
        Object.freeze({
          type: 'line',
          kind: 'unchanged',
          leftNumber: 1,
          rightNumber: 1,
          leftText: originalLines[0] ?? '',
          rightText: currentLines[0] ?? '',
        }),
      );
    }

    return Object.freeze(rows);
  }

  private getReviewPanelHtml(webview: vscode.Webview): string {
    const nonce = createMessageId();
    const summary = getSessionChangeSummary();
    const payload = {
      fileCount: summary.fileCount,
      addedLines: summary.addedLines,
      deletedLines: summary.deletedLines,
      files: summary.files.map((file) => ({
        filePath: file.filePath,
        label: this.asWorkspaceRelative(file.filePath),
        wasNew: file.wasNew,
        addedLines: file.addedLines,
        deletedLines: file.deletedLines,
        rows: this.buildReviewRows(file),
      })),
    };
    const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Galaxy Diff</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #171717; color: #f5f5f5; }
      .app { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
      .sidebar { border-right: 1px solid rgba(255,255,255,0.08); background: #141414; display: flex; flex-direction: column; min-height: 0; }
      .sidebar-header { padding: 18px 18px 14px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .title { font-size: 14px; font-weight: 700; letter-spacing: 0.01em; }
      .meta { margin-top: 10px; color: #c4c4c4; font-size: 12px; }
      .toolbar { display: flex; gap: 8px; margin-top: 14px; }
      button { border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #f5f5f5; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; }
      button:hover { background: rgba(255,255,255,0.08); }
      .file-list { overflow: auto; padding: 10px; display: grid; gap: 8px; }
      .file-item { width: 100%; border: 1px solid rgba(255,255,255,0.06); background: #1b1b1b; color: inherit; text-align: left; padding: 12px; border-radius: 12px; }
      .file-item.active { border-color: rgba(96,165,250,0.45); background: #1f2937; }
      .file-path { font-size: 13px; font-weight: 600; line-height: 1.4; word-break: break-word; }
      .file-stats { margin-top: 6px; font-size: 12px; color: #a3a3a3; }
      .plus { color: #4ade80; }
      .minus { color: #f87171; }
      .content { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .content-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); background: #181818; gap: 16px; }
      .content-title { font-size: 18px; font-weight: 700; }
      .content-subtitle { margin-top: 4px; font-size: 12px; color: #a3a3a3; }
      .content-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
      .mode-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 4px; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; background: rgba(255,255,255,0.03); }
      .mode-toggle button { padding: 6px 10px; border-radius: 8px; border-color: transparent; background: transparent; }
      .mode-toggle button.active { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.08); }
      .diff-wrap { overflow: auto; padding: 16px; min-height: 0; }
      .diff-grid { border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; overflow: hidden; background: #111111; }
      .diff-head, .diff-row, .diff-collapsed { display: grid; grid-template-columns: 1fr 1fr; }
      .diff-head > div { padding: 12px 14px; font-size: 12px; color: #a3a3a3; background: #202020; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .diff-head > div:first-child, .diff-row > div:first-child { border-right: 1px solid rgba(255,255,255,0.08); }
      .diff-row > div { display: grid; grid-template-columns: 56px 1fr; min-height: 28px; }
      .diff-grid.unified .diff-head, .diff-grid.unified .diff-row, .diff-grid.unified .diff-collapsed { grid-template-columns: 1fr; }
      .diff-grid.unified .diff-head > div:first-child, .diff-grid.unified .diff-row > div:first-child { border-right: none; }
      .diff-grid.unified .line-single { display: grid; grid-template-columns: 56px 1fr; }
      .gutter { padding: 6px 10px; font-size: 12px; color: #737373; background: rgba(255,255,255,0.02); user-select: none; }
      .code { padding: 6px 12px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
      .kind-added { background: rgba(34,197,94,0.12); }
      .kind-deleted { background: rgba(239,68,68,0.12); }
      .kind-modified { background: rgba(250,204,21,0.08); }
      .kind-unchanged { background: transparent; }
      .diff-collapsed > div { padding: 10px 14px; font-size: 12px; color: #a3a3a3; background: #252525; border-top: 1px solid rgba(255,255,255,0.06); }
      .empty { padding: 24px; color: #a3a3a3; }
    </style>
  </head>
  <body>
    <div class="app">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="title">Galaxy Diff</div>
          <div class="meta">${summary.fileCount} files changed <span class="plus">+${summary.addedLines}</span> <span class="minus">-${summary.deletedLines}</span></div>
          <div class="toolbar">
            <button data-action="revert-all">Revert all</button>
          </div>
        </div>
        <div id="file-list" class="file-list"></div>
      </aside>
      <main class="content">
        <div class="content-header">
          <div>
            <div id="content-title" class="content-title">No file selected</div>
            <div id="content-subtitle" class="content-subtitle"></div>
          </div>
          <div class="content-actions">
            <div class="mode-toggle">
              <button id="mode-unified" data-action="set-mode" data-mode="unified">Unified</button>
              <button id="mode-split" class="active" data-action="set-mode" data-mode="split">Split</button>
            </div>
            <button id="open-diff-button" data-action="open-diff">Open native diff</button>
            <button id="revert-file-button" data-action="revert-file">Revert file</button>
          </div>
        </div>
        <div id="diff-wrap" class="diff-wrap">
          <div class="empty">No tracked changes in this session.</div>
        </div>
      </main>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const data = ${payloadJson};
      let selectedPath = data.files[0]?.filePath || null;
      let viewMode = 'split';

      const fileList = document.getElementById('file-list');
      const contentTitle = document.getElementById('content-title');
      const contentSubtitle = document.getElementById('content-subtitle');
      const diffWrap = document.getElementById('diff-wrap');
      const unifiedButton = document.getElementById('mode-unified');
      const splitButton = document.getElementById('mode-split');

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderRows(file) {
        const rows = file.rows || [];
        if (rows.length === 0) {
          return '<div class="empty">No diff data available.</div>';
        }

        const body = rows.map((row) => {
          if (row.type === 'collapsed') {
            return '<div class="diff-collapsed"><div>' + row.count + ' unmodified lines</div><div>' + row.count + ' unmodified lines</div></div>';
          }

          const kindClass = row.kind ? 'kind-' + row.kind : '';
          if (viewMode === 'unified') {
            const deletedLine = row.leftText
              ? '<div class="line-single kind-deleted"><div class="gutter">' + (row.leftNumber ?? '') + '</div><div class="code">- ' + escapeHtml(row.leftText ?? '') + '</div></div>'
              : '';
            const addedLine = row.rightText
              ? '<div class="line-single kind-added"><div class="gutter">' + (row.rightNumber ?? '') + '</div><div class="code">+ ' + escapeHtml(row.rightText ?? '') + '</div></div>'
              : '';
            if (row.kind === 'unchanged') {
              return '<div class="diff-row"><div class="line-single"><div class="gutter">' + (row.rightNumber ?? row.leftNumber ?? '') + '</div><div class="code">  ' + escapeHtml(row.rightText ?? row.leftText ?? '') + '</div></div></div>';
            }
            if (row.kind === 'modified') {
              return '<div class="diff-row"><div>' + deletedLine + addedLine + '</div></div>';
            }
            return '<div class="diff-row"><div>' + (row.kind === 'deleted' ? deletedLine : addedLine) + '</div></div>';
          }
          return (
            '<div class="diff-row">' +
              '<div class="' + kindClass + '">' +
                '<div class="gutter">' + (row.leftNumber ?? '') + '</div>' +
                '<div class="code">' + escapeHtml(row.leftText ?? '') + '</div>' +
              '</div>' +
              '<div class="' + kindClass + '">' +
                '<div class="gutter">' + (row.rightNumber ?? '') + '</div>' +
                '<div class="code">' + escapeHtml(row.rightText ?? '') + '</div>' +
              '</div>' +
            '</div>'
          );
        }).join('');

        return (
          '<div class="diff-grid ' + (viewMode === 'unified' ? 'unified' : 'split') + '">' +
            '<div class="diff-head">' +
              (viewMode === 'unified'
                ? '<div>Unified Diff</div>'
                : '<div>Original</div><div>Current</div>') +
            '</div>' +
            body +
          '</div>'
        );
      }

      function renderFileList() {
        if (!fileList) return;
        fileList.innerHTML = data.files.map((file) => (
          '<button class="file-item' + (file.filePath === selectedPath ? ' active' : '') + '" data-action="select-file" data-path="' + escapeHtml(file.filePath) + '">' +
            '<div class="file-path">' + escapeHtml(file.label + (file.wasNew ? ' (new)' : '')) + '</div>' +
            '<div class="file-stats"><span class="plus">+' + file.addedLines + '</span> <span class="minus">-' + file.deletedLines + '</span></div>' +
          '</button>'
        )).join('');
      }

      function renderSelectedFile() {
        const file = data.files.find((item) => item.filePath === selectedPath) || data.files[0];
        if (!file) {
          if (diffWrap) diffWrap.innerHTML = '<div class="empty">No tracked changes in this session.</div>';
          if (contentTitle) contentTitle.textContent = 'No file selected';
          if (contentSubtitle) contentSubtitle.textContent = '';
          return;
        }

        selectedPath = file.filePath;
        if (contentTitle) contentTitle.textContent = file.label + (file.wasNew ? ' (new)' : '');
        if (contentSubtitle) contentSubtitle.textContent = '+' + file.addedLines + ' / -' + file.deletedLines;
        if (diffWrap) diffWrap.innerHTML = renderRows(file);
        if (unifiedButton && splitButton) {
          unifiedButton.classList.toggle('active', viewMode === 'unified');
          splitButton.classList.toggle('active', viewMode === 'split');
        }
      }

      renderFileList();
      renderSelectedFile();

      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const actionTarget = target.closest('[data-action]');
        if (!(actionTarget instanceof HTMLElement)) return;
        const action = actionTarget.dataset.action;
        if (!action) return;
        if (action === 'revert-all') {
          vscode.postMessage({ type: 'revert-all-changes' });
        }
        if (action === 'select-file' && actionTarget.dataset.path) {
          selectedPath = actionTarget.dataset.path;
          renderFileList();
          renderSelectedFile();
        }
        if (action === 'set-mode' && actionTarget.dataset.mode) {
          viewMode = actionTarget.dataset.mode === 'unified' ? 'unified' : 'split';
          renderSelectedFile();
        }
        if (action === 'open-diff') {
          if (selectedPath) {
            vscode.postMessage({ type: 'file-diff', payload: { filePath: selectedPath } });
          }
        }
        if (action === 'revert-file') {
          if (selectedPath) {
            vscode.postMessage({ type: 'revert-file-change', payload: { filePath: selectedPath } });
          }
        }
      });
    </script>
  </body>
</html>`;
  }

  private async openReviewPanel(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'galaxy-code.reviewChanges',
      'Galaxy Diff',
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    );
    panel.webview.html = this.getReviewPanelHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
      void this.refreshWorkspaceFiles().then(async () => {
        panel.webview.html = this.getReviewPanelHtml(panel.webview);
      });
    });
  }

  private async requestToolApproval(approval: {
    approvalKey: string;
    toolName: string;
    title: string;
    message: string;
    details: readonly string[];
  }): Promise<ToolApprovalDecision> {
    if (this.pendingApprovalResolver) {
      return 'deny';
    }

    const requestId = createMessageId();
    const payload: ApprovalRequestPayload = {
      requestId,
      approvalKey: approval.approvalKey,
      toolName: approval.toolName,
      title: approval.title,
      message: approval.message,
      details: approval.details,
    };

    this.appendLog('approval', `${approval.toolName} is waiting for user approval.`);
    this.pendingApprovalRequestId = requestId;
    this.pendingApprovalTitle = approval.title;
    this.pendingApprovalPayload = payload;
    this.updateWorkbenchChrome();

    if (this.shouldUseNativeApprovalPrompt(approval)) {
      const decision = await this.requestNativeToolApproval(approval);
      this.appendLog('approval', `User selected ${decision} for ${approval.toolName}.`);
      this.clearPendingApprovalState();
      return decision;
    }

    await this.postMessage({
      type: 'approval-request',
      payload,
    });
    this.showApprovalNotification(`${approval.title} (${approval.toolName})`);

    return new Promise<ToolApprovalDecision>((resolve) => {
      this.pendingApprovalResolver = resolve;
    });
  }

  private buildPhasePlanItems(): readonly PlanItem[] {
    return Object.freeze([
      Object.freeze({
        id: 'phase-1-runtime',
        title: 'Runtime + Providers',
        detail: 'Independent provider drivers and streaming loop now run inside the extension host.',
        status: 'done' as const,
      }),
      Object.freeze({
        id: 'phase-2-history',
        title: 'History + Project Storage',
        detail: 'Transcript, session memory, working turn, and workspace storage persist across sessions.',
        status: 'done' as const,
      }),
      Object.freeze({
        id: 'phase-3-tools',
        title: 'File + Workspace Tools',
        detail: 'The host now supports read, write, edit, diff, revert, and workspace inspection tools.',
        status: 'done' as const,
      }),
      Object.freeze({
        id: 'phase-4-approvals',
        title: 'Action Approvals',
        detail: 'Git, scaffold, delete, and project commands run behind approval gates.',
        status: 'done' as const,
      }),
      Object.freeze({
        id: 'phase-5-evidence',
        title: 'Tool Evidence',
        detail: 'Relevant tool evidence is persisted and selectively re-injected into prompts.',
        status: 'done' as const,
      }),
      Object.freeze({
        id: 'phase-6-quality',
        title: 'Validation + Review',
        detail: 'Final validation, reviewer sub-agent, and auto-repair loops now run in the host.',
        status: 'done' as const,
      }),
      Object.freeze({
        id: 'phase-7-galaxy-design',
        title: 'Galaxy Design',
        detail: 'Registry lookup, init, add, and project inspection tools are integrated.',
        status: 'done' as const,
      }),
      Object.freeze({
        id: 'phase-8-polish',
        title: 'Plan + Logs + Quality Views',
        detail: 'The webview now surfaces migration plan state, runtime logs, quality summaries, and tracked diffs.',
        status: 'done' as const,
      }),
    ]);
  }

  private appendLog(kind: LogEntry['kind'], text: string): void {
    const entry: LogEntry = Object.freeze({
      id: createMessageId(),
      kind,
      text,
      timestamp: Date.now(),
    });
    this.runtimeLogs = [...this.runtimeLogs.slice(-(MAX_LOG_ENTRIES - 1)), entry];
    writeDebugLine(this.projectStorage.debugLogPath, kind, text);
    const timestamp = new Date(entry.timestamp).toTimeString().slice(0, 8);
    this.chrome.outputChannel.appendLine(`[${timestamp}] [${kind}] ${text}`);
    void this.postMessage({
      type: 'logs-updated',
      payload: { logs: this.runtimeLogs },
    });
  }

  private async handleBackgroundCommandCompletion(payload: BackgroundCommandCompletion): Promise<void> {
    this.writeCommandContextFile({
      commandText: payload.commandText,
      cwd: payload.cwd,
      success: payload.success,
      exitCode: payload.exitCode,
      durationMs: payload.durationMs,
      output: payload.output,
      changedFiles: getSessionFiles().map((file) => this.asWorkspaceRelative(file.filePath)),
    });
    this.pendingBackgroundCompletions = [...this.pendingBackgroundCompletions, payload];
    this.appendLog(
      'status',
      `Background command completed: ${payload.commandText} (${payload.success ? `exit ${payload.exitCode}` : `failed exit ${payload.exitCode}`}). Context saved to ${path.basename(this.projectStorage.commandContextPath)}.`,
    );
    await this.flushBackgroundCommandCompletions();
  }

  private async flushBackgroundCommandCompletions(): Promise<void> {
    if (this.isRunning || this.backgroundCompletionRunning || this.pendingBackgroundCompletions.length === 0) {
      return;
    }

    const next = this.pendingBackgroundCompletions[0]!;
    this.pendingBackgroundCompletions = this.pendingBackgroundCompletions.slice(1);
    this.backgroundCompletionRunning = true;
    this.statusText = 'Processing completed background command';
    this.reportProgress(this.statusText);
    await this.postRunState();

    const contextRecord = this.writeCommandContextFile({
      commandText: next.commandText,
      cwd: next.cwd,
      success: next.success,
      exitCode: next.exitCode,
      durationMs: next.durationMs,
      output: next.output,
      changedFiles: getSessionFiles().map((file) => this.asWorkspaceRelative(file.filePath)),
    });

    const result = await this.runInternalRepairTurn({
      config: this.getEffectiveConfig(),
      agentType: this.selectedAgent,
      userMessage: Object.freeze({
        id: `background-complete-${Date.now()}`,
        role: 'user',
        content:
          `Background command completed.\n` +
          `Command: ${next.commandText}\n` +
          `cwd: ${next.cwd}\n` +
          `Exit code: ${next.exitCode}\n` +
          `Success: ${String(next.success)}\n` +
          `Context file: context.json\n` +
          `Summary: ${contextRecord.summary}\n` +
          `Tail output:\n${contextRecord.tailOutput || '(no output)'}\n\n` +
          'Continue from the updated workspace state. If you need the full command context, read context.json. Do not rerun the same command unless the context above proves it is necessary.',
        timestamp: Date.now(),
      }),
    });

    this.backgroundCompletionRunning = false;
    if (result.filesWritten.length > 0 && !result.hadError) {
      await this.runValidationAndReviewFlow(this.selectedAgent);
    }
    await this.flushBackgroundCommandCompletions();
  }

  private updateQualityDetails(update: Partial<QualityDetails>): void {
    this.qualityDetails = Object.freeze({
      validationSummary: update.validationSummary ?? this.qualityDetails.validationSummary,
      reviewSummary: update.reviewSummary ?? this.qualityDetails.reviewSummary,
      reviewFindings: update.reviewFindings ?? this.qualityDetails.reviewFindings ?? Object.freeze([]),
    });
    void this.postMessage({
      type: 'quality-updated',
      payload: this.qualityDetails,
    });
  }

  private asWorkspaceRelative(filePath: string): string {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!folder) {
      return path.basename(filePath);
    }

    return path.relative(folder.uri.fsPath, filePath) || path.basename(filePath);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'chat.css'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Galaxy Code</title>
    <link rel="stylesheet" href="${styleUri}" />
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">
      globalThis.process = globalThis.process || { env: { NODE_ENV: 'production' } };
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private configureWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
  }
}

async function openGalaxyConfigDir(): Promise<void> {
  const configUri = vscode.Uri.file(getConfigDir());
  await vscode.workspace.fs.createDirectory(configUri);
  await vscode.env.openExternal(configUri);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  for (let index = 0; index < 32; index += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

function createMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createAssistantMessage(content: string): ChatMessage {
  return {
    id: createMessageId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Galaxy Code');
  outputChannel.appendLine(`[${new Date().toTimeString().slice(0, 8)}] [info] Galaxy Code logs initialized.`);
  const runStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
  runStatusItem.name = 'Galaxy Code Run Status';
  runStatusItem.command = 'galaxy-code.openLogs';
  runStatusItem.show();

  const agentStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
  agentStatusItem.name = 'Galaxy Code Agent';
  agentStatusItem.command = 'galaxy-code.switchAgent';
  agentStatusItem.show();

  const approvalStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  approvalStatusItem.name = 'Galaxy Code Approval Mode';
  approvalStatusItem.command = 'galaxy-code.openConfig';
  approvalStatusItem.show();

  const sidebarProvider = GalaxyChatViewProvider.create(context, {
    outputChannel,
    runStatusItem,
    agentStatusItem,
    approvalStatusItem,
  });
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    GalaxyChatViewProvider.viewType,
    sidebarProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    },
  );
  const openChat = vscode.commands.registerCommand('galaxy-code.openChat', () => {
    void sidebarProvider.reveal();
  });
  const openChatRight = vscode.commands.registerCommand('galaxy-code.openChatRight', () => {
    void sidebarProvider.openChatRight();
  });

  const clearHistory = vscode.commands.registerCommand('galaxy-code.clearHistory', () => {
    GalaxyChatViewProvider.clearCurrent();
  });

  const openConfig = vscode.commands.registerCommand('galaxy-code.openConfig', async () => {
    try {
      await openGalaxyConfigDir();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to open Galaxy Code config folder: ${message}`);
    }
  });

  const switchAgent = vscode.commands.registerCommand('galaxy-code.switchAgent', async () => {
    await sidebarProvider.showAgentQuickPick();
  });

  const openLogs = vscode.commands.registerCommand('galaxy-code.openLogs', async () => {
    await sidebarProvider.openRuntimeLogs();
  });
  const openTelemetrySummary = vscode.commands.registerCommand('galaxy-code.openTelemetrySummary', async () => {
    await sidebarProvider.openTelemetrySummary();
  });
  const toggleReview = vscode.commands.registerCommand(TOGGLE_REVIEW_COMMAND_ID, async () => {
    await sidebarProvider.toggleReviewPreference();
  });
  const toggleValidation = vscode.commands.registerCommand(TOGGLE_VALIDATION_COMMAND_ID, async () => {
    await sidebarProvider.toggleValidationPreference();
  });
  const qualitySettingsSync = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration(`${GALAXY_CONFIGURATION_SECTION}.${QUALITY_REVIEW_SETTING_KEY}`) ||
      event.affectsConfiguration(`${GALAXY_CONFIGURATION_SECTION}.${QUALITY_VALIDATE_SETTING_KEY}`) ||
      event.affectsConfiguration(`${GALAXY_CONFIGURATION_SECTION}.${QUALITY_FULL_ACCESS_SETTING_KEY}`)
    ) {
      void sidebarProvider.handleVsCodeQualitySettingsChange();
    }
  });

  void sidebarProvider.syncQualityPreferencesToVsCodeSettings();
  void ensureFigmaBridgeStarted(false);

  context.subscriptions.push(
    outputChannel,
    runStatusItem,
    agentStatusItem,
    approvalStatusItem,
    sidebarRegistration,
    openChat,
    openChatRight,
    clearHistory,
    openConfig,
    switchAgent,
    openLogs,
    openTelemetrySummary,
    toggleReview,
    toggleValidation,
    qualitySettingsSync,
    {
      dispose() {
        void stopFigmaBridgeServer(false);
      },
    },
  );
}

export function deactivate(): void {
  void stopFigmaBridgeServer(false);
}

function resolveExtensionWorkspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(os.homedir(), '.galaxy', '__vscode-no-workspace__');
}

async function ensureFigmaBridgeStarted(showFeedback: boolean): Promise<void> {
  if (figmaBridge) {
    if (showFeedback) {
      vscode.window.showInformationMessage(`Galaxy Code Figma Bridge is already running at http://${figmaBridge.host}:${figmaBridge.port}`);
    }
    return;
  }

  try {
    const workspacePath = resolveExtensionWorkspacePath();
    figmaBridge = await startFigmaBridgeServer({
      onImport: async (payload) => {
        const record = appendFigmaImport(workspacePath, payload);
        const storage = getProjectStorageInfo(workspacePath);
        await vscode.env.clipboard.writeText(buildFigmaClipboardToken(record.importId));
        const surfacedInView = GalaxyChatViewProvider.handleImportedFigmaDesign(record);
        if (!surfacedInView) {
          void vscode.window.showInformationMessage(`Galaxy Code received a Figma import and copied its token to the clipboard: ${record.summary}`);
        }
        return Object.freeze({
          importId: record.importId,
          storedAt: storage.figmaImportsPath,
          summary: record.summary,
        });
      },
    });

    if (showFeedback) {
      vscode.window.showInformationMessage(`Galaxy Code Figma Bridge started at http://${FIGMA_BRIDGE_HOST}:${FIGMA_BRIDGE_PORT}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (showFeedback) {
      vscode.window.showErrorMessage(`Failed to start Galaxy Code Figma Bridge: ${message}`);
    }
  }
}

async function stopFigmaBridgeServer(showFeedback: boolean): Promise<void> {
  if (!figmaBridge) {
    if (showFeedback) {
      vscode.window.showInformationMessage('Galaxy Code Figma Bridge is not running.');
    }
    return;
  }

  const current = figmaBridge;
  figmaBridge = null;
  await current.stop();
  if (showFeedback) {
    vscode.window.showInformationMessage('Galaxy Code Figma Bridge stopped.');
  }
}
