/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Builders for chat runtime callback and tool-context wiring extracted from the extension entrypoint.
 */

import type { HistoryManager } from "../context/entities/history-manager";
import type { EvidenceContextPayload } from "../shared/protocol";
import type {
  CreateChatRuntimeCallbacksParams,
  ProviderChatRuntimeBindings,
  RuntimeToolBindings,
} from "../shared/chat-runtime-callbacks";
import type { ChatRuntimeCallbacks } from "../shared/chat-runtime";
import type { FileToolContext } from "../tools/entities/file-tools";

/**
 * Builds one `FileToolContext` instance from provider-bound tool implementations.
 *
 * @param workspacePath Absolute workspace root used by tool operations.
 * @param tools Bound tool implementations delegated from the provider.
 * @param config Effective runtime config snapshot for the current turn.
 * @returns File-tool context passed into `runExtensionChat`.
 */
function buildToolContext(
  workspacePath: string,
  tools: RuntimeToolBindings,
  config: CreateChatRuntimeCallbacksParams["getEffectiveConfig"] extends () => infer TResult
    ? TResult
    : never,
): FileToolContext {
  return {
    workspaceRoot: workspacePath,
    config,
    revealFile: tools.revealFile,
    refreshWorkspaceFiles: async () => tools.refreshWorkspaceFiles(),
    openTrackedDiff: async (filePath) => tools.openTrackedDiff(filePath),
    showProblems: async (filePath) => tools.showProblems(filePath),
    workspaceSearch: tools.workspaceSearch,
    findReferences: tools.findReferences,
    executeExtensionCommand: tools.executeExtensionCommand,
    invokeLanguageModelTool: tools.invokeLanguageModelTool,
    searchExtensionTools: tools.searchExtensionTools,
    activateExtensionTools: tools.activateExtensionTools,
    getLatestTestFailure: async () => tools.getLatestTestFailure(),
    getLatestReviewFindings: async () => tools.getLatestReviewFindings(),
    getNextReviewFinding: async () => tools.getNextReviewFinding(),
    dismissReviewFinding: async (findingId) =>
      tools.dismissReviewFinding(findingId),
    onProjectCommandStart: tools.onProjectCommandStart,
    onProjectCommandChunk: tools.onProjectCommandChunk,
    onProjectCommandEnd: tools.onProjectCommandEnd,
    onProjectCommandComplete: tools.onProjectCommandComplete,
  };
}

/**
 * Renders one evidence-context payload into a debug-log friendly text block.
 *
 * @param payload Evidence context emitted by the runtime.
 * @returns Multiline debug text summarizing focus symbols, planning, and read progress.
 */
function formatEvidenceContext(payload: EvidenceContextPayload): string {
  return [
    payload.focusSymbols?.length
      ? `Focus symbols: ${payload.focusSymbols.join(", ")}`
      : "",
    payload.manualPlanningContent ?? "",
    payload.manualReadBatchItems
      ?.map((item, index) => `Batch ${index + 1}: ${item}`)
      .join("\n") ?? "",
    payload.readPlanProgressItems
      ?.map(
        (item) =>
          `${item.confirmed ? "[confirmed]" : "[pending]"} ${item.label}`,
      )
      .join("\n") ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Builds the chat runtime callback bundle used by the extracted runtime helpers.
 *
 * @param params Provider-bound callbacks, runtime state accessors, and tool bindings.
 * @returns Fully wired `ChatRuntimeCallbacks` object for host runtime helpers.
 */
export function createChatRuntimeCallbacks(
  params: CreateChatRuntimeCallbacksParams,
): ChatRuntimeCallbacks {
  return {
    workspacePath: params.workspacePath,
    historyManager: params.historyManager,
    addMessage: async (message) => params.addMessage(message),
    appendLog: params.appendLog,
    setStatusText: params.setStatusText,
    reportProgress: params.reportProgress,
    postRunState: params.postRunState,
    buildToolContext: (config) =>
      buildToolContext(params.workspacePath, params.tools, config),
    onChunk: async (chunk) => {
      if (chunk.type === "text") {
        await params.emitAssistantStream(chunk.delta);
        return;
      }

      if (chunk.type === "thinking") {
        await params.emitAssistantThinking(chunk.delta);
        return;
      }

      if (chunk.type === "error") {
        await params.postMessage({
          type: "error",
          payload: { message: chunk.message },
        });
        params.showWorkbenchError(chunk.message);
      }
    },
    onMessage: async (message) => {
      params.debugChatMessage(message);
      await params.addMessage(message);
    },
    onToolCalls: async (scope, toolCalls) => {
      params.writeDebugBlock(
        scope === "repair-turn" ? "repair-turn-tool-calls" : "turn-tool-calls",
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
    onEvidenceContext: async (scope, payload) => {
      if (scope === "turn") {
        if (payload.manualReadBatchItems?.length) {
          params.appendLog(
            "info",
            `Manual read plan: ${payload.manualReadBatchItems[0]}`,
          );
        }
        if (payload.readPlanProgressItems?.length) {
          params.appendLog(
            "info",
            `Read plan progress: ${payload.confirmedReadCount ?? 0}/${payload.readPlanProgressItems.length} confirmed`,
          );
        }
      }

      params.writeDebugBlock(
        scope === "repair-turn"
          ? "repair-manual-read-plan"
          : "manual-read-plan",
        formatEvidenceContext(payload),
      );
      await params.postMessage({
        type: "evidence-context",
        payload,
      });
    },
    requestToolApproval: params.requestToolApproval,
    showWorkbenchError: params.showWorkbenchError,
    postErrorMessage: async (message) => {
      await params.postMessage({
        type: "error",
        payload: { message },
      });
    },
    writeDebug: params.writeDebug,
    writeDebugBlock: params.writeDebugBlock,
    shouldGateAssistantFinalMessage: params.shouldGateAssistantFinalMessage,
    getEffectiveConfig: params.getEffectiveConfig,
    runValidationAndReviewFlow: params.runValidationAndReviewFlow,
    hasStreamingBuffers: params.hasStreamingBuffers,
    clearStreamingBuffers: params.clearStreamingBuffers,
    postInit: params.postInit,
    buildContinueMessage: params.buildContinueMessage,
  };
}

/** Builds chat runtime callbacks directly from provider-owned bindings. */
export function createProviderChatRuntimeCallbacks(
  bindings: ProviderChatRuntimeBindings,
): ChatRuntimeCallbacks {
  return createChatRuntimeCallbacks({
    workspacePath: bindings.workspacePath,
    historyManager: bindings.historyManager,
    addMessage: bindings.addMessage,
    appendLog: bindings.appendLog,
    setStatusText: bindings.setStatusText,
    reportProgress: bindings.reportProgress,
    postRunState: bindings.postRunState,
    postMessage: bindings.postMessage,
    emitAssistantStream: bindings.emitAssistantStream,
    emitAssistantThinking: bindings.emitAssistantThinking,
    debugChatMessage: bindings.debugChatMessage,
    writeDebug: bindings.writeDebug,
    writeDebugBlock: bindings.writeDebugBlock,
    requestToolApproval: bindings.requestToolApproval,
    showWorkbenchError: bindings.showWorkbenchError,
    shouldGateAssistantFinalMessage: bindings.shouldGateAssistantFinalMessage,
    getEffectiveConfig: bindings.getEffectiveConfig,
    runValidationAndReviewFlow: bindings.runValidationAndReviewFlow,
    hasStreamingBuffers: bindings.hasStreamingBuffers,
    clearStreamingBuffers: bindings.clearStreamingBuffers,
    postInit: bindings.postInit,
    buildContinueMessage: bindings.buildContinueMessage,
    tools: bindings.tools,
  });
}
