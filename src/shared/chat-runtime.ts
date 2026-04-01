/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for selective multi-agent and repair-turn runtime helpers extracted from the extension host entrypoint.
 */

import type { HistoryManager } from "../context/entities/history-manager";
import type { FileToolContext } from "../tools/entities/file-tools";
import type { GalaxyConfig } from "./config";
import type { RepairTurnRequest, RepairTurnResult } from "./extension-host";
import type {
  AgentType,
  ChatMessage,
  EvidenceContextPayload,
  ToolApprovalDecision,
} from "./protocol";
import type { PendingActionApproval, RunResult, StreamChunk } from "./runtime";

/** Request used to run one selective multi-agent plan outside the main provider class. */
export type SelectiveMultiAgentPlanRequest = Readonly<{
  /** Effective runtime config used to build sub-agent configs and plans. */
  config: GalaxyConfig;
  /** Agent type selected for the current user turn. */
  agentType: AgentType;
  /** Original user message that triggered the selective planner. */
  originalUserMessage: ChatMessage;
  /** Optional context note already prepared for the current user turn. */
  contextNote?: string;
}>;

/** Result returned by one selective multi-agent orchestration attempt. */
export type SelectiveMultiAgentPlanResult = Readonly<{
  /** Whether the selective planner handled the request instead of falling back to the normal chat path. */
  handled: boolean;
  /** Whether any subtask failed while the plan was running. */
  hadError: boolean;
  /** Files written across all completed subtasks. */
  filesWritten: readonly string[];
}>;

/** Request used to run one normal chat turn through the extracted host runtime helper. */
export type MainChatTurnRequest = Readonly<{
  /** Effective runtime config for the current turn. */
  config: GalaxyConfig;
  /** Agent type selected for the current user turn. */
  agentType: AgentType;
  /** User message already recorded in the transcript before the turn starts. */
  userMessage: ChatMessage;
  /** Optional extra context note assembled from selected files and attachments. */
  contextNote?: string;
}>;

/** Result returned by one extracted main chat turn execution. */
export type MainChatTurnResult = Readonly<{
  /** Whether the runtime surfaced an error chunk during execution. */
  hadError: boolean;
  /** Final `runExtensionChat` result captured for post-processing in the provider. */
  result: RunResult;
}>;

/** Request used to post-process the result of one extracted main chat turn. */
export type MainChatTurnOutcomeRequest = Readonly<{
  /** Effective runtime config used when auto-continuing the turn. */
  config: GalaxyConfig;
  /** Agent type selected for the current user turn. */
  agentType: AgentType;
  /** Whether the streaming run already surfaced an error chunk. */
  hadError: boolean;
  /** Raw chat runtime result returned by the main turn helper. */
  result: RunResult;
}>;

/** Final provider-facing outcome after post-processing one main chat turn result. */
export type MainChatTurnOutcomeResult = Readonly<{
  /** Whether the turn ended in an error after retries and quality handling. */
  hadError: boolean;
}>;

/** Shared callbacks required by extracted chat-runtime helpers. */
export type ChatRuntimeCallbacks = Readonly<{
  /** Absolute workspace path used for telemetry and tool-context wiring. */
  workspacePath: string;
  /** History manager used to track working turns and evidence. */
  historyManager: HistoryManager;
  /** Adds one transcript message into host state and persistence. */
  addMessage: (message: ChatMessage) => Promise<void>;
  /** Writes one runtime log line for status, review, or error updates. */
  appendLog: (
    kind: "info" | "status" | "approval" | "validation" | "review" | "error",
    text: string,
  ) => void;
  /** Updates the provider status text before progress or run-state refresh. */
  setStatusText: (statusText: string) => void;
  /** Reports one progress-line update to the current progress reporter. */
  reportProgress: (statusText: string) => void;
  /** Posts the current run-state snapshot into the webview. */
  postRunState: () => Promise<void>;
  /** Builds the file-tool context used by `runExtensionChat` for one config snapshot. */
  buildToolContext: (config: GalaxyConfig) => FileToolContext;
  /** Handles streamed text, thinking, and error chunks emitted by `runExtensionChat`. */
  onChunk: (chunk: StreamChunk, agentType: AgentType) => Promise<void>;
  /** Handles completed transcript messages emitted by `runExtensionChat`. */
  onMessage: (message: ChatMessage) => Promise<void>;
  /** Handles emitted tool-call batches for debug logging. */
  onToolCalls: (
    scope: "turn" | "repair-turn",
    toolCalls: readonly Readonly<{
      id: string;
      name: string;
      params: Record<string, unknown>;
    }>[],
  ) => Promise<void>;
  /** Handles evidence-context payloads for debug logging and webview updates. */
  onEvidenceContext: (
    scope: "turn" | "repair-turn",
    payload: EvidenceContextPayload,
  ) => Promise<void>;
  /** Requests user approval for one pending tool action. */
  requestToolApproval: (
    approval: PendingActionApproval,
  ) => Promise<ToolApprovalDecision>;
  /** Shows one workbench error toast and reveals the relevant UI. */
  showWorkbenchError: (message: string) => void;
  /** Posts one error payload into the webview message channel. */
  postErrorMessage: (message: string) => Promise<void>;
  /** Writes one short debug line into the runtime debug log. */
  writeDebug: (scope: string, message: string) => void;
  /** Writes one larger debug block into the runtime debug log. */
  writeDebugBlock: (scope: string, content: string) => void;
  /** Determines whether final assistant output should be gated behind quality review. */
  shouldGateAssistantFinalMessage: (filesWritten: readonly string[]) => boolean;
  /** Returns the latest effective config snapshot for continuation turns. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Runs validation and review for the given agent after files change. */
  runValidationAndReviewFlow: (
    agentType: AgentType,
  ) => Promise<Readonly<{ passed: boolean; repaired: boolean }>>;
  /** Whether the streamed assistant buffers currently contain content. */
  hasStreamingBuffers: () => boolean;
  /** Clears transient streaming buffers after gated turns. */
  clearStreamingBuffers: () => void;
  /** Re-posts initial webview state after stream buffers are cleared. */
  postInit: () => Promise<void>;
  /** Builds a continuation message for empty-result retry flows. */
  buildContinueMessage: (opts: {
    attempt: number;
    lastUserGoal?: string;
    lastThinking?: string;
    filesWritten?: readonly string[];
    recentToolSummaries?: readonly string[];
  }) => ChatMessage;
}>;

export type { RepairTurnRequest, RepairTurnResult };
