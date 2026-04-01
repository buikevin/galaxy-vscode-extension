/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for session history manager APIs.
 */

import type { ChatMessage } from '../../shared/protocol';
import type { ToolCall, ToolResult } from '../../tools/entities/file-tools';
import type { SessionMemory, TurnDigest, WorkingTurn } from './history';

/**
 * Public history manager contract used by chat orchestration.
 */
export interface HistoryManager {
  /**
   * Returns static notes attached to the current manager instance.
   */
  getNotes(): string;
  /**
   * Returns the persistent workspace id bound to this manager.
   */
  getWorkspaceId(): string;
  /**
   * Returns the latest session memory snapshot.
   */
  getSessionMemory(): SessionMemory;
  /**
   * Returns the active in-memory working turn if one exists.
   */
  getWorkingTurn(): WorkingTurn | null;
  /**
   * Starts a new working turn for the provided user message.
   */
  startTurn(userMessage: ChatMessage, contextNote?: string): WorkingTurn;
  /**
   * Appends streamed assistant draft text to the active working turn.
   */
  appendAssistantDraft(text: string): void;
  /**
   * Appends a non-tool context message to the active working turn.
   */
  appendContextMessage(message: ChatMessage): void;
  /**
   * Appends a tool message and derives a tool digest from it.
   */
  appendToolMessage(message: ChatMessage): void;
  /**
   * Persists structured tool evidence for later retrieval.
   */
  appendToolEvidence(opts: { call: ToolCall; result: ToolResult; toolCallId?: string }): void;
  /**
   * Increments the assistant round counter for the current turn.
   */
  incrementRound(): void;
  /**
   * Compacts the active working turn when prompt budget pressure requires it.
   */
  compactWorkingTurn(opts?: {
    force?: boolean;
    workingTurnBudget?: number;
    promptTokensEstimate?: number;
  }): boolean;
  /**
   * Finalizes the active turn and optionally commits the conclusion into memory.
   */
  finalizeTurn(opts: { assistantText: string; commitConclusion?: boolean }): TurnDigest | null;
  /**
   * Records an external event that should influence session memory.
   */
  recordExternalEvent(summary: string, filesTouched?: readonly string[]): void;
  /**
   * Drops the in-memory working turn without clearing persisted memory.
   */
  clearCurrentTurn(): void;
  /**
   * Resets both working state and persisted session state.
   */
  clearAll(): void;
  /**
   * Persists the current session memory snapshot.
   */
  save(): void;
}
