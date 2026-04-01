/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound message, streaming, and debug actions.
 */

import type { ChatMessage, HostMessage, LogEntry } from "./protocol";

/** Provider-owned callbacks and state accessors required to build message actions. */
export type ProviderMessageActionBindings = Readonly<{
  /** Absolute path to the runtime debug log file. */
  debugLogPath: string;
  /** Returns the current transcript message list. */
  getMessages: () => readonly ChatMessage[];
  /** Appends one message to the provider transcript state. */
  appendMessage: (message: ChatMessage) => void;
  /** Returns the currently selected agent used for assistant dedupe/debugging. */
  getSelectedAgent: () => string;
  /** Runtime log sink used to report dedupe events. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  /** Persists one message into the transcript store. */
  appendTranscriptMessage: (message: ChatMessage) => void;
  /** Normalizes transcript messages for safe webview transport. */
  sanitizeChatMessageForWebview: (message: ChatMessage) => ChatMessage;
  /** Webview bridge used to post transcript and streaming updates. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Returns the current in-flight assistant stream buffer. */
  getStreamingAssistant: () => string;
  /** Stores the next in-flight assistant stream buffer. */
  setStreamingAssistant: (value: string) => void;
  /** Returns the current in-flight assistant thinking buffer. */
  getStreamingThinking: () => string;
  /** Stores the next in-flight assistant thinking buffer. */
  setStreamingThinking: (value: string) => void;
}>;

/** Provider-bound message, streaming, and debug actions exposed by extracted host helpers. */
export type ProviderMessageActions = Readonly<{
  /** Clears both in-flight assistant stream buffers from provider state. */
  clearStreamingBuffers: () => void;
  /** Emits one assistant stream delta and syncs it to the webview. */
  emitAssistantStream: (delta: string) => Promise<void>;
  /** Emits one assistant thinking delta and syncs it to the webview. */
  emitAssistantThinking: (delta: string) => Promise<void>;
  /** Appends one transcript message while deduplicating assistant echoes. */
  addMessage: (message: ChatMessage) => Promise<void>;
  /** Writes one single-line debug entry to the runtime debug log. */
  writeDebug: (scope: string, message: string) => void;
  /** Writes one multi-line debug block to the runtime debug log. */
  writeDebugBlock: (scope: string, content: string) => void;
  /** Writes one structured debug summary for a chat message. */
  debugChatMessage: (message: ChatMessage) => void;
}>;
