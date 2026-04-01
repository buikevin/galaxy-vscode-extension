/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for building chat runtime callbacks and file-tool bindings outside the extension entrypoint.
 */

import type { HistoryManager } from "../context/entities/history-manager";
import type { FileToolContext, ToolResult } from "../tools/entities/file-tools";
import type { ChatRuntimeCallbacks } from "./chat-runtime";
import type { GalaxyConfig } from "./config";
import type { AgentType, ChatMessage, HostMessage } from "./protocol";

/** Bound tool implementations injected into the extracted chat runtime callback builder. */
export type RuntimeToolBindings = Readonly<{
  /** Reveals one workspace file, optionally focusing a line range. */
  revealFile: FileToolContext["revealFile"];
  /** Refreshes the current workspace file list and selected-file state. */
  refreshWorkspaceFiles: () => Promise<void>;
  /** Opens the tracked diff viewer tool for one file. */
  openTrackedDiff: (filePath: string) => Promise<ToolResult>;
  /** Returns VS Code problem diagnostics for an optional file. */
  showProblems: (filePath?: string) => Promise<ToolResult>;
  /** Searches the workspace through the native search tool. */
  workspaceSearch: FileToolContext["workspaceSearch"];
  /** Finds symbol references inside the workspace. */
  findReferences: FileToolContext["findReferences"];
  /** Executes one VS Code extension command tool call. */
  executeExtensionCommand: FileToolContext["executeExtensionCommand"];
  /** Invokes one language-model tool exposed by another extension. */
  invokeLanguageModelTool: FileToolContext["invokeLanguageModelTool"];
  /** Searches the extension tool catalog. */
  searchExtensionTools: FileToolContext["searchExtensionTools"];
  /** Activates extension tools in the current workspace. */
  activateExtensionTools: FileToolContext["activateExtensionTools"];
  /** Reads the latest stored test failure artifact. */
  getLatestTestFailure: () => Promise<ToolResult>;
  /** Reads the latest stored review findings artifact. */
  getLatestReviewFindings: () => Promise<ToolResult>;
  /** Reads the next actionable review finding. */
  getNextReviewFinding: () => Promise<ToolResult>;
  /** Dismisses one stored review finding. */
  dismissReviewFinding: (findingId: string) => Promise<ToolResult>;
  /** Emits the start event for one project command stream. */
  onProjectCommandStart: FileToolContext["onProjectCommandStart"];
  /** Emits one chunk event for a project command stream. */
  onProjectCommandChunk: FileToolContext["onProjectCommandChunk"];
  /** Emits the end event for one project command stream. */
  onProjectCommandEnd: FileToolContext["onProjectCommandEnd"];
  /** Handles final completion for one project command stream. */
  onProjectCommandComplete: FileToolContext["onProjectCommandComplete"];
}>;

/** Parameters required to build one `ChatRuntimeCallbacks` object. */
export type CreateChatRuntimeCallbacksParams = Readonly<{
  /** Absolute workspace path used for tool context and telemetry wiring. */
  workspacePath: string;
  /** History manager used to track working turns and evidence. */
  historyManager: HistoryManager;
  /** Persists one transcript message into runtime state and storage. */
  addMessage: (message: ChatMessage) => Promise<void>;
  /** Appends one runtime log entry shown in the UI and output channel. */
  appendLog: ChatRuntimeCallbacks["appendLog"];
  /** Updates the provider status text before progress and run-state refreshes. */
  setStatusText: (statusText: string) => void;
  /** Reports one progress line through the active progress reporter. */
  reportProgress: (statusText: string) => void;
  /** Posts the current run-state snapshot to the webview. */
  postRunState: () => Promise<void>;
  /** Posts one host message to the live Galaxy webviews. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Streams one assistant text delta and updates provider-side buffers. */
  emitAssistantStream: (delta: string) => Promise<void>;
  /** Streams one assistant thinking delta and updates provider-side buffers. */
  emitAssistantThinking: (delta: string) => Promise<void>;
  /** Writes one chat message debug snapshot into the runtime debug log. */
  debugChatMessage: (message: ChatMessage) => void;
  /** Writes one short debug line into the runtime debug log. */
  writeDebug: (scope: string, message: string) => void;
  /** Writes one larger debug block into the runtime debug log. */
  writeDebugBlock: (scope: string, content: string) => void;
  /** Requests user approval for one pending tool action. */
  requestToolApproval: ChatRuntimeCallbacks["requestToolApproval"];
  /** Shows one VS Code error prompt and optional follow-up actions. */
  showWorkbenchError: (message: string) => void;
  /** Determines whether final assistant output should be gated behind review. */
  shouldGateAssistantFinalMessage: (filesWritten: readonly string[]) => boolean;
  /** Returns the latest effective runtime config. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Runs validation and review after a tool turn changes files. */
  runValidationAndReviewFlow: (
    agentType: AgentType,
  ) => Promise<Readonly<{ passed: boolean; repaired: boolean }>>;
  /** Returns whether streaming buffers currently hold pending UI output. */
  hasStreamingBuffers: () => boolean;
  /** Clears transient assistant and thinking buffers. */
  clearStreamingBuffers: () => void;
  /** Rebuilds and posts the initial webview state snapshot. */
  postInit: () => Promise<void>;
  /** Builds one continuation message for empty-result retry flows. */
  buildContinueMessage: ChatRuntimeCallbacks["buildContinueMessage"];
  /** Bound tool implementations used to construct one file-tool context. */
  tools: RuntimeToolBindings;
}>;

/** Provider-owned bindings used to create chat runtime callbacks without building the object inline. */
export type ProviderChatRuntimeBindings = Readonly<{
  /** Absolute workspace path used for tool context and telemetry wiring. */
  workspacePath: string;
  /** History manager used to track working turns and evidence. */
  historyManager: HistoryManager;
  /** Persists one transcript message into runtime state and storage. */
  addMessage: (message: ChatMessage) => Promise<void>;
  /** Appends one runtime log entry shown in the UI and output channel. */
  appendLog: ChatRuntimeCallbacks["appendLog"];
  /** Stores one new provider status text value. */
  setStatusText: (statusText: string) => void;
  /** Reports one progress line through the active progress reporter. */
  reportProgress: (statusText: string) => void;
  /** Posts the current run-state snapshot to the webview. */
  postRunState: () => Promise<void>;
  /** Posts one host message to the live Galaxy webviews. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Streams one assistant text delta and updates provider-side buffers. */
  emitAssistantStream: (delta: string) => Promise<void>;
  /** Streams one assistant thinking delta and updates provider-side buffers. */
  emitAssistantThinking: (delta: string) => Promise<void>;
  /** Writes one chat message debug snapshot into the runtime debug log. */
  debugChatMessage: (message: ChatMessage) => void;
  /** Writes one short debug line into the runtime debug log. */
  writeDebug: (scope: string, message: string) => void;
  /** Writes one larger debug block into the runtime debug log. */
  writeDebugBlock: (scope: string, content: string) => void;
  /** Requests user approval for one pending tool action. */
  requestToolApproval: ChatRuntimeCallbacks["requestToolApproval"];
  /** Shows one VS Code error prompt and optional follow-up actions. */
  showWorkbenchError: (message: string) => void;
  /** Determines whether final assistant output should be gated behind review. */
  shouldGateAssistantFinalMessage: (filesWritten: readonly string[]) => boolean;
  /** Returns the latest effective runtime config. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Runs validation and review after a tool turn changes files. */
  runValidationAndReviewFlow: (
    agentType: AgentType,
  ) => Promise<Readonly<{ passed: boolean; repaired: boolean }>>;
  /** Returns whether streaming buffers currently hold pending UI output. */
  hasStreamingBuffers: () => boolean;
  /** Clears transient assistant and thinking buffers. */
  clearStreamingBuffers: () => void;
  /** Rebuilds and posts the initial webview state snapshot. */
  postInit: () => Promise<void>;
  /** Builds one continuation message for empty-result retry flows. */
  buildContinueMessage: ChatRuntimeCallbacks["buildContinueMessage"];
  /** Bound tool implementations used to construct one file-tool context. */
  tools: RuntimeToolBindings;
}>;
