import type { ChatMessage } from '../shared/protocol';

export type ToolDigest = Readonly<{
  name: string;
  success: boolean;
  summary: string;
  filesRead: readonly string[];
  filesWritten: readonly string[];
  filesReverted: readonly string[];
}>;

export type WorkingTurn = Readonly<{
  turnId: string;
  userMessage: ChatMessage;
  contextNote?: string;
  assistantDraft: string;
  contextMessages: readonly ChatMessage[];
  toolDigests: readonly ToolDigest[];
  roundCount: number;
  tokenEstimate: number;
  startedAt: number;
  compacted: boolean;
  compactSummary?: string;
  droppedContextMessages: number;
}>;

export type TurnDigest = Readonly<{
  turnId: string;
  userMessage: string;
  assistantSummary: string;
  toolDigests: readonly ToolDigest[];
  keyDecisions: readonly string[];
  pendingItems: readonly string[];
  filesTouched: readonly string[];
  tokenEstimate: number;
  createdAt: number;
}>;

export type ActiveTaskMemory = Readonly<{
  taskId: string | null;
  originalUserGoal: string;
  currentObjective: string;
  definitionOfDone: readonly string[];
  completedSteps: readonly string[];
  pendingSteps: readonly string[];
  blockers: readonly string[];
  filesTouched: readonly string[];
  keyFiles: readonly string[];
  attachments: readonly string[];
  deniedCommands: readonly string[];
  recentTurnSummaries: readonly string[];
  handoffSummary: string;
  lastUpdatedAt: number;
}>;

export type ProjectMemory = Readonly<{
  summary: string;
  conventions: readonly string[];
  recurringPitfalls: readonly string[];
  recentDecisions: readonly string[];
  keyFiles: readonly string[];
  lastUpdatedAt: number;
}>;

export type SessionMemory = Readonly<{
  workspaceId: string;
  workspacePath: string;
  activeTaskMemory: ActiveTaskMemory;
  projectMemory: ProjectMemory;
  lastFinalAssistantConclusion: string;
  keyFiles: readonly string[];
  lastUpdatedAt: number;
}>;

export type ReadPlanProgressItem = Readonly<{
  label: string;
  confirmed: boolean;
  status?: 'confirmed' | 'needs_refresh' | 'pending';
  evidenceSummary?: string;
  targetPath: string;
  symbolName?: string;
  tool: 'read_file' | 'grep';
}>;

export type PromptBuildResult = Readonly<{
  messages: readonly ChatMessage[];
  notesTokens: number;
  activeTaskMemoryTokens: number;
  projectMemoryTokens: number;
  sessionMemoryTokens: number;
  evidenceTokens: number;
  syntaxIndexTokens: number;
  workingSessionTokens: number;
  workingTurnTokens: number;
  finalPromptTokens: number;
  compactedWorkingTurn: boolean;
  droppedRawToolMessages: number;
  evidenceContent: string;
  evidenceEntryCount: number;
  syntaxIndexEntryCount: number;
  focusSymbols: readonly string[];
  manualPlanningContent: string;
  manualReadBatchesContent: string;
  manualReadBatchItems: readonly string[];
  readPlanProgressContent: string;
  readPlanProgressItems: readonly ReadPlanProgressItem[];
  confirmedReadCount: number;
  retrievalLifecycleContent?: string;
  antiLoopGuardrailsContent?: string;
}>;
