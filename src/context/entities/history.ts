/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for session memory, prompt build output, and working-turn history.
 */

import type { ChatMessage } from '../../shared/protocol';

/**
 * Compact summary of one tool action used inside turn history.
 */
export type ToolDigest = Readonly<{
  /** Tool name executed during the turn. */
  name: string;
  /** Whether the tool invocation completed successfully. */
  success: boolean;
  /** Short summary kept in compact turn history. */
  summary: string;
  /** Files read by the tool during this invocation. */
  filesRead: readonly string[];
  /** Files written by the tool during this invocation. */
  filesWritten: readonly string[];
  /** Files reverted by the tool during this invocation. */
  filesReverted: readonly string[];
}>;

/**
 * In-memory state for the currently active user turn.
 */
export type WorkingTurn = Readonly<{
  /** Stable id assigned to the in-progress turn. */
  turnId: string;
  /** Original user message that started the turn. */
  userMessage: ChatMessage;
  /** Optional context note assembled before the model call. */
  contextNote?: string;
  /** Streaming assistant draft accumulated so far. */
  assistantDraft: string;
  /** Context messages currently injected into the prompt. */
  contextMessages: readonly ChatMessage[];
  /** Tool actions already completed inside the turn. */
  toolDigests: readonly ToolDigest[];
  /** Number of model rounds already executed in this turn. */
  roundCount: number;
  /** Approximate token count for the turn state. */
  tokenEstimate: number;
  /** Timestamp when the turn started. */
  startedAt: number;
  /** Whether compaction has already run for this turn. */
  compacted: boolean;
  /** Optional summary produced after compaction. */
  compactSummary?: string;
  /** Count of context messages removed during compaction. */
  droppedContextMessages: number;
}>;

/**
 * Durable digest of one finalized turn.
 */
export type TurnDigest = Readonly<{
  /** Stable id of the finalized turn. */
  turnId: string;
  /** User message text captured for history retrieval. */
  userMessage: string;
  /** Assistant-side summary of the completed turn. */
  assistantSummary: string;
  /** Tool summaries retained from the turn. */
  toolDigests: readonly ToolDigest[];
  /** Decisions extracted from the turn outcome. */
  keyDecisions: readonly string[];
  /** Remaining open items after the turn completed. */
  pendingItems: readonly string[];
  /** Files touched while handling the turn. */
  filesTouched: readonly string[];
  /** Token estimate of the serialized turn digest. */
  tokenEstimate: number;
  /** Timestamp when the digest was created. */
  createdAt: number;
}>;

/**
 * Short-lived task memory carried across compacted turns.
 */
export type ActiveTaskMemory = Readonly<{
  /** Stable task identifier when one has been assigned. */
  taskId: string | null;
  /** Original user goal that kicked off the task. */
  originalUserGoal: string;
  /** Current objective the agent should prioritize next. */
  currentObjective: string;
  /** Checklist items defining when the task is done. */
  definitionOfDone: readonly string[];
  /** Steps that have already been completed. */
  completedSteps: readonly string[];
  /** Remaining steps still pending. */
  pendingSteps: readonly string[];
  /** Known blockers currently preventing completion. */
  blockers: readonly string[];
  /** Files touched while working on the active task. */
  filesTouched: readonly string[];
  /** High-signal files that should stay in retrieval focus. */
  keyFiles: readonly string[];
  /** Attachment identifiers relevant to the task. */
  attachments: readonly string[];
  /** Commands denied by the user or policy during the task. */
  deniedCommands: readonly string[];
  /** Summaries of recent turns used for handoff continuity. */
  recentTurnSummaries: readonly string[];
  /** Short handoff summary bridging compacted turns. */
  handoffSummary: string;
  /** Last update timestamp for freshness checks. */
  lastUpdatedAt: number;
}>;

/**
 * Longer-lived project memory reused across multiple user tasks.
 */
export type ProjectMemory = Readonly<{
  /** Persistent summary of the project or workspace. */
  summary: string;
  /** Coding conventions or standards learned for the project. */
  conventions: readonly string[];
  /** Recurring pitfalls the agent should avoid repeating. */
  recurringPitfalls: readonly string[];
  /** Recent design or implementation decisions worth remembering. */
  recentDecisions: readonly string[];
  /** Key files that matter across multiple tasks. */
  keyFiles: readonly string[];
  /** Last update timestamp for freshness checks. */
  lastUpdatedAt: number;
}>;

/**
 * Persisted session memory snapshot for one workspace.
 */
export type SessionMemory = Readonly<{
  /** Stable workspace id used for persistence and retrieval. */
  workspaceId: string;
  /** Absolute workspace path this memory belongs to. */
  workspacePath: string;
  /** Active task memory carried across turns. */
  activeTaskMemory: ActiveTaskMemory;
  /** Longer-lived project memory shared across tasks. */
  projectMemory: ProjectMemory;
  /** Last final assistant conclusion shown to the user. */
  lastFinalAssistantConclusion: string;
  /** Combined key files derived from task and project memory. */
  keyFiles: readonly string[];
  /** Last update timestamp for persistence and invalidation. */
  lastUpdatedAt: number;
}>;

/**
 * Per-item progress summary for the manual read plan block.
 */
export type ReadPlanProgressItem = Readonly<{
  /** Human-readable label shown in prompt/read-plan UI. */
  label: string;
  /** Whether the step has already been confirmed by evidence. */
  confirmed: boolean;
  /** Fine-grained status used for reread gating and summaries. */
  status?: 'confirmed' | 'needs_refresh' | 'pending';
  /** Optional evidence summary backing the status. */
  evidenceSummary?: string;
  /** File path targeted by the read-plan step. */
  targetPath: string;
  /** Optional symbol name associated with the step. */
  symbolName?: string;
  /** Tool the agent should use to execute the step. */
  tool: 'read_file' | 'grep';
}>;

/**
 * Guard metadata used to stop broad rereads when workflow evidence is sufficient.
 */
export type WorkflowRereadGuard = Readonly<{
  /** Whether the guard should actively block broad rereads. */
  enabled: boolean;
  /** File paths protected by the current workflow evidence. */
  candidatePaths: readonly string[];
  /** Number of workflow entries supporting the guard. */
  entryCount: number;
  /** Original query text that triggered the guard. */
  queryText: string;
}>;

/**
 * Prompt builder output returned to the chat runtime.
 */
export type PromptBuildResult = Readonly<{
  /** Final prompt message list sent to the driver. */
  messages: readonly ChatMessage[];
  /** Token estimate for static notes content. */
  notesTokens: number;
  /** Token estimate for task-memory retrieval snippets. */
  taskMemoryTokens: number;
  /** Token estimate for active-task memory block. */
  activeTaskMemoryTokens: number;
  /** Token estimate for project-memory block. */
  projectMemoryTokens: number;
  /** Token estimate for session-memory block. */
  sessionMemoryTokens: number;
  /** Token estimate for evidence block content. */
  evidenceTokens: number;
  /** Token estimate for syntax-index block content. */
  syntaxIndexTokens: number;
  /** Token estimate for retained working-session history. */
  workingSessionTokens: number;
  /** Token estimate for the current working turn. */
  workingTurnTokens: number;
  /** Final total token estimate for the assembled prompt. */
  finalPromptTokens: number;
  /** Whether the working turn was compacted before prompt build. */
  compactedWorkingTurn: boolean;
  /** Number of raw tool messages removed from context. */
  droppedRawToolMessages: number;
  /** Raw evidence block content injected into the prompt. */
  evidenceContent: string;
  /** Number of evidence entries included in the prompt. */
  evidenceEntryCount: number;
  /** Number of syntax-index entries included in the prompt. */
  syntaxIndexEntryCount: number;
  /** Focus symbols selected for the current query. */
  focusSymbols: readonly string[];
  /** Manual planning block content for manual mode. */
  manualPlanningContent: string;
  /** Manual read batches block content for manual mode. */
  manualReadBatchesContent: string;
  /** Individual manual-read batch labels. */
  manualReadBatchItems: readonly string[];
  /** Progress summary content for the read plan. */
  readPlanProgressContent: string;
  /** Structured read-plan progress items. */
  readPlanProgressItems: readonly ReadPlanProgressItem[];
  /** Count of confirmed read-plan items. */
  confirmedReadCount: number;
  /** Optional retrieval lifecycle diagnostics. */
  retrievalLifecycleContent?: string;
  /** Optional anti-loop guardrails content. */
  antiLoopGuardrailsContent?: string;
  /** Optional workflow guard metadata for reread blocking. */
  workflowRereadGuard?: WorkflowRereadGuard;
}>;
