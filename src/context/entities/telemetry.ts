/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-04-01
 * @desc Entity definitions for telemetry events and aggregated summaries.
 */

export type PromptBuildTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for prompt build telemetry. */
  kind: 'prompt_build';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Estimated total prompt tokens for the turn. */
  promptTokensEstimate: number;
  /** Number of evidence entries included in the prompt. */
  evidenceEntryCount: number;
  /** Number of syntax-index entries included in the prompt. */
  syntaxIndexEntryCount: number;
  /** Number of read-plan items already confirmed. */
  confirmedReadCount: number;
  /** Total number of read-plan items emitted. */
  readPlanCount: number;
  /** Whether the working turn was compacted before prompting. */
  compactedWorkingTurn: boolean;
  /** Optional number of hybrid retrieval candidates scored. */
  hybridCandidateCount?: number;
  /** Optional number of semantic retrieval candidates scored. */
  semanticCandidateCount?: number;
}>;

export type WorkingTurnCompactedTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for compaction telemetry. */
  kind: 'working_turn_compacted';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Estimated prompt tokens before or after compaction. */
  promptTokensEstimate: number;
  /** Token budget assigned to the working turn. */
  workingTurnBudget: number;
  /** Actual estimated tokens of the working turn. */
  workingTurnTokens: number;
}>;

export type ToolEvidenceTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for tool-evidence telemetry. */
  kind: 'tool_evidence';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Tool name that produced the evidence. */
  toolName: string;
  /** Whether the tool execution succeeded. */
  success: boolean;
  /** Optional target path associated with the tool. */
  targetPath?: string;
  /** Optional read mode for read-oriented tools. */
  readMode?: string;
}>;

export type MultiAgentPlanTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for multi-agent planning telemetry. */
  kind: 'multi_agent_plan';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Number of subtasks planned. */
  subtaskCount: number;
  /** High-level scopes assigned to sub-agents. */
  scopes: readonly string[];
  /** Whether the plan completed successfully. */
  completed: boolean;
  /** Number of files written across the plan. */
  filesWritten: number;
}>;

export type SubAgentTurnTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for sub-agent turn telemetry. */
  kind: 'sub_agent_turn';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Scope handled by the sub-agent. */
  scope: string;
  /** Number of files written during the sub-agent turn. */
  filesWritten: number;
  /** Whether the sub-agent encountered an error. */
  hadError: boolean;
}>;

export type UserRevertTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for user revert telemetry. */
  kind: 'user_revert';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Number of files reverted by the user. */
  fileCount: number;
}>;

export type CapabilitySnapshotTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for capability snapshot telemetry. */
  kind: 'capability_snapshot';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Runtime source that emitted the snapshot. */
  source: 'chat_turn' | 'repair_turn';
  /** Agent type active for the turn. */
  agentType: string;
  /** Capability ids enabled for the turn. */
  enabledCapabilities: readonly string[];
}>;

export type ValidationSelectionTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for validation-selection telemetry. */
  kind: 'validation_selection';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Whether project, file, or no validation was selected. */
  mode: 'project' | 'file' | 'none';
  /** Validation profiles chosen for execution. */
  profiles: readonly string[];
  /** Number of commands selected for validation. */
  commandCount: number;
  /** Whether file safety-net validation was used. */
  usedFileSafetyNet: boolean;
}>;

export type BlockedToolTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for blocked-tool telemetry. */
  kind: 'blocked_tool';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Tool name that was blocked. */
  toolName: string;
  /** Capability gate that blocked the tool. */
  capability: string;
}>;

export type WorkflowRetrievalTelemetryEvent = Readonly<{
  /** Stable event identifier. */
  id: string;
  /** Discriminator for workflow-retrieval telemetry. */
  kind: 'workflow_retrieval';
  /** Timestamp when the event was captured. */
  capturedAt: number;
  /** Whether the current user query was classified as a flow query. */
  flowQuery: boolean;
  /** Whether workflow retrieval returned any usable graph or artifact hits. */
  hadHits: boolean;
  /** Total number of workflow entries considered relevant. */
  entryCount: number;
  /** Number of candidate file paths derived from workflow retrieval. */
  candidatePathCount: number;
  /** Whether workflow reread guardrails were enabled for the turn. */
  rereadGuardEnabled: boolean;
}>;

export type TelemetryEvent =
  | PromptBuildTelemetryEvent
  | WorkingTurnCompactedTelemetryEvent
  | ToolEvidenceTelemetryEvent
  | MultiAgentPlanTelemetryEvent
  | SubAgentTurnTelemetryEvent
  | UserRevertTelemetryEvent
  | CapabilitySnapshotTelemetryEvent
  | ValidationSelectionTelemetryEvent
  | BlockedToolTelemetryEvent
  | WorkflowRetrievalTelemetryEvent;

export type TelemetryEventInput =
  | Omit<PromptBuildTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<WorkingTurnCompactedTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<ToolEvidenceTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<MultiAgentPlanTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<SubAgentTurnTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<UserRevertTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<CapabilitySnapshotTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<ValidationSelectionTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<BlockedToolTelemetryEvent, 'id' | 'capturedAt'>
  | Omit<WorkflowRetrievalTelemetryEvent, 'id' | 'capturedAt'>;

export type TelemetrySummary = Readonly<{
  /** Total number of telemetry events recorded. */
  totalEvents: number;
  /** Number of prompt-build events recorded. */
  promptBuilds: number;
  /** Average prompt token estimate across prompt builds. */
  avgPromptTokensEstimate: number;
  /** Maximum prompt token estimate observed. */
  maxPromptTokensEstimate: number;
  /** Number of turns compacted before prompting. */
  compactedTurns: number;
  /** Number of tool-evidence events captured. */
  readEvidenceEvents: number;
  /** Number of full-file read events observed. */
  fullFileReads: number;
  /** Number of repeated reads of the same file. */
  rereads: number;
  /** Number of grep events captured. */
  grepEvents: number;
  /** Number of multi-agent plans generated. */
  multiAgentPlans: number;
  /** Number of successful multi-agent plans. */
  multiAgentSuccesses: number;
  /** Number of sub-agent turns executed. */
  subAgentTurns: number;
  /** Number of user revert events observed. */
  userReverts: number;
  /** Number of capability snapshot events recorded. */
  capabilitySnapshots: number;
  /** Number of validation selection events recorded. */
  validationSelections: number;
  /** Number of blocked tool-call events recorded. */
  blockedToolCalls: number;
  /** Number of workflow-oriented queries observed. */
  workflowQueries: number;
  /** Number of workflow queries that returned at least one hit. */
  workflowHits: number;
  /** Number of turns where workflow reread guardrails were enabled. */
  workflowGuardActivations: number;
  /** Timestamp when the summary was last recomputed. */
  lastUpdatedAt: number;
  /** Per-path read counts used to spot reread hotspots. */
  readCountsByPath: Readonly<Record<string, number>>;
}>;
