/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Transcript message syncing and debug-log helpers extracted from the extension host entrypoint.
 */

import { MAX_DEBUG_BLOCK_CHARS, MAX_LOG_ENTRIES } from "../shared/constants";
import type { ChatMessage, HostMessage, LogEntry } from "../shared/protocol";
import type { MessageRuntimeCallbacks } from "../shared/extension-host";
import type { ProviderRuntimeLogBindings } from "../shared/message-runtime";
import { writeDebugLine } from "./utils";

function writeDebug(
  debugLogPath: string,
  scope: string,
  message: string,
): void {
  writeDebugLine(debugLogPath, scope, message);
}

/** Writes a truncated multi-line debug block to the Galaxy debug log. */
export function writeDebugBlock(
  debugLogPath: string,
  scope: string,
  content: string,
): void {
  if (!content.trim()) {
    writeDebug(debugLogPath, scope, "(empty)");
    return;
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const truncated =
    normalized.length > MAX_DEBUG_BLOCK_CHARS
      ? `${normalized.slice(0, MAX_DEBUG_BLOCK_CHARS)}\n\n...[truncated ${normalized.length - MAX_DEBUG_BLOCK_CHARS} chars]`
      : normalized;
  const lines = truncated.split("\n");
  writeDebug(debugLogPath, scope, `BEGIN (${normalized.length} chars)`);
  for (const line of lines) {
    writeDebugLine(debugLogPath, scope, line);
  }
  writeDebug(debugLogPath, scope, "END");
}

/** Writes one structured transcript/debug summary for a chat message. */
export function debugChatMessage(
  debugLogPath: string,
  selectedAgent: string,
  message: ChatMessage,
): void {
  if (message.role === "assistant") {
    const agentLabel = message.agentType ?? selectedAgent;
    writeDebug(
      debugLogPath,
      "assistant-message",
      `agent=${agentLabel} text_len=${message.content.length} thinking_len=${message.thinking?.length ?? 0} tool_calls=${message.toolCalls?.length ?? 0}`,
    );
    writeDebugBlock(debugLogPath, "assistant-content", message.content);
    if (message.thinking?.trim()) {
      writeDebugBlock(debugLogPath, "assistant-thinking", message.thinking);
    }
    if (message.toolCalls?.length) {
      writeDebugBlock(
        debugLogPath,
        "assistant-tool-calls",
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

  if (message.role === "tool") {
    const commandState =
      typeof message.toolMeta?.commandState === "string"
        ? String(message.toolMeta.commandState)
        : message.toolMeta?.background === true
          ? "running"
          : "completed";
    writeDebug(
      debugLogPath,
      "tool-message",
      `name=${message.toolName ?? "(unknown)"} success=${String(message.toolSuccess ?? false)} state=${commandState} call_id=${message.toolCallId ?? "(none)"}`,
    );
    if (message.toolParams) {
      writeDebugBlock(
        debugLogPath,
        "tool-params",
        JSON.stringify(message.toolParams, null, 2),
      );
    }
    writeDebugBlock(debugLogPath, "tool-content", message.content);
    return;
  }

  if (message.role === "user") {
    writeDebug(
      debugLogPath,
      "user-message",
      `text_len=${message.content.length} attachments=${message.attachments?.length ?? 0} figma=${message.figmaAttachments?.length ?? 0} images=${message.images?.length ?? 0}`,
    );
  }
}

/** Appends one transcript message while deduplicating assistant echoes and syncing the webview. */
export async function addMessage(
  callbacks: MessageRuntimeCallbacks,
  message: ChatMessage,
): Promise<void> {
  const messages = callbacks.getMessages();
  const lastMessage = messages[messages.length - 1];
  if (
    message.role === "assistant" &&
    lastMessage?.role === "assistant" &&
    (message.agentType ?? callbacks.getSelectedAgent()) ===
      (lastMessage.agentType ?? callbacks.getSelectedAgent()) &&
    ((message.content.trim() === lastMessage.content.trim() &&
      (message.thinking ?? "").trim() ===
        (lastMessage.thinking ?? "").trim()) ||
      (Boolean(lastMessage.toolCalls?.length) &&
        message.content.trim().length > 0 &&
        message.content.trim() === lastMessage.content.trim()))
  ) {
    callbacks.appendLog("info", "Skipped duplicate assistant message.");
    return;
  }

  callbacks.appendMessage(message);
  if (message.role === "assistant") {
    callbacks.clearStreamingBuffers();
  }
  callbacks.appendTranscriptMessage(message);
  await callbacks.postMessage({
    type: "message-added",
    payload: callbacks.sanitizeChatMessageForWebview(message),
  });
}

/** Appends one runtime log entry and mirrors it into the output channel plus webview. */
export function appendRuntimeLog(
  bindings: ProviderRuntimeLogBindings,
  kind: LogEntry["kind"],
  text: string,
): void {
  const entry = Object.freeze({
    id: bindings.createMessageId(),
    kind,
    text,
    timestamp: Date.now(),
  });
  const nextRuntimeLogs = [
    ...bindings.runtimeLogs.slice(-(MAX_LOG_ENTRIES - 1)),
    entry,
  ] as const;
  bindings.setRuntimeLogs(nextRuntimeLogs);
  writeDebugLine(bindings.debugLogPath, kind, text);
  const timestamp = new Date(entry.timestamp).toTimeString().slice(0, 8);
  bindings.outputChannel.appendLine(`[${timestamp}] [${kind}] ${text}`);
  void bindings.postMessage({
    type: "logs-updated",
    payload: { logs: nextRuntimeLogs },
  });
}
