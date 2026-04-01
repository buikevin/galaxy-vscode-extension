/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound message, streaming, and debug actions extracted from the extension host entrypoint.
 */

import {
  addMessage,
  debugChatMessage,
  writeDebugBlock,
} from "./message-runtime";
import type { MessageRuntimeCallbacks } from "../shared/extension-host";
import type {
  ProviderMessageActionBindings,
  ProviderMessageActions,
} from "../shared/provider-message-actions";
import { writeDebugLine } from "./utils";

/** Builds provider-bound message, streaming, and debug actions from provider-owned state accessors and callbacks. */
export function createProviderMessageActions(
  bindings: ProviderMessageActionBindings,
): ProviderMessageActions {
  const clearStreamingBuffers: ProviderMessageActions["clearStreamingBuffers"] =
    () => {
      bindings.setStreamingAssistant("");
      bindings.setStreamingThinking("");
    };

  const messageRuntimeCallbacks: MessageRuntimeCallbacks = {
    getMessages: bindings.getMessages,
    appendMessage: bindings.appendMessage,
    getSelectedAgent: bindings.getSelectedAgent,
    appendLog: (kind, text) => {
      bindings.appendLog(kind, text);
    },
    clearStreamingBuffers,
    appendTranscriptMessage: bindings.appendTranscriptMessage,
    sanitizeChatMessageForWebview: bindings.sanitizeChatMessageForWebview,
    postMessage: bindings.postMessage,
    debugLogPath: bindings.debugLogPath,
  };

  return {
    clearStreamingBuffers,
    emitAssistantStream: async (delta) => {
      bindings.setStreamingAssistant(bindings.getStreamingAssistant() + delta);
      await bindings.postMessage({
        type: "assistant-stream",
        payload: { delta },
      });
    },
    emitAssistantThinking: async (delta) => {
      bindings.setStreamingThinking(bindings.getStreamingThinking() + delta);
      await bindings.postMessage({
        type: "assistant-thinking",
        payload: { delta },
      });
    },
    addMessage: async (message) => addMessage(messageRuntimeCallbacks, message),
    writeDebug: (scope, message) => {
      writeDebugLine(bindings.debugLogPath, scope, message);
    },
    writeDebugBlock: (scope, content) => {
      writeDebugBlock(bindings.debugLogPath, scope, content);
    },
    debugChatMessage: (message) => {
      debugChatMessage(
        bindings.debugLogPath,
        bindings.getSelectedAgent(),
        message,
      );
    },
  };
}
