/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Prompt context orchestration entrypoint for the VS Code extension runtime.
 */

import type { AgentType, ChatMessage } from "../shared/protocol";
import {
  mapPathsToProjectScope,
  resolveEffectiveProjectPath,
} from "./active-project";
import { countContextTokens, estimateTokens } from "./compaction";
import type {
  PromptBuildResult,
  SessionMemory,
  WorkingTurn,
} from "./entities/history";
import {
  buildActiveTaskMemoryContent,
  buildProjectMemoryContent,
} from "./memory-format";
import {
  buildRetrievalStrategyBlock,
  hasRetrievalPromptBlock,
  hasRetrievalStage,
  resolveRetrievalStopReason,
} from "./retrieval-core";
import {
  buildOpenFindingsContent,
  buildCodeMapCandidatesContent,
  buildManualPlanningContent,
  buildManualReadBatchesBlock,
  narrowManualPlanningScope,
  shouldEmitManualPlanningHints,
  buildSymbolMapCandidatesContent,
  buildSystemPlatformContent,
  buildTaskMemoryContent,
  filterPendingReadPlan,
  prioritizeRefreshReadPlan,
} from "./prompt/context-blocks";
import {
  buildWorkflowRetrievalBlock,
  extractMentionedPaths,
  selectProjectHintPaths,
  shouldEnableWorkflowRereadGuard,
  takeRecentPaths,
  uniquePaths,
} from "./prompt/retrieval-helpers";
import { buildHybridRetrievalBlocks } from "./prompt/hybrid-retrieval";
import { queryRelevantTaskMemory } from "./rag-metadata/task-memory";
import { queryRagHintPaths } from "./rag-metadata/metadata-sync";
import { buildSemanticRetrievalContext } from "./semantic/retrieval";
import { buildSyntaxIndexContext } from "./syntax/context";
import { createEmptySyntaxContext } from "./syntax/helpers";
import { appendTelemetryEvent } from "./telemetry";
import { buildRelevantToolEvidenceBlock } from "./tool-evidence-selector";

/**
 * Creates a user-role context message only when the provided content is non-empty.
 *
 * @param content Raw block content that may become a context message.
 * @param id Stable message id generated for the context block.
 * @returns A frozen chat message or `null` when the block is empty.
 */
function buildContextMessage(content: string, id: string): ChatMessage | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  return Object.freeze({
    id,
    role: "user",
    content: trimmed,
    timestamp: Date.now(),
  });
}

function collectContextMessages<T>(
  messages: readonly (T | null | undefined)[],
): readonly T[] {
  return Object.freeze(
    messages.filter(
      (message): message is T => message !== null && message !== undefined,
    ),
  );
}

function createEmptySemanticRetrievalBlock() {
  return Object.freeze({
    content: "",
    chunkContent: "",
    tokens: 0,
    entryCount: 0,
    candidatePaths: Object.freeze([]),
  });
}

function createEmptyHybridRetrievalBlock() {
  return Object.freeze({
    content: "",
    skeletonContent: "",
    candidatePaths: Object.freeze([]),
  });
}

function createEmptyToolEvidenceBlock() {
  return Object.freeze({
    content: "",
    tokens: 0,
    entryCount: 0,
    readPlanProgress: Object.freeze([]),
    readPlanProgressContent: "",
    confirmedReadPaths: Object.freeze([]),
    confirmedSymbols: Object.freeze([]),
    refreshReadPaths: Object.freeze([]),
    refreshSymbols: Object.freeze([]),
    confirmedReadCount: 0,
    retrievalLifecycleContent: "",
    antiLoopGuardrailsContent: "",
    evidenceReuseContent: "",
  });
}

function createEmptyManualPlanningScope() {
  return Object.freeze({
    primaryPaths: Object.freeze([]),
    definitionPaths: Object.freeze([]),
    referencePaths: Object.freeze([]),
    primaryCandidates: Object.freeze([]),
    definitionCandidates: Object.freeze([]),
    referenceCandidates: Object.freeze([]),
    manualReadPlan: Object.freeze([]),
  });
}

/**
 * Builds the complete prompt context bundle used by the runtime before model execution.
 *
 * @param opts Prompt build inputs, including agent mode, session memory, and the current working turn.
 * @returns Prompt messages, token estimates, workflow reread guard metadata, and retrieval telemetry.
 */
export async function buildPromptContext(opts: {
  agentType: AgentType;
  notes: string;
  sessionMemory: SessionMemory;
  workingTurn: WorkingTurn | null;
}): Promise<PromptBuildResult> {
  const messages: ChatMessage[] = [];
  const rootWorkspacePath = opts.sessionMemory.workspacePath;
  const workingTurnFiles =
    opts.workingTurn?.toolDigests.flatMap((digest) => [
      ...digest.filesRead,
      ...digest.filesWritten,
      ...digest.filesReverted,
    ]) ?? [];
  const rawMentionedPaths = extractMentionedPaths(
    opts.workingTurn?.userMessage.content ?? "",
  );
  const queryText = opts.workingTurn?.userMessage.content ?? "";
  const retrievalStrategy = buildRetrievalStrategyBlock(queryText);
  const includeRetrievalBlock = (
    blockId: (typeof retrievalStrategy.promptBlocks)[number],
  ): boolean =>
    hasRetrievalPromptBlock(retrievalStrategy.promptBlocks, blockId);
  const includeTaskMemory = includeRetrievalBlock("task_memory");
  const includeWorkflowRetrieval = includeRetrievalBlock(
    "workflow_graph_retrieval",
  );
  const includeMatchedNodes = includeRetrievalBlock("matched_nodes");
  const includeGraphPath = includeRetrievalBlock("graph_path");
  const includeWorkflowSummaries = includeRetrievalBlock("workflow_summaries");
  const includeTraceNarratives = includeRetrievalBlock("trace_narratives");
  const includeOpenFindings = includeRetrievalBlock("open_findings");
  const includeHybridRetrieval = includeRetrievalBlock("hybrid_retrieval");
  const includeSkeletonRetrieval = includeRetrievalBlock("skeleton_retrieval");
  const includeSyntaxIndex = includeRetrievalBlock("syntax_index");
  const includeSemanticRetrieval = includeRetrievalBlock("semantic_retrieval");
  const includeSemanticChunks = includeRetrievalBlock("semantic_chunks");
  const includeToolEvidence = includeRetrievalBlock("tool_evidence");
  const includePreviousFinalConclusion = includeRetrievalBlock(
    "previous_final_conclusion",
  );
  const hasSemanticSupportStage = hasRetrievalStage(
    retrievalStrategy.stagePlan.stageOrder,
    "semantic_support",
  );
  const hasToolEvidenceStage =
    hasRetrievalStage(
      retrievalStrategy.stagePlan.stageOrder,
      "tool_evidence_freshness",
    ) ||
    hasRetrievalStage(
      retrievalStrategy.stagePlan.stageOrder,
      "session_and_evidence",
    );
  const hasTargetedRereadStage = hasRetrievalStage(
    retrievalStrategy.stagePlan.stageOrder,
    "targeted_reread",
  );
  const shouldPrepareTargetedRereadPlan =
    opts.agentType === "manual" &&
    retrievalStrategy.classification.requiresExactEvidence &&
    hasTargetedRereadStage;
  const includeManualReadBatches =
    includeRetrievalBlock("manual_read_batches") ||
    shouldPrepareTargetedRereadPlan;
  const includeReadPlanProgress =
    includeRetrievalBlock("read_plan_progress") ||
    shouldPrepareTargetedRereadPlan;
  const includeSyntaxCandidateMaps =
    includeSyntaxIndex || includeHybridRetrieval;
  const includeManualPlanning =
    includeManualReadBatches || includeReadPlanProgress;
  const needsHybridRetrieval =
    includeHybridRetrieval || includeSkeletonRetrieval;
  const retrievalWorkspacePath = resolveEffectiveProjectPath({
    workspacePath: rootWorkspacePath,
    activeProjectPath: opts.sessionMemory.activeProjectPath,
    candidateFilePaths: uniquePaths([
      ...workingTurnFiles,
      ...rawMentionedPaths,
    ]),
  });
  const mentionedPaths = mapPathsToProjectScope(
    rootWorkspacePath,
    retrievalWorkspacePath,
    rawMentionedPaths,
  );
  const scopedWorkingTurnFiles = mapPathsToProjectScope(
    rootWorkspacePath,
    retrievalWorkspacePath,
    workingTurnFiles,
  );
  const activeTaskRetrievalPaths = mapPathsToProjectScope(
    rootWorkspacePath,
    retrievalWorkspacePath,
    uniquePaths([
      ...opts.sessionMemory.activeTaskMemory.filesTouched,
      ...opts.sessionMemory.activeTaskMemory.keyFiles,
    ]),
  );
  const projectHintPaths = selectProjectHintPaths(
    queryText,
    opts.sessionMemory.projectMemory.keyFiles,
  );
  const scopedProjectHintPaths = mapPathsToProjectScope(
    rootWorkspacePath,
    retrievalWorkspacePath,
    projectHintPaths,
  );
  const sqliteHintPaths = queryRagHintPaths(
    retrievalWorkspacePath,
    queryText,
    4,
  );
  const workflowRetrievalBlock = await buildWorkflowRetrievalBlock({
    workspacePath: retrievalWorkspacePath,
    queryText,
    workingTurnFiles: scopedWorkingTurnFiles,
    mentionedPaths,
  });
  const retrievalSeedPaths = uniquePaths([
    ...mentionedPaths,
    ...scopedWorkingTurnFiles,
    ...takeRecentPaths(activeTaskRetrievalPaths, 6),
    ...scopedProjectHintPaths,
    ...sqliteHintPaths,
    ...workflowRetrievalBlock.candidatePaths,
  ]);
  const retrievalKeyFiles = uniquePaths([
    ...takeRecentPaths(activeTaskRetrievalPaths, 6),
    ...scopedProjectHintPaths,
    ...sqliteHintPaths,
    ...workflowRetrievalBlock.candidatePaths,
  ]);
  const retrievalRecentPaths = mapPathsToProjectScope(
    rootWorkspacePath,
    retrievalWorkspacePath,
    uniquePaths([
      ...takeRecentPaths(opts.sessionMemory.activeTaskMemory.filesTouched, 8),
      ...takeRecentPaths(opts.sessionMemory.projectMemory.keyFiles, 4),
    ]),
  );
  const workflowRereadGuard = Object.freeze({
    enabled: shouldEnableWorkflowRereadGuard(
      queryText,
      workflowRetrievalBlock.entryCount,
      workflowRetrievalBlock.candidatePaths,
    ),
    candidatePaths: workflowRetrievalBlock.candidatePaths,
    entryCount: workflowRetrievalBlock.entryCount,
    queryText,
  });
  const manualPlanningScopePaths = uniquePaths(
    [...mentionedPaths, ...takeRecentPaths(scopedWorkingTurnFiles, 4)],
    4,
  );

  const notesContent = opts.notes.trim() ? `[NOTES]\n${opts.notes.trim()}` : "";
  const systemPlatformContent = buildSystemPlatformContent();
  const taskMemory = await queryRelevantTaskMemory(
    retrievalWorkspacePath,
    queryText,
    3,
  );
  const taskMemoryContent = buildTaskMemoryContent({
    entries: taskMemory.entries,
  });
  const openFindingsContent = buildOpenFindingsContent({
    findings: taskMemory.findings,
    pendingSteps: opts.sessionMemory.activeTaskMemory.pendingSteps,
    blockers: opts.sessionMemory.activeTaskMemory.blockers,
  });
  const projectMemoryContent = buildProjectMemoryContent(
    opts.sessionMemory.projectMemory,
  );
  const activeTaskMemoryContent = buildActiveTaskMemoryContent(
    opts.sessionMemory.activeTaskMemory,
  );
  const previousFinalConclusionContent =
    opts.sessionMemory.lastFinalAssistantConclusion.trim()
      ? `[PREVIOUS FINAL ASSISTANT CONCLUSION]\n` +
        `${opts.sessionMemory.lastFinalAssistantConclusion.trim()}\n\n` +
        "Treat this as the most recent authoritative conclusion from the previous completed turn. Prefer continuing from it instead of restarting the analysis from scratch. If you need to reopen the analysis, explain what current evidence contradicts it or what new information is missing."
      : "";
  const hasContinuityEntryContext =
    retrievalStrategy.classification.primaryIntent === "task_continuity" &&
    (taskMemory.entries.length > 0 ||
      opts.sessionMemory.activeTaskMemory.currentObjective.trim().length > 0 ||
      opts.sessionMemory.activeTaskMemory.recentTurnSummaries.length > 0 ||
      opts.sessionMemory.activeTaskMemory.handoffSummary.trim().length > 0 ||
      opts.sessionMemory.lastFinalAssistantConclusion.trim().length > 0);
  const shouldRunContinuitySemanticSupport =
    hasContinuityEntryContext &&
    hasSemanticSupportStage &&
    activeTaskRetrievalPaths.length === 0;
  const needsSemanticRetrieval =
    hasSemanticSupportStage &&
    (includeSemanticRetrieval ||
      includeSemanticChunks ||
      includeHybridRetrieval ||
      includeSkeletonRetrieval ||
      shouldRunContinuitySemanticSupport);
  const needsToolEvidenceContext =
    hasToolEvidenceStage &&
    (includeToolEvidence || includeReadPlanProgress || includeManualPlanning);
  const needsSyntaxContext =
    includeSyntaxCandidateMaps ||
    needsSemanticRetrieval ||
    needsToolEvidenceContext;
  const syntaxIndexBlock = needsSyntaxContext
    ? await buildSyntaxIndexContext({
        workspacePath: retrievalWorkspacePath,
        candidateFiles: retrievalSeedPaths,
        queryText,
      })
    : createEmptySyntaxContext();
  const semanticRetrievalBlock = needsSemanticRetrieval
    ? await buildSemanticRetrievalContext({
        workspacePath: retrievalWorkspacePath,
        queryText,
        candidateFiles: [
          ...retrievalSeedPaths,
          ...syntaxIndexBlock.priorityPaths,
        ],
        records: syntaxIndexBlock.records,
        primaryPaths: syntaxIndexBlock.primaryPaths,
        definitionPaths: syntaxIndexBlock.definitionPaths,
        referencePaths: syntaxIndexBlock.referencePaths,
        workflowPathScores: workflowRetrievalBlock.pathScores,
      })
    : createEmptySemanticRetrievalBlock();
  const initialHybridRetrievalBlock = needsHybridRetrieval
    ? buildHybridRetrievalBlocks({
        queryText,
        records: syntaxIndexBlock.records,
        mentionedPaths,
        workingTurnFiles: scopedWorkingTurnFiles,
        keyFiles: retrievalKeyFiles,
        recentPaths: retrievalRecentPaths,
        primaryPaths: syntaxIndexBlock.primaryPaths,
        definitionPaths: syntaxIndexBlock.definitionPaths,
        referencePaths: syntaxIndexBlock.referencePaths,
        focusSymbols: syntaxIndexBlock.focusSymbols,
        semanticPaths: semanticRetrievalBlock.candidatePaths,
        workflowPathScores: workflowRetrievalBlock.pathScores,
      })
    : createEmptyHybridRetrievalBlock();
  const codeMapCandidatesContent = includeSyntaxCandidateMaps
    ? buildCodeMapCandidatesContent({
        primaryPaths: syntaxIndexBlock.primaryPaths,
        definitionPaths: syntaxIndexBlock.definitionPaths,
        referencePaths: syntaxIndexBlock.referencePaths,
      })
    : "";
  const symbolMapCandidatesContent = includeSyntaxCandidateMaps
    ? buildSymbolMapCandidatesContent({
        focusSymbols: syntaxIndexBlock.focusSymbols,
        primaryCandidates: syntaxIndexBlock.primarySymbolCandidates,
        definitionCandidates: syntaxIndexBlock.definitionSymbolCandidates,
        referenceCandidates: syntaxIndexBlock.referenceSymbolCandidates,
      })
    : "";
  const scopedManualPlanning = includeManualPlanning
    ? narrowManualPlanningScope({
        scopedPaths:
          manualPlanningScopePaths.length > 0 &&
          !workflowRetrievalBlock.flowQuery
            ? manualPlanningScopePaths
            : Object.freeze([]),
        primaryPaths: syntaxIndexBlock.primaryPaths,
        definitionPaths: syntaxIndexBlock.definitionPaths,
        referencePaths: syntaxIndexBlock.referencePaths,
        primaryCandidates: syntaxIndexBlock.primarySymbolCandidates,
        definitionCandidates: syntaxIndexBlock.definitionSymbolCandidates,
        referenceCandidates: syntaxIndexBlock.referenceSymbolCandidates,
        manualReadPlan: syntaxIndexBlock.manualReadPlan,
      })
    : createEmptyManualPlanningScope();
  const evidenceBlock = needsToolEvidenceContext
    ? buildRelevantToolEvidenceBlock({
        sessionMemory: opts.sessionMemory,
        workingTurn: opts.workingTurn,
        preferredPaths:
          initialHybridRetrievalBlock.candidatePaths.length > 0
            ? initialHybridRetrievalBlock.candidatePaths
            : syntaxIndexBlock.priorityPaths,
        definitionPaths: syntaxIndexBlock.definitionPaths,
        referencePaths: syntaxIndexBlock.referencePaths,
        focusSymbols: syntaxIndexBlock.focusSymbols,
        readPlan: syntaxIndexBlock.manualReadPlan,
      })
    : createEmptyToolEvidenceBlock();
  const feedbackHybridRetrievalBlock =
    needsHybridRetrieval && needsToolEvidenceContext
      ? buildHybridRetrievalBlocks({
          queryText,
          records: syntaxIndexBlock.records,
          mentionedPaths,
          workingTurnFiles: scopedWorkingTurnFiles,
          keyFiles: retrievalKeyFiles,
          recentPaths: retrievalRecentPaths,
          primaryPaths: syntaxIndexBlock.primaryPaths,
          definitionPaths: syntaxIndexBlock.definitionPaths,
          referencePaths: syntaxIndexBlock.referencePaths,
          focusSymbols: syntaxIndexBlock.focusSymbols,
          semanticPaths: semanticRetrievalBlock.candidatePaths,
          workflowPathScores: workflowRetrievalBlock.pathScores,
          deprioritizedPaths: evidenceBlock.confirmedReadPaths,
          deprioritizedSymbols: evidenceBlock.confirmedSymbols,
        })
      : createEmptyHybridRetrievalBlock();
  const hybridRetrievalBlock =
    feedbackHybridRetrievalBlock.candidatePaths.length > 0
      ? feedbackHybridRetrievalBlock
      : initialHybridRetrievalBlock;
  const contextNoteContent = opts.workingTurn?.contextNote?.trim() ?? "";
  const compactSummaryContent = opts.workingTurn?.compactSummary?.trim() ?? "";
  const retrievalStopReason = resolveRetrievalStopReason({
    intentKind: retrievalStrategy.classification.primaryIntent,
    exactEvidenceRequired:
      retrievalStrategy.classification.requiresExactEvidence,
    taskMemoryEntryCount: taskMemory.entries.length,
    openFindingCount:
      taskMemory.findings.length +
      opts.sessionMemory.activeTaskMemory.pendingSteps.length +
      opts.sessionMemory.activeTaskMemory.blockers.length,
    sessionContextCount:
      (opts.sessionMemory.activeTaskMemory.currentObjective.trim().length > 0
        ? 1
        : 0) +
      (opts.sessionMemory.activeTaskMemory.recentTurnSummaries.length > 0
        ? 1
        : 0) +
      (opts.sessionMemory.activeTaskMemory.handoffSummary.trim().length > 0
        ? 1
        : 0) +
      (opts.sessionMemory.lastFinalAssistantConclusion.trim().length > 0
        ? 1
        : 0),
    workflowEntryCount: workflowRetrievalBlock.entryCount,
    workflowCandidatePathCount: workflowRetrievalBlock.candidatePaths.length,
    primaryPathCount: syntaxIndexBlock.primaryPaths.length,
    exactAnchorCount:
      syntaxIndexBlock.focusSymbols.length +
      syntaxIndexBlock.primarySymbolCandidates.length +
      syntaxIndexBlock.definitionSymbolCandidates.length +
      syntaxIndexBlock.referenceSymbolCandidates.length,
    semanticEntryCount: semanticRetrievalBlock.entryCount,
    candidatePathCount: uniquePaths([
      ...workflowRetrievalBlock.candidatePaths,
      ...syntaxIndexBlock.primaryPaths,
      ...semanticRetrievalBlock.candidatePaths,
      ...hybridRetrievalBlock.candidatePaths,
      ...evidenceBlock.confirmedReadPaths,
    ]).length,
    confirmedReadCount: evidenceBlock.confirmedReadCount,
    refreshReadCount: evidenceBlock.refreshReadPaths.length,
    hasMemoryConflict:
      retrievalStrategy.classification.primaryIntent === "task_continuity" &&
      opts.sessionMemory.lastFinalAssistantConclusion.trim().length > 0 &&
      evidenceBlock.refreshReadPaths.length > 0 &&
      evidenceBlock.confirmedReadCount === 0 &&
      workflowRetrievalBlock.entryCount === 0,
  });
  const shouldSurfaceManualRereadPlan =
    !hasTargetedRereadStage || retrievalStopReason === "needs_targeted_reread";
  const shouldSurfaceTargetedRereadPlan =
    shouldPrepareTargetedRereadPlan && shouldSurfaceManualRereadPlan;
  const pendingReadPlan =
    opts.agentType === "manual" &&
    includeManualPlanning &&
    shouldSurfaceManualRereadPlan
      ? prioritizeRefreshReadPlan(
          filterPendingReadPlan(
            scopedManualPlanning.manualReadPlan,
            evidenceBlock.readPlanProgress,
          ),
          evidenceBlock.readPlanProgress,
        )
      : Object.freeze([]);
  const emitManualPlanningHints =
    opts.agentType === "manual" &&
    includeManualPlanning &&
    shouldSurfaceManualRereadPlan &&
    shouldEmitManualPlanningHints({
      confirmedReadCount: evidenceBlock.confirmedReadCount,
      pendingReadPlanCount: pendingReadPlan.length,
      refreshReadPathCount: evidenceBlock.refreshReadPaths.length,
      workingTurnFileCount: workingTurnFiles.length,
    });
  const manualPlanningContent =
    opts.agentType === "manual" && emitManualPlanningHints
      ? buildManualPlanningContent({
          focusSymbols: syntaxIndexBlock.focusSymbols,
          primaryPaths: scopedManualPlanning.primaryPaths,
          definitionPaths: scopedManualPlanning.definitionPaths,
          referencePaths: scopedManualPlanning.referencePaths,
          primaryCandidates: scopedManualPlanning.primaryCandidates,
          definitionCandidates: scopedManualPlanning.definitionCandidates,
        })
      : "";
  const manualReadBatchesBlock =
    opts.agentType === "manual" &&
    includeManualReadBatches &&
    emitManualPlanningHints
      ? buildManualReadBatchesBlock({
          readPlan: pendingReadPlan,
        })
      : Object.freeze({
          content: "",
          items: Object.freeze([]),
        });
  const workingPromptTokens = opts.workingTurn
    ? countContextTokens([
        opts.workingTurn.userMessage,
        ...opts.workingTurn.contextMessages,
      ]) +
      estimateTokens(contextNoteContent) +
      estimateTokens(compactSummaryContent)
    : 0;

  const notesMessage = buildContextMessage(
    notesContent,
    `ctx-notes-${Date.now()}`,
  );
  if (notesMessage) {
    messages.push(notesMessage);
  }

  const systemPlatformMessage = buildContextMessage(
    systemPlatformContent,
    `ctx-platform-${Date.now()}`,
  );
  if (systemPlatformMessage) {
    messages.push(systemPlatformMessage);
  }

  const taskMemoryMessage = buildContextMessage(
    taskMemoryContent,
    `ctx-task-memory-${Date.now()}`,
  );

  const projectMemoryMessage = buildContextMessage(
    projectMemoryContent,
    `ctx-project-memory-${Date.now()}`,
  );
  if (projectMemoryMessage) {
    messages.push(projectMemoryMessage);
  }

  const activeTaskMessage = buildContextMessage(
    activeTaskMemoryContent,
    `ctx-active-task-${Date.now()}`,
  );
  if (activeTaskMessage) {
    messages.push(activeTaskMessage);
  }

  const previousFinalConclusionMessage = buildContextMessage(
    previousFinalConclusionContent,
    `ctx-previous-final-conclusion-${Date.now()}`,
  );

  const retrievalStrategyMessage = buildContextMessage(
    retrievalStrategy.content,
    `ctx-retrieval-strategy-${Date.now()}`,
  );
  if (retrievalStrategyMessage) {
    messages.push(retrievalStrategyMessage);
  }

  const openFindingsMessage = buildContextMessage(
    openFindingsContent,
    `ctx-open-findings-${Date.now()}`,
  );

  const workflowOverviewMessage = buildContextMessage(
    workflowRetrievalBlock.overviewContent,
    `ctx-workflow-retrieval-${Date.now()}`,
  );
  const matchedNodesMessage = buildContextMessage(
    workflowRetrievalBlock.matchedNodesContent,
    `ctx-workflow-matched-nodes-${Date.now()}`,
  );
  const graphPathMessage = buildContextMessage(
    workflowRetrievalBlock.graphPathContent,
    `ctx-workflow-graph-path-${Date.now()}`,
  );
  const workflowSummariesMessage = buildContextMessage(
    workflowRetrievalBlock.workflowSummariesContent,
    `ctx-workflow-summaries-${Date.now()}`,
  );
  const traceNarrativesMessage = buildContextMessage(
    workflowRetrievalBlock.traceNarrativesContent,
    `ctx-workflow-trace-narratives-${Date.now()}`,
  );

  const codeMapCandidatesMessage = buildContextMessage(
    codeMapCandidatesContent,
    `ctx-code-map-${Date.now()}`,
  );

  const hybridRetrievalMessage = buildContextMessage(
    hybridRetrievalBlock.content,
    `ctx-hybrid-retrieval-${Date.now()}`,
  );

  const semanticRetrievalMessage = buildContextMessage(
    semanticRetrievalBlock.content,
    `ctx-semantic-retrieval-${Date.now()}`,
  );

  const semanticChunkMessage = buildContextMessage(
    semanticRetrievalBlock.chunkContent,
    `ctx-semantic-chunks-${Date.now()}`,
  );

  const skeletonRetrievalMessage = buildContextMessage(
    hybridRetrievalBlock.skeletonContent,
    `ctx-skeleton-retrieval-${Date.now()}`,
  );

  const symbolMapCandidatesMessage = buildContextMessage(
    symbolMapCandidatesContent,
    `ctx-symbol-map-${Date.now()}`,
  );

  const manualPlanningMessage = buildContextMessage(
    manualPlanningContent,
    `ctx-manual-plan-${Date.now()}`,
  );

  const manualReadBatchesMessage = buildContextMessage(
    manualReadBatchesBlock.content,
    `ctx-manual-batches-${Date.now()}`,
  );

  const readPlanProgressMessage = buildContextMessage(
    evidenceBlock.readPlanProgressContent,
    `ctx-read-plan-progress-${Date.now()}`,
  );

  const retrievalLifecycleMessage = buildContextMessage(
    evidenceBlock.retrievalLifecycleContent,
    `ctx-retrieval-lifecycle-${Date.now()}`,
  );

  const antiLoopGuardrailsMessage = buildContextMessage(
    evidenceBlock.antiLoopGuardrailsContent,
    `ctx-anti-loop-${Date.now()}`,
  );

  const evidenceReuseMessage = buildContextMessage(
    evidenceBlock.evidenceReuseContent,
    `ctx-evidence-reuse-${Date.now()}`,
  );

  const syntaxIndexMessage = buildContextMessage(
    syntaxIndexBlock.content,
    `ctx-syntax-index-${Date.now()}`,
  );

  const evidenceMessage = buildContextMessage(
    evidenceBlock.content,
    `ctx-evidence-${Date.now()}`,
  );

  const retrievalMessagesByBlock = new Map<
    (typeof retrievalStrategy.promptBlocks)[number],
    readonly ChatMessage[]
  >([
    [
      "task_memory",
      includeTaskMemory
        ? collectContextMessages([taskMemoryMessage])
        : Object.freeze([]),
    ],
    [
      "open_findings",
      includeOpenFindings
        ? collectContextMessages([openFindingsMessage])
        : Object.freeze([]),
    ],
    [
      "workflow_graph_retrieval",
      includeWorkflowRetrieval
        ? collectContextMessages([workflowOverviewMessage])
        : Object.freeze([]),
    ],
    [
      "matched_nodes",
      includeMatchedNodes
        ? collectContextMessages([matchedNodesMessage])
        : Object.freeze([]),
    ],
    [
      "graph_path",
      includeGraphPath
        ? collectContextMessages([graphPathMessage])
        : Object.freeze([]),
    ],
    [
      "workflow_summaries",
      includeWorkflowSummaries
        ? collectContextMessages([workflowSummariesMessage])
        : Object.freeze([]),
    ],
    [
      "trace_narratives",
      includeTraceNarratives
        ? collectContextMessages([traceNarrativesMessage])
        : Object.freeze([]),
    ],
    [
      "hybrid_retrieval",
      includeHybridRetrieval
        ? collectContextMessages([hybridRetrievalMessage])
        : Object.freeze([]),
    ],
    [
      "skeleton_retrieval",
      includeSkeletonRetrieval
        ? collectContextMessages([skeletonRetrievalMessage])
        : Object.freeze([]),
    ],
    [
      "syntax_index",
      includeSyntaxIndex
        ? collectContextMessages([
            includeSyntaxCandidateMaps ? codeMapCandidatesMessage : null,
            includeSyntaxCandidateMaps ? symbolMapCandidatesMessage : null,
            syntaxIndexMessage,
          ])
        : Object.freeze([]),
    ],
    [
      "tool_evidence",
      includeToolEvidence
        ? collectContextMessages([
            retrievalLifecycleMessage,
            antiLoopGuardrailsMessage,
            evidenceReuseMessage,
            evidenceMessage,
          ])
        : Object.freeze([]),
    ],
    [
      "semantic_retrieval",
      includeSemanticRetrieval
        ? collectContextMessages([semanticRetrievalMessage])
        : Object.freeze([]),
    ],
    [
      "semantic_chunks",
      includeSemanticChunks
        ? collectContextMessages([semanticChunkMessage])
        : Object.freeze([]),
    ],
    [
      "manual_read_batches",
      includeManualReadBatches
        ? collectContextMessages([
            includeManualPlanning ? manualPlanningMessage : null,
            manualReadBatchesMessage,
          ])
        : Object.freeze([]),
    ],
    [
      "read_plan_progress",
      includeReadPlanProgress
        ? collectContextMessages([readPlanProgressMessage])
        : Object.freeze([]),
    ],
    [
      "previous_final_conclusion",
      includePreviousFinalConclusion
        ? collectContextMessages([previousFinalConclusionMessage])
        : Object.freeze([]),
    ],
  ]);

  const effectiveRetrievalPromptBlocks: readonly (typeof retrievalStrategy.promptBlocks)[number][] =
    Object.freeze([
      ...retrievalStrategy.promptBlocks.filter(
        (blockId) =>
          !(
            hasTargetedRereadStage &&
            (blockId === "manual_read_batches" ||
              blockId === "read_plan_progress")
          ),
      ),
      ...(shouldSurfaceTargetedRereadPlan && manualReadBatchesMessage
        ? (["manual_read_batches"] as const)
        : []),
      ...(shouldSurfaceTargetedRereadPlan && readPlanProgressMessage
        ? (["read_plan_progress"] as const)
        : []),
    ]);

  for (const blockId of effectiveRetrievalPromptBlocks) {
    messages.push(...(retrievalMessagesByBlock.get(blockId) ?? []));
  }

  const contextNoteMessage = buildContextMessage(
    contextNoteContent,
    `ctx-working-${Date.now()}`,
  );
  if (contextNoteMessage) {
    messages.push(contextNoteMessage);
  }

  const summaryMessage = buildContextMessage(
    compactSummaryContent,
    `ctx-working-summary-${Date.now()}`,
  );
  if (summaryMessage) {
    messages.push(summaryMessage);
  }

  if (opts.workingTurn) {
    messages.push(opts.workingTurn.userMessage);
    messages.push(...opts.workingTurn.contextMessages);
  }

  const result = Object.freeze({
    messages: Object.freeze(messages),
    retrievalIntentKind: retrievalStrategy.classification.primaryIntent,
    retrievalSecondaryIntents:
      retrievalStrategy.classification.secondaryIntents,
    retrievalRequiresExactEvidence:
      retrievalStrategy.classification.requiresExactEvidence,
    retrievalSignals: retrievalStrategy.classification.signals,
    retrievalStageOrder: retrievalStrategy.stagePlan.stageOrder,
    retrievalPromptBlocks: effectiveRetrievalPromptBlocks,
    retrievalStopTarget: retrievalStrategy.stagePlan.stopTarget,
    retrievalStopReason,
    effectiveWorkspacePath: retrievalWorkspacePath,
    notesTokens:
      estimateTokens(notesContent) + estimateTokens(systemPlatformContent),
    taskMemoryTokens:
      (includeTaskMemory ? estimateTokens(taskMemoryContent) : 0) +
      (includeOpenFindings ? estimateTokens(openFindingsContent) : 0),
    activeTaskMemoryTokens: estimateTokens(activeTaskMemoryContent),
    projectMemoryTokens: estimateTokens(projectMemoryContent),
    sessionMemoryTokens:
      estimateTokens(activeTaskMemoryContent) +
      estimateTokens(projectMemoryContent) +
      (includePreviousFinalConclusion
        ? estimateTokens(previousFinalConclusionContent)
        : 0),
    evidenceTokens:
      (includeToolEvidence ? evidenceBlock.tokens : 0) +
      (includeReadPlanProgress
        ? estimateTokens(evidenceBlock.readPlanProgressContent)
        : 0),
    syntaxIndexTokens:
      (includeSyntaxIndex ? syntaxIndexBlock.tokens : 0) +
      estimateTokens(retrievalStrategy.content) +
      (includeWorkflowRetrieval
        ? estimateTokens(workflowRetrievalBlock.overviewContent)
        : 0) +
      (includeMatchedNodes
        ? estimateTokens(workflowRetrievalBlock.matchedNodesContent)
        : 0) +
      (includeGraphPath
        ? estimateTokens(workflowRetrievalBlock.graphPathContent)
        : 0) +
      (includeWorkflowSummaries
        ? estimateTokens(workflowRetrievalBlock.workflowSummariesContent)
        : 0) +
      (includeTraceNarratives
        ? estimateTokens(workflowRetrievalBlock.traceNarrativesContent)
        : 0) +
      (includeSemanticRetrieval ? semanticRetrievalBlock.tokens : 0) +
      (includeHybridRetrieval
        ? estimateTokens(hybridRetrievalBlock.content)
        : 0) +
      (includeSkeletonRetrieval
        ? estimateTokens(hybridRetrievalBlock.skeletonContent)
        : 0) +
      (includeSyntaxCandidateMaps
        ? estimateTokens(codeMapCandidatesContent)
        : 0) +
      (includeSyntaxCandidateMaps
        ? estimateTokens(symbolMapCandidatesContent)
        : 0) +
      (includeManualPlanning ? estimateTokens(manualPlanningContent) : 0) +
      (includeManualReadBatches
        ? estimateTokens(manualReadBatchesBlock.content)
        : 0),
    workingSessionTokens: workingPromptTokens,
    workingTurnTokens: workingPromptTokens,
    finalPromptTokens: countContextTokens(messages),
    compactedWorkingTurn: Boolean(opts.workingTurn?.compacted),
    droppedRawToolMessages: opts.workingTurn?.droppedContextMessages ?? 0,
    evidenceContent: evidenceBlock.content,
    evidenceEntryCount: evidenceBlock.entryCount,
    syntaxIndexEntryCount: syntaxIndexBlock.entryCount,
    focusSymbols: syntaxIndexBlock.focusSymbols,
    manualPlanningContent,
    manualReadBatchesContent: manualReadBatchesBlock.content,
    manualReadBatchItems: manualReadBatchesBlock.items,
    readPlanProgressContent: evidenceBlock.readPlanProgressContent,
    readPlanProgressItems: evidenceBlock.readPlanProgress,
    confirmedReadCount: evidenceBlock.confirmedReadCount,
    retrievalLifecycleContent: evidenceBlock.retrievalLifecycleContent,
    antiLoopGuardrailsContent: evidenceBlock.antiLoopGuardrailsContent,
    workflowRereadGuard,
  });

  appendTelemetryEvent(retrievalWorkspacePath, {
    kind: "prompt_build",
    promptTokensEstimate: result.finalPromptTokens,
    evidenceEntryCount: result.evidenceEntryCount,
    syntaxIndexEntryCount: result.syntaxIndexEntryCount,
    confirmedReadCount: result.confirmedReadCount,
    readPlanCount: result.readPlanProgressItems.length,
    compactedWorkingTurn: result.compactedWorkingTurn,
    hybridCandidateCount: hybridRetrievalBlock.candidatePaths.length,
    semanticCandidateCount: semanticRetrievalBlock.candidatePaths.length,
    retrievalIntentKind: result.retrievalIntentKind,
    retrievalRequiresExactEvidence: result.retrievalRequiresExactEvidence,
    retrievalStageCount: result.retrievalStageOrder.length,
    retrievalStopTarget: result.retrievalStopTarget,
    retrievalStopReason: result.retrievalStopReason,
  });
  appendTelemetryEvent(retrievalWorkspacePath, {
    kind: "workflow_retrieval",
    flowQuery: workflowRetrievalBlock.flowQuery,
    hadHits: workflowRetrievalBlock.entryCount > 0,
    entryCount: workflowRetrievalBlock.entryCount,
    candidatePathCount: workflowRetrievalBlock.candidatePaths.length,
    rereadGuardEnabled: workflowRereadGuard.enabled,
  });

  return result;
}
