/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Chat-send webview message orchestration extracted from the extension entrypoint.
 */

import {
  buildAttachmentContextNote,
  buildAttachmentImagePaths,
  buildMessageAttachments,
  commitAttachments,
} from "../attachments/attachment-store";
import { buildSelectedFilesContextNote } from "../runtime/context-builder";
import { buildBaseComponentContextNote } from "../runtime/base-component-profile";
import {
  buildAttachedFigmaContextNote,
  buildFigmaAttachment,
} from "../figma/design-store";
import { getWorkspaceRoot } from "./session-sync";
import { handleMainChatTurnResult, runMainChatTurn } from "./chat-runtime";
import type {
  AgentType,
  ChatMessage,
  FigmaAttachment,
  HostMessage,
  QualityPreferences,
  ToolCapabilities,
  WebviewMessage,
} from "../shared/protocol";
import type { ChatRuntimeCallbacks } from "../shared/chat-runtime";

/** Handles one incoming chat-send message using provider-owned state and callbacks. */
export async function handleChatSendMessage(params: {
  workspacePath: string;
  message: Extract<WebviewMessage, Readonly<{ type: "chat-send" }>>;
  isRunning: boolean;
  selectedAgent: AgentType;
  qualityPreferences: QualityPreferences;
  toolCapabilities: ToolCapabilities;
  setSelectedAgent: (agentType: AgentType) => void;
  persistSelectedAgent: () => void;
  updateWorkbenchChrome: () => void;
  applyQualityPreferences: (
    next: QualityPreferences,
    opts?: Readonly<{ syncVsCodeSettings?: boolean; logMessage?: string }>,
  ) => Promise<void>;
  createMessageId: () => string;
  appendUserMessage: (message: ChatMessage) => void;
  appendTranscriptMessage: (message: ChatMessage) => void;
  appendLog: (kind: "info" | "error" | "status", text: string) => void;
  debugChatMessage: (message: ChatMessage) => void;
  clearStreamingBuffers: () => void;
  setRunningState: (isRunning: boolean, statusText: string) => void;
  postRunState: () => Promise<void>;
  clearProgressReporter: () => void;
  getEffectiveConfig: () => ReturnType<
    typeof import("../config/manager").loadConfig
  >;
  runSelectiveMultiAgentPlan: (opts: {
    config: ReturnType<typeof import("../config/manager").loadConfig>;
    agentType: AgentType;
    originalUserMessage: ChatMessage;
    contextNote?: string;
  }) => Promise<
    Readonly<{
      handled: boolean;
      hadError: boolean;
      filesWritten: readonly string[];
    }>
  >;
  getChatRuntimeCallbacks: () => ChatRuntimeCallbacks;
  runValidationAndReviewFlow: (
    agentType: AgentType,
  ) => Promise<Readonly<{ passed: boolean; repaired: boolean }>>;
  clearCurrentTurn: () => void;
  writeDebug: (scope: string, message: string) => void;
  writeDebugBlock: (scope: string, content: string) => void;
  postMessage: (message: HostMessage) => Promise<void>;
  showWorkbenchError: (message: string) => void;
  flushBackgroundCommandCompletions: () => Promise<void>;
}): Promise<void> {
  const content = params.message.payload.content.trim();
  const figmaImportIds = [
    ...new Set(params.message.payload.figmaImportIds ?? []),
  ];
  if ((!content && figmaImportIds.length === 0) || params.isRunning) {
    return;
  }

  params.setSelectedAgent(params.message.payload.agent);
  params.persistSelectedAgent();
  params.updateWorkbenchChrome();
  const nextQualityPreferences = Object.freeze({
    reviewEnabled:
      params.message.payload.reviewEnabled ??
      params.qualityPreferences.reviewEnabled,
    validateEnabled:
      params.message.payload.validateEnabled ??
      params.qualityPreferences.validateEnabled,
    fullAccessEnabled:
      params.message.payload.fullAccessEnabled ??
      params.qualityPreferences.fullAccessEnabled,
  });
  if (
    nextQualityPreferences.reviewEnabled !==
      params.qualityPreferences.reviewEnabled ||
    nextQualityPreferences.validateEnabled !==
      params.qualityPreferences.validateEnabled ||
    nextQualityPreferences.fullAccessEnabled !==
      params.qualityPreferences.fullAccessEnabled
  ) {
    await params.applyQualityPreferences(nextQualityPreferences, {
      syncVsCodeSettings: true,
    });
  }

  const clientMessageId = params.createMessageId();
  const attachmentIds = params.message.payload.attachmentIds ?? [];
  if (attachmentIds.length) {
    commitAttachments(params.workspacePath, attachmentIds, clientMessageId);
  }

  const messageAttachments = buildMessageAttachments(
    params.workspacePath,
    attachmentIds,
  );
  const messageImages = buildAttachmentImagePaths(
    params.workspacePath,
    attachmentIds,
  );
  const figmaAttachments = figmaImportIds
    .map((importId) => buildFigmaAttachment(params.workspacePath, importId))
    .filter((item): item is FigmaAttachment => item !== null);
  const transcriptFigmaAttachments = figmaAttachments.map((attachment) => ({
    importId: attachment.importId,
    label: attachment.label,
    summary: attachment.summary,
  }));
  const userContent =
    content || "Implement the attached Figma design in the current workspace.";
  const userMessage: ChatMessage = {
    id: clientMessageId,
    role: "user",
    content: userContent,
    ...(messageAttachments.length > 0
      ? { attachments: messageAttachments }
      : {}),
    ...(messageImages.length > 0 ? { images: messageImages } : {}),
    ...(transcriptFigmaAttachments.length > 0
      ? { figmaAttachments: transcriptFigmaAttachments }
      : {}),
    timestamp: Date.now(),
  };
  params.appendUserMessage(userMessage);
  params.appendTranscriptMessage(userMessage);
  params.appendLog(
    "info",
    `User prompt sent with agent ${params.message.payload.agent}.`,
  );
  params.appendLog(
    "info",
    `Capability snapshot: ${
      Object.entries(params.toolCapabilities)
        .filter(([, enabled]) => enabled)
        .map(([capability]) => capability)
        .sort()
        .join(", ") || "none"
    }.`,
  );
  params.debugChatMessage(userMessage);
  params.clearStreamingBuffers();

  params.setRunningState(true, `Running ${params.message.payload.agent}`);
  await params.postRunState();
  params.clearProgressReporter();

  let hadError = false;
  try {
    const config = params.getEffectiveConfig();
    const selectedFilesContext = await buildSelectedFilesContextNote({
      selectedFiles: params.message.payload.selectedFiles,
      workspaceRoot: getWorkspaceRoot(),
    });
    const attachmentContext = await buildAttachmentContextNote(
      params.workspacePath,
      attachmentIds,
      userMessage.content,
    );
    const figmaContext = buildAttachedFigmaContextNote(
      params.workspacePath,
      figmaImportIds,
    );
    const baseComponentContext = buildBaseComponentContextNote(
      params.workspacePath,
    );
    const contextNote = [
      selectedFilesContext,
      attachmentContext,
      figmaContext,
      baseComponentContext,
    ]
      .filter(Boolean)
      .join("\n\n");
    params.writeDebug(
      "turn-context",
      `agent=${params.message.payload.agent} selected_files=${params.message.payload.selectedFiles.length} attachments=${attachmentIds.length} figma=${figmaImportIds.length} context_len=${contextNote.length}`,
    );
    if (contextNote.trim()) {
      params.writeDebugBlock("turn-context-note", contextNote);
    }

    const multiAgentResult = await params.runSelectiveMultiAgentPlan({
      config,
      agentType: params.message.payload.agent,
      originalUserMessage: userMessage,
      ...(contextNote ? { contextNote } : {}),
    });
    const chatRuntimeCallbacks = params.getChatRuntimeCallbacks();
    const mainTurnResult = multiAgentResult.handled
      ? null
      : await runMainChatTurn(chatRuntimeCallbacks, {
          config,
          agentType: params.message.payload.agent,
          userMessage,
          ...(contextNote ? { contextNote } : {}),
        });

    const result = multiAgentResult.handled
      ? {
          assistantText: "",
          assistantThinking: "",
          errorMessage: undefined,
          filesWritten: multiAgentResult.filesWritten,
        }
      : mainTurnResult!.result;

    if (!multiAgentResult.handled) {
      hadError = mainTurnResult!.hadError;
    }
    if (multiAgentResult.handled) {
      hadError = multiAgentResult.hadError;
      params.writeDebug(
        "turn-result",
        `agent=${params.message.payload.agent} phase4 handled had_error=${hadError} files_written=${result.filesWritten.length}`,
      );
      if (!hadError && result.filesWritten.length > 0) {
        await params.runValidationAndReviewFlow(params.message.payload.agent);
      }
    } else {
      hadError = (
        await handleMainChatTurnResult(chatRuntimeCallbacks, {
          config,
          agentType: params.message.payload.agent,
          hadError,
          result,
        })
      ).hadError;
    }
  } catch (error) {
    hadError = true;
    params.clearCurrentTurn();
    params.appendLog("error", `Runtime error: ${String(error)}`);
    params.writeDebug("turn-crash", String(error));
    const runtimeError = `Runtime error: ${String(error)}`;
    await params.postMessage({
      type: "error",
      payload: { message: runtimeError },
    });
    params.showWorkbenchError(runtimeError);
  } finally {
    params.setRunningState(false, hadError ? "Run failed" : "Ready");
    await params.postRunState();
    await params.flushBackgroundCommandCompletions();
    params.clearProgressReporter();
  }
}
