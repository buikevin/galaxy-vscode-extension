/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Chat runtime and quality-gate helpers extracted from GalaxyChatViewProvider.
 */

import { randomUUID } from "node:crypto";
import {
  runInternalRepairTurn as runHostedInternalRepairTurn,
  runSelectiveMultiAgentPlan as runHostedSelectiveMultiAgentPlan,
} from "./chat-runtime";
import {
  buildContinueMessage as buildHostedContinueMessage,
  shouldGateAssistantFinalMessage as shouldHostedGateAssistantFinalMessage,
} from "./chat-runtime-state";
import { createProviderChatRuntimeCallbacks as createHostedProviderChatRuntimeCallbacks } from "./chat-runtime-callbacks";
import { handleChatSendMessage as handleHostedChatSendMessage } from "./chat-send";
import { runProviderValidationAndReviewFlow as runHostedProviderQualityGateFlow } from "./quality-gates";
import {
  buildResetProviderWorkspaceSessionParams as buildHostedResetProviderWorkspaceSessionParams,
  appendTranscriptMessage as appendHostedTranscriptMessage,
  persistProjectMetaPatch as persistHostedProjectMetaPatch,
  resetProviderWorkspaceSession,
} from "./session-lifecycle";
import {
  handleWebviewAction as handleHostedWebviewAction,
} from "./webview-actions";
import type { ProviderQualityGateBindings } from "../shared/quality-gates";
import type { ChatRuntimeCallbacks } from "../shared/chat-runtime";
import type {
  ChatMessage,
  HostMessage,
  LogEntry,
  QualityPreferences,
  ToolCapabilities,
  WebviewMessage,
} from "../shared/protocol";
import type { AgentType } from "../shared/protocol";
import type { HistoryManager } from "../context/entities/history-manager";
import type { ProjectStorageInfo } from "../context/entities/project-store";
import type { ResetWorkspaceSessionOptions } from "../shared/workspace-reset";
import type { WebviewActionCallbacks } from "../shared/webview-actions";
import { loadConfig } from "../config/manager";

/**
 * Handles one webview message by delegating non-chat actions first, then the chat send flow.
 */
export async function handleProviderMessage(params: {
  workspacePath: string;
  message: WebviewMessage;
  webviewActionCallbacks: WebviewActionCallbacks;
  getMessageActions: () => {
    debugChatMessage: (message: ChatMessage) => void;
    clearStreamingBuffers: () => void;
    writeDebug: (scope: string, text: string) => void;
    writeDebugBlock: (scope: string, content: string) => void;
  };
  getQualityActions: () => {
    applyQualityPreferences: (prefs: QualityPreferences) => Promise<void>;
  };
  getWorkbenchActions: () => {
    updateWorkbenchChrome: () => void;
    postRunState: () => Promise<void>;
    showWorkbenchError: (message: string) => void;
  };
  isRunning: boolean;
  selectedAgent: AgentType;
  qualityPreferences: QualityPreferences;
  toolCapabilities: ToolCapabilities;
  setSelectedAgent: (agent: AgentType) => void;
  persistSelectedAgent: () => void;
  appendUserMessage: (message: ChatMessage) => void;
  projectStorage: ProjectStorageInfo;
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  setRunningState: (isRunning: boolean, statusText: string) => void;
  clearProgressReporter: () => void;
  getEffectiveConfig: () => ReturnType<typeof loadConfig>;
  runSelectiveMultiAgentPlan: (opts: {
    config: ReturnType<typeof loadConfig>;
    agentType: AgentType;
    originalUserMessage: ChatMessage;
    contextNote?: string;
  }) => Promise<Readonly<{ handled: boolean; hadError: boolean; filesWritten: readonly string[] }>>;
  getChatRuntimeCallbacks: () => ChatRuntimeCallbacks;
  runValidationAndReviewFlow: (agentType: AgentType) => Promise<Readonly<{ passed: boolean; repaired: boolean }>>;
  clearCurrentTurn: () => void;
  postMessage: (message: HostMessage) => Promise<void>;
  flushBackgroundCommandCompletions: () => Promise<void>;
}): Promise<void> {
  if (
    await handleHostedWebviewAction(
      params.message,
      params.webviewActionCallbacks as never,
    )
  ) {
    return;
  }

  switch (params.message.type) {
    case "chat-send": {
      const messageActions = params.getMessageActions();
      const qualityActions = params.getQualityActions();
      const workbenchActions = params.getWorkbenchActions();
      await handleHostedChatSendMessage({
        workspacePath: params.workspacePath,
        message: params.message,
        isRunning: params.isRunning,
        selectedAgent: params.selectedAgent,
        qualityPreferences: params.qualityPreferences,
        toolCapabilities: params.toolCapabilities,
        setSelectedAgent: params.setSelectedAgent,
        persistSelectedAgent: params.persistSelectedAgent,
        updateWorkbenchChrome: () => workbenchActions.updateWorkbenchChrome(),
        applyQualityPreferences: qualityActions.applyQualityPreferences,
        createMessageId: () => randomUUID(),
        appendUserMessage: params.appendUserMessage,
        appendTranscriptMessage: (nextMessage) =>
          appendHostedTranscriptMessage(params.projectStorage, nextMessage),
        appendLog: params.appendLog,
        debugChatMessage: (nextMessage) =>
          messageActions.debugChatMessage(nextMessage),
        clearStreamingBuffers: () => messageActions.clearStreamingBuffers(),
        setRunningState: params.setRunningState,
        postRunState: () => workbenchActions.postRunState(),
        clearProgressReporter: params.clearProgressReporter,
        getEffectiveConfig: params.getEffectiveConfig,
        runSelectiveMultiAgentPlan: params.runSelectiveMultiAgentPlan,
        getChatRuntimeCallbacks: params.getChatRuntimeCallbacks,
        runValidationAndReviewFlow: params.runValidationAndReviewFlow,
        clearCurrentTurn: params.clearCurrentTurn,
        writeDebug: (scope, text) => messageActions.writeDebug(scope, text),
        writeDebugBlock: (scope, content) =>
          messageActions.writeDebugBlock(scope, content),
        postMessage: params.postMessage,
        showWorkbenchError: (runtimeError) =>
          workbenchActions.showWorkbenchError(runtimeError),
        flushBackgroundCommandCompletions:
          params.flushBackgroundCommandCompletions,
      });
      return;
    }
  }
}

/**
 * Builds the callback bag consumed by hosted chat execution and tool orchestration.
 */
export function buildProviderChatRuntimeCallbacks(bindings: Parameters<typeof createHostedProviderChatRuntimeCallbacks>[0]): ChatRuntimeCallbacks {
  return createHostedProviderChatRuntimeCallbacks(bindings);
}

/**
 * Runs the selective multi-agent plan used by the hosted chat runtime.
 */
export async function runProviderSelectiveMultiAgentPlan(
  callbacks: ChatRuntimeCallbacks,
  opts: {
    config: ReturnType<typeof loadConfig>;
    agentType: AgentType;
    originalUserMessage: ChatMessage;
    contextNote?: string;
  },
): Promise<Readonly<{ handled: boolean; hadError: boolean; filesWritten: readonly string[] }>> {
  return runHostedSelectiveMultiAgentPlan(callbacks, opts);
}

/**
 * Runs one internal repair turn triggered by validation or review follow-up flows.
 */
export async function runProviderInternalRepairTurn(
  callbacks: ChatRuntimeCallbacks,
  opts: {
    config: ReturnType<typeof loadConfig>;
    agentType: AgentType;
    userMessage: ChatMessage;
    contextNote?: string;
    emptyContinueAttempt?: number;
  },
): Promise<Readonly<{ hadError: boolean; filesWritten: readonly string[] }>> {
  return runHostedInternalRepairTurn(callbacks, opts);
}

/**
 * Coordinates the hosted validation and review pipeline after a write-producing turn.
 */
export async function runProviderValidationAndReviewFlow(
  bindings: ProviderQualityGateBindings,
): Promise<Readonly<{ passed: boolean; repaired: boolean }>> {
  return runHostedProviderQualityGateFlow(bindings);
}

/**
 * Resets all provider-owned runtime state tied to the current workspace session.
 */
export function resetProviderSessionState(params: Parameters<typeof buildHostedResetProviderWorkspaceSessionParams>[0], opts?: ResetWorkspaceSessionOptions): void {
  resetProviderWorkspaceSession(
    buildHostedResetProviderWorkspaceSessionParams(params),
    opts,
  );
}
