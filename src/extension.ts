import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfigDir, loadConfig, saveConfig } from './config/manager';
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
  saveProjectMeta,
  type ProjectStorageInfo,
} from './context/project-store';
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
import { formatValidationSummary, runFinalValidation } from './validation/project-validator';
import type { FinalValidationResult } from './validation/types';
import { DEFAULT_CONFIG } from './config/types';
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
  FigmaAttachment,
  HostMessage,
  LocalAttachmentPayload,
  LogEntry,
  PlanItem,
  QualityPreferences,
  QualityDetails,
  SessionInitPayload,
  WebviewMessage,
} from './shared/protocol';

const MAX_AUTO_REPAIR_ATTEMPTS = 2;
const MAX_AUTO_REVIEW_REPAIR_ATTEMPTS = 1;
const MAX_EMPTY_CONTINUE_ATTEMPTS = 1;
const MAX_LOG_ENTRIES = 120;
const MAX_DEBUG_BLOCK_CHARS = 20_000;
let figmaBridge: FigmaBridgeServer | null = null;
const GALAXY_VIEW_CONTAINER_ID = 'galaxy-code-sidebar';

function writeDebugLine(filePath: string, scope: string, message: string): void {
  try {
    const timestamp = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(filePath, `[${timestamp}] [${scope}] ${message}\n`, 'utf-8');
  } catch {
    // ignore debug logging failures
  }
}

class GalaxyChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'galaxy-code.chatView';
  private static currentProvider: GalaxyChatViewProvider | undefined;

  static create(context: vscode.ExtensionContext): GalaxyChatViewProvider {
    if (GalaxyChatViewProvider.currentProvider) {
      return GalaxyChatViewProvider.currentProvider;
    }

    const provider = new GalaxyChatViewProvider(context);
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
  private readonly workspacePath: string;
  private readonly projectStorage: ProjectStorageInfo;
  private readonly historyManager: HistoryManager;
  private readonly selectedFiles = new Set<string>();
  private isRunning = false;
  private statusText = 'Phase 8 Polish ready';
  private messages: ChatMessage[];
  private selectedAgent: AgentType = 'manual';
  private pendingApprovalRequestId: string | null = null;
  private pendingApprovalResolver: ((decision: ToolApprovalDecision) => void) | null = null;
  private runtimeLogs: LogEntry[] = [];
  private qualityDetails: QualityDetails = Object.freeze({
    validationSummary: '',
    reviewSummary: '',
  });
  private qualityPreferences: QualityPreferences = Object.freeze({
    reviewEnabled: loadConfig().quality.review,
    validateEnabled: loadConfig().quality.test,
  });
  private view: vscode.WebviewView | null = null;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.workspacePath = this.resolveStorageWorkspacePath();
    this.projectStorage = getProjectStorageInfo(this.workspacePath);
    ensureProjectStorage(this.projectStorage);
    saveProjectMeta(this.projectStorage, loadProjectMeta(this.projectStorage));
    this.historyManager = createHistoryManager({
      workspacePath: this.workspacePath,
      notes: loadNotes(),
    });
    this.messages = this.loadInitialMessages();
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });

    await this.postInit();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`workbench.view.extension.${GALAXY_VIEW_CONTAINER_ID}`);
    this.view?.show?.(true);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'webview-ready':
        await this.postInit();
        return;
      case 'file-toggle':
        if (message.payload.selected) {
          this.selectedFiles.add(message.payload.filePath);
        } else {
          this.selectedFiles.delete(message.payload.filePath);
        }
        await this.postMessage({
          type: 'selection-updated',
          payload: { selectedFiles: [...this.selectedFiles] },
        });
        return;
      case 'file-open': {
        const targetPath = path.isAbsolute(message.payload.filePath)
          ? message.payload.filePath
          : path.resolve(this.workspacePath, message.payload.filePath);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
        await vscode.window.showTextDocument(document, { preview: false });
        return;
      }
      case 'file-diff':
        await this.openTrackedDiff(message.payload.filePath);
        return;
      case 'approval-response':
        if (this.pendingApprovalResolver && this.pendingApprovalRequestId === message.payload.requestId) {
          this.appendLog('approval', `User selected ${message.payload.decision} for the pending approval request.`);
          const resolve = this.pendingApprovalResolver;
          this.pendingApprovalResolver = null;
          this.pendingApprovalRequestId = null;
          resolve(message.payload.decision);
        }
        return;
      case 'quality-set':
        this.qualityPreferences = Object.freeze({
          reviewEnabled: message.payload.reviewEnabled,
          validateEnabled: message.payload.validateEnabled,
        });
        await this.postMessage({
          type: 'quality-preferences-updated',
          payload: this.qualityPreferences,
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
        this.debugChatMessage(userMessage);

        this.isRunning = true;
        this.statusText = `Running ${this.selectedAgent}`;
        await this.postMessage({
          type: 'run-state',
          payload: { isRunning: this.isRunning, statusText: this.statusText },
        });

        let hadError = false;
        let thinkingLogged = false;
        let emptyContinueAttempt = 0;
        try {
          const config = loadConfig();
          config.quality.review = message.payload.reviewEnabled ?? this.qualityPreferences.reviewEnabled;
          config.quality.test = message.payload.validateEnabled ?? this.qualityPreferences.validateEnabled;
          this.qualityPreferences = Object.freeze({
            reviewEnabled: config.quality.review,
            validateEnabled: config.quality.test,
          });
          const selectedFilesContext = await buildSelectedFilesContextNote({
            selectedFiles: message.payload.selectedFiles,
            workspaceRoot: this.getWorkspaceRoot(),
          });
          const attachmentContext = await buildAttachmentContextNote(
            this.workspacePath,
            attachmentIds,
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
          this.historyManager.startTurn(userMessage, contextNote);

          const result = await runExtensionChat({
            config,
            agentType: this.selectedAgent,
            historyManager: this.historyManager,
            toolContext: {
              workspaceRoot: this.workspacePath,
              config,
              revealFile: async (filePath, range) => this.revealFile(filePath, range),
              refreshWorkspaceFiles: async () => this.refreshWorkspaceFiles(),
              onProjectCommandStart: async (payload) => {
                await this.postMessage({
                  type: 'command-stream-start',
                  payload,
                });
              },
              onProjectCommandChunk: async (payload) => {
                await this.postMessage({
                  type: 'command-stream-chunk',
                  payload,
                });
              },
              onProjectCommandEnd: async (payload) => {
                await this.postMessage({
                  type: 'command-stream-end',
                  payload,
                });
              },
            },
            onChunk: async (chunk) => {
              if (chunk.type === 'text') {
                await this.postMessage({
                  type: 'assistant-stream',
                  payload: { delta: chunk.delta },
                });
                return;
              }

              if (chunk.type === 'thinking') {
                if (!thinkingLogged && chunk.delta.trim()) {
                  thinkingLogged = true;
                  this.appendLog('status', `Received thinking stream from ${this.selectedAgent}.`);
                }
                await this.postMessage({
                  type: 'assistant-thinking',
                  payload: { delta: chunk.delta },
                });
                return;
              }

              if (chunk.type === 'error') {
                hadError = true;
                await this.postMessage({
                  type: 'error',
                  payload: { message: chunk.message },
                });
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
              await this.postMessage({
                type: 'run-state',
                payload: { isRunning: this.isRunning, statusText: this.statusText },
              });
            },
            onEvidenceContext: async (payload) => {
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
            const assistantMessage: ChatMessage = {
              id: createMessageId(),
              role: 'assistant',
              content: result.assistantText,
              ...(result.assistantThinking.trim() ? { thinking: result.assistantThinking } : {}),
              timestamp: Date.now(),
            };
            await this.addMessage(assistantMessage);
            this.historyManager.finalizeTurn({ assistantText: result.assistantText });
            if (result.filesWritten.length > 0) {
              await this.runValidationAndReviewFlow(this.selectedAgent);
            }
          } else if (!hadError) {
            this.writeDebug(
              'turn-result',
              `agent=${this.selectedAgent} empty text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
            );
            if (result.assistantThinking.trim()) {
              this.writeDebugBlock('turn-empty-thinking', result.assistantThinking);
            }
            this.historyManager.clearCurrentTurn();
            if (emptyContinueAttempt < MAX_EMPTY_CONTINUE_ATTEMPTS) {
              emptyContinueAttempt += 1;
              this.appendLog('status', `Empty assistant result detected. Auto-continuing (${emptyContinueAttempt}/${MAX_EMPTY_CONTINUE_ATTEMPTS})...`);
              this.writeDebug(
                'turn-empty-continue',
                `agent=${this.selectedAgent} attempt=${emptyContinueAttempt}`,
              );
              const continueResult = await this.runInternalRepairTurn({
                config: loadConfig(),
                agentType: this.selectedAgent,
                userMessage: this.buildContinueMessage(emptyContinueAttempt),
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
          await this.postMessage({
            type: 'error',
            payload: { message: `Runtime error: ${String(error)}` },
          });
        } finally {
          this.isRunning = false;
          this.statusText = hadError ? 'Run failed' : 'Ready';
          await this.postMessage({
            type: 'run-state',
            payload: { isRunning: this.isRunning, statusText: this.statusText },
          });
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
      'Prioritize critical issues first, then warnings that affect correctness or maintainability.',
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
        'Do not restart the task. Continue from the current workspace state.\n\n' +
        this.buildStructuredReviewRepairPrompt(review),
      timestamp: Date.now(),
    });
  }

  private buildContinueMessage(attempt: number): ChatMessage {
    return Object.freeze({
      id: `continue-${Date.now()}-${attempt}`,
      role: 'user',
      content: 'Continued',
      timestamp: Date.now(),
    });
  }

  private async runInternalRepairTurn(opts: {
    config: ReturnType<typeof loadConfig>;
    agentType: AgentType;
    userMessage: ChatMessage;
  }): Promise<Readonly<{ hadError: boolean; filesWritten: readonly string[] }>> {
    let hadError = false;
    let thinkingLogged = false;
    this.historyManager.startTurn(opts.userMessage);
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
        onProjectCommandStart: async (payload) => {
          await this.postMessage({
            type: 'command-stream-start',
            payload,
          });
        },
        onProjectCommandChunk: async (payload) => {
          await this.postMessage({
            type: 'command-stream-chunk',
            payload,
          });
        },
        onProjectCommandEnd: async (payload) => {
          await this.postMessage({
            type: 'command-stream-end',
            payload,
          });
        },
      },
      onChunk: async (chunk) => {
        if (chunk.type === 'text') {
          await this.postMessage({
            type: 'assistant-stream',
            payload: { delta: chunk.delta },
          });
          return;
        }

        if (chunk.type === 'thinking') {
          if (!thinkingLogged && chunk.delta.trim()) {
            thinkingLogged = true;
            this.appendLog('status', `Received thinking stream from ${opts.agentType}.`);
          }
          await this.postMessage({
            type: 'assistant-thinking',
            payload: { delta: chunk.delta },
          });
          return;
        }

        if (chunk.type === 'error') {
          hadError = true;
          await this.postMessage({
            type: 'error',
            payload: { message: chunk.message },
          });
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
        await this.postMessage({
          type: 'run-state',
          payload: { isRunning: this.isRunning, statusText: this.statusText },
        });
      },
      onEvidenceContext: async (payload) => {
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
      const assistantMessage: ChatMessage = {
        id: createMessageId(),
        role: 'assistant',
        content: result.assistantText,
        agentType: this.selectedAgent,
        ...(result.assistantThinking.trim() ? { thinking: result.assistantThinking } : {}),
        timestamp: Date.now(),
      };
      await this.addMessage(assistantMessage);
      this.historyManager.finalizeTurn({ assistantText: result.assistantText });
    } else if (!hadError) {
      this.writeDebug(
        'repair-turn-result',
        `agent=${opts.agentType} empty text_len=${result.assistantText.length} thinking_len=${result.assistantThinking.length} files_written=${result.filesWritten.length}`,
      );
      this.historyManager.clearCurrentTurn();
    }

    return Object.freeze({
      hadError,
      filesWritten: result.filesWritten,
    });
  }

  private async runValidationAndReviewFlow(agentType: AgentType): Promise<void> {
    const initialConfig = loadConfig();
    const shouldRunValidation = initialConfig.quality.test;
    const shouldRunReview = initialConfig.quality.review;

    if (!shouldRunValidation && !shouldRunReview) {
      return;
    }

    let validationRepairAttempt = 0;
    let reviewRepairAttempt = 0;
    let currentAgent = agentType;

    for (;;) {
      const sessionFiles = getSessionFiles();
      if (sessionFiles.length === 0) {
        return;
      }

      if (shouldRunReview) {
        const reviewResult = await runCodeReview({
          sessionFiles,
          config: loadConfig(),
          agentType: currentAgent,
        });

        if (!reviewResult) {
          return;
        }

        if (!reviewResult.success) {
          this.appendLog('review', 'Code reviewer failed to complete successfully.');
          await this.postMessage({
            type: 'error',
            payload: { message: reviewResult.review },
          });
          return;
        }

        const reviewSummary = formatReviewSummary(reviewResult);
        this.updateQualityDetails({
          reviewSummary,
        });
        this.appendLog(
          'review',
          !reviewResult.hadCritical && !reviewResult.hadWarnings
            ? 'Code review completed with no actionable findings.'
            : 'Code review produced actionable findings.',
        );
        await this.addMessage(createAssistantMessage(reviewSummary));

        if (reviewResult.hadCritical || reviewResult.hadWarnings) {
          if (reviewRepairAttempt >= MAX_AUTO_REVIEW_REPAIR_ATTEMPTS) {
            return;
          }

          reviewRepairAttempt += 1;
          await this.addMessage(
            createAssistantMessage(
              `Attempting automatic repair from code review findings (${reviewRepairAttempt}/${MAX_AUTO_REVIEW_REPAIR_ATTEMPTS})...`,
            ),
          );

          const repairResult = await this.runInternalRepairTurn({
            config: loadConfig(),
            agentType: currentAgent,
            userMessage: this.buildReviewRepairMessage(reviewResult, reviewRepairAttempt),
          });

          if (repairResult.hadError || repairResult.filesWritten.length === 0) {
            return;
          }

          continue;
        }
      }

      if (!shouldRunValidation) {
        return;
      }

      this.appendLog('validation', `Running final validation for ${sessionFiles.length} changed files.`);
      const validationResult = await runFinalValidation({
        workspacePath: this.workspacePath,
        sessionFiles,
      });
      const validationSummary = formatValidationSummary(validationResult);
      this.updateQualityDetails({
        validationSummary,
      });
      this.appendLog(
        'validation',
        validationResult.success ? 'Final validation passed.' : 'Final validation failed.',
      );
      await this.addMessage(createAssistantMessage(validationSummary));

      if (validationResult.success) {
        return;
      }

      if (validationRepairAttempt >= MAX_AUTO_REPAIR_ATTEMPTS) {
        return;
      }

      validationRepairAttempt += 1;
      await this.addMessage(
        createAssistantMessage(
          `Attempting automatic repair from final validation errors (${validationRepairAttempt}/${MAX_AUTO_REPAIR_ATTEMPTS})...`,
        ),
      );

      const repairResult = await this.runInternalRepairTurn({
        config: loadConfig(),
        agentType: currentAgent,
        userMessage: this.buildValidationRepairMessage(validationResult, validationRepairAttempt),
      });

      if (repairResult.hadError || repairResult.filesWritten.length === 0) {
        return;
      }
    }
  }

  clearHistory(): void {
    this.resetWorkspaceSession();
    this.statusText = 'Session cleared';
    this.appendLog('info', 'Session history and runtime state were cleared.');

    void this.postInit();
  }

  private async postInit(): Promise<void> {
    const payload: SessionInitPayload = {
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? 'Workspace',
      files: await this.getWorkspaceFiles(),
      messages: [...this.messages],
      selectedAgent: this.selectedAgent,
      phase: 'phase-8',
      isRunning: this.isRunning,
      statusText: this.statusText,
      planItems: this.buildPhasePlanItems(),
      logs: [...this.runtimeLogs],
      qualityDetails: this.qualityDetails,
      qualityPreferences: this.qualityPreferences,
      changeSummary: this.buildChangeSummaryPayload(),
    };

    await this.postMessage({ type: 'session-init', payload });
  }

  private async postMessage(message: HostMessage): Promise<void> {
    if (!this.view) {
      return;
    }
    await this.view.webview.postMessage(message);
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
      const current = loadConfig();
      saveConfig({
        ...current,
        quality: {
          ...DEFAULT_CONFIG.quality,
          review: false,
          test: false,
        },
      });
      this.qualityPreferences = Object.freeze({
        reviewEnabled: false,
        validateEnabled: false,
      });
      await this.postMessage({
        type: 'quality-preferences-updated',
        payload: this.qualityPreferences,
      });
      this.appendLog('info', 'Reset config: review=false, validate=false.');
      return;
    }

    this.resetWorkspaceSession({ removeProjectDir: true });
    this.statusText = 'Workspace cleared';
    this.appendLog('info', `Cleared current workspace storage under ${path.join(getConfigDir(), 'projects')}.`);
    await this.postInit();
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
    this.appendTranscriptMessage(message);
    await this.postMessage({
      type: 'message-added',
      payload: message,
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

  private async refreshWorkspaceFiles(): Promise<void> {
    for (const selectedPath of [...this.selectedFiles]) {
      if (!fs.existsSync(selectedPath)) {
        this.selectedFiles.delete(selectedPath);
      }
    }

    await this.postMessage({
      type: 'files-updated',
      payload: { files: await this.getWorkspaceFiles() },
    });
    await this.postMessage({
      type: 'selection-updated',
      payload: { selectedFiles: [...this.selectedFiles] },
    });
    await this.postChangeSummary();
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
      }))),
    });
  }

  private async postChangeSummary(): Promise<void> {
    await this.postMessage({
      type: 'change-summary-updated',
      payload: this.buildChangeSummaryPayload(),
    });
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

  private renderReviewFileBlock(file: ChangedFileSummary): string {
    const relativePath = this.asWorkspaceRelative(file.filePath);
    const title = `${relativePath}${file.wasNew ? ' (new)' : ''}`;
    const diffHtml = this.escapeHtml(file.diffText || file.currentContent || file.originalContent || '(empty)');

    return `
      <details class="file-block" open>
        <summary>
          <div class="summary-main">
            <span class="file-path">${this.escapeHtml(title)}</span>
            <span class="stats"><span class="plus">+${file.addedLines}</span> <span class="minus">-${file.deletedLines}</span></span>
          </div>
          <div class="summary-actions">
            <button data-action="revert-file" data-path="${this.escapeHtml(file.filePath)}">Revert</button>
          </div>
        </summary>
        <pre>${diffHtml}</pre>
      </details>
    `;
  }

  private getReviewPanelHtml(webview: vscode.Webview): string {
    const nonce = createMessageId();
    const summary = getSessionChangeSummary();
    const blocks = summary.files.map((file) => this.renderReviewFileBlock(file)).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Galaxy Code Review</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b1220; color: #e5edf8; }
      .wrap { padding: 20px; }
      .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
      .title { font-size: 18px; font-weight: 700; }
      .meta { color: #94a3b8; font-size: 13px; }
      .toolbar { display: flex; gap: 10px; }
      button { border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color: #e5edf8; padding: 8px 12px; border-radius: 10px; cursor: pointer; }
      details.file-block { border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); border-radius: 16px; margin-bottom: 12px; overflow: hidden; }
      summary { list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; cursor: pointer; }
      summary::-webkit-details-marker { display: none; }
      .summary-main { display: flex; min-width: 0; align-items: center; gap: 12px; }
      .file-path { font-weight: 600; }
      .stats { font-size: 12px; color: #94a3b8; }
      .plus { color: #4ade80; }
      .minus { color: #f87171; }
      pre { margin: 0; padding: 16px; overflow: auto; max-height: 420px; border-top: 1px solid rgba(255,255,255,0.08); background: rgba(2,6,23,0.7); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; line-height: 1.55; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <div>
          <div class="title">Review Changes</div>
          <div class="meta">${summary.fileCount} file(s), +${summary.addedLines} / -${summary.deletedLines}</div>
        </div>
        <div class="toolbar">
          <button data-action="revert-all">Revert all</button>
        </div>
      </div>
      ${blocks || '<div class="meta">No tracked changes in this session.</div>'}
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const action = target.dataset.action;
        if (!action) return;
        if (action === 'revert-all') {
          vscode.postMessage({ type: 'revert-all-changes' });
        }
        if (action === 'revert-file' && target.dataset.path) {
          vscode.postMessage({ type: 'revert-file-change', payload: { filePath: target.dataset.path } });
        }
      });
    </script>
  </body>
</html>`;
  }

  private async openReviewPanel(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'galaxy-code.reviewChanges',
      'Galaxy Code Review',
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

    await this.postMessage({
      type: 'approval-request',
      payload,
    });
    this.appendLog('approval', `${approval.toolName} is waiting for user approval.`);

    return new Promise<ToolApprovalDecision>((resolve) => {
      this.pendingApprovalRequestId = requestId;
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
    void this.postMessage({
      type: 'logs-updated',
      payload: { logs: this.runtimeLogs },
    });
  }

  private updateQualityDetails(update: Partial<QualityDetails>): void {
    this.qualityDetails = Object.freeze({
      validationSummary: update.validationSummary ?? this.qualityDetails.validationSummary,
      reviewSummary: update.reviewSummary ?? this.qualityDetails.reviewSummary,
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
  const sidebarProvider = GalaxyChatViewProvider.create(context);
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

  void ensureFigmaBridgeStarted(false);

  context.subscriptions.push(
    sidebarRegistration,
    openChat,
    clearHistory,
    openConfig,
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
