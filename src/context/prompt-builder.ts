/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Prompt context orchestration entrypoint for the VS Code extension runtime.
 */

import type { AgentType, ChatMessage } from '../shared/protocol';
import { countContextTokens, estimateTokens } from './compaction';
import type { PromptBuildResult, SessionMemory, WorkingTurn } from './entities/history';
import { buildActiveTaskMemoryContent, buildProjectMemoryContent } from './memory-format';
import {
  buildCodeMapCandidatesContent,
  buildManualPlanningContent,
  buildManualReadBatchesBlock,
  buildSymbolMapCandidatesContent,
  buildSystemPlatformContent,
  buildTaskMemoryContent,
  filterPendingReadPlan,
  prioritizeRefreshReadPlan,
} from './prompt/context-blocks';
import {
  buildWorkflowRetrievalBlock,
  extractMentionedPaths,
  selectProjectHintPaths,
  shouldEnableWorkflowRereadGuard,
  takeRecentPaths,
  uniquePaths,
} from './prompt/retrieval-helpers';
import { buildHybridRetrievalBlocks } from './prompt/hybrid-retrieval';
import { queryRelevantTaskMemory } from './rag-metadata/task-memory';
import { queryRagHintPaths } from './rag-metadata/metadata-sync';
import { buildSemanticRetrievalContext } from './semantic/retrieval';
import { buildSyntaxIndexContext } from './syntax/context';
import { appendTelemetryEvent } from './telemetry';
import { buildRelevantToolEvidenceBlock } from './tool-evidence-selector';

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
    role: 'user',
    content: trimmed,
    timestamp: Date.now(),
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
  const workingTurnFiles =
    opts.workingTurn?.toolDigests.flatMap((digest) => [
      ...digest.filesRead,
      ...digest.filesWritten,
      ...digest.filesReverted,
    ]) ?? [];
  const mentionedPaths = extractMentionedPaths(opts.workingTurn?.userMessage.content ?? '');
  const queryText = opts.workingTurn?.userMessage.content ?? '';
  const activeTaskRetrievalPaths = uniquePaths([
    ...opts.sessionMemory.activeTaskMemory.filesTouched,
    ...opts.sessionMemory.activeTaskMemory.keyFiles,
  ]);
  const projectHintPaths = selectProjectHintPaths(
    queryText,
    opts.sessionMemory.projectMemory.keyFiles,
  );
  const sqliteHintPaths = queryRagHintPaths(
    opts.sessionMemory.workspacePath,
    queryText,
    4,
  );
  const workflowRetrievalBlock = await buildWorkflowRetrievalBlock({
    workspacePath: opts.sessionMemory.workspacePath,
    queryText,
    workingTurnFiles,
    mentionedPaths,
  });
  const retrievalSeedPaths = uniquePaths([
    ...mentionedPaths,
    ...workingTurnFiles,
    ...takeRecentPaths(activeTaskRetrievalPaths, 6),
    ...projectHintPaths,
    ...sqliteHintPaths,
    ...workflowRetrievalBlock.candidatePaths,
  ]);
  const retrievalKeyFiles = uniquePaths([
    ...takeRecentPaths(activeTaskRetrievalPaths, 6),
    ...projectHintPaths,
    ...sqliteHintPaths,
    ...workflowRetrievalBlock.candidatePaths,
  ]);
  const retrievalRecentPaths = uniquePaths([
    ...takeRecentPaths(opts.sessionMemory.activeTaskMemory.filesTouched, 8),
    ...takeRecentPaths(opts.sessionMemory.projectMemory.keyFiles, 4),
  ]);
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

  const notesContent = opts.notes.trim() ? `[NOTES]\n${opts.notes.trim()}` : '';
  const systemPlatformContent = buildSystemPlatformContent();
  const taskMemory = await queryRelevantTaskMemory(
    opts.sessionMemory.workspacePath,
    queryText,
    3,
  );
  const taskMemoryContent = buildTaskMemoryContent(taskMemory);
  const projectMemoryContent = buildProjectMemoryContent(opts.sessionMemory.projectMemory);
  const activeTaskMemoryContent = buildActiveTaskMemoryContent(opts.sessionMemory.activeTaskMemory);
  const previousFinalConclusionContent = opts.sessionMemory.lastFinalAssistantConclusion.trim()
    ? `[PREVIOUS FINAL ASSISTANT CONCLUSION]\n` +
      `${opts.sessionMemory.lastFinalAssistantConclusion.trim()}\n\n` +
      'Treat this as the most recent authoritative conclusion from the previous completed turn. Prefer continuing from it instead of restarting the analysis from scratch. If you need to reopen the analysis, explain what current evidence contradicts it or what new information is missing.'
    : '';
  const syntaxIndexBlock = await buildSyntaxIndexContext({
    workspacePath: opts.sessionMemory.workspacePath,
    candidateFiles: retrievalSeedPaths,
    queryText,
  });
  const semanticRetrievalBlock = await buildSemanticRetrievalContext({
    workspacePath: opts.sessionMemory.workspacePath,
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
  });
  const initialHybridRetrievalBlock = buildHybridRetrievalBlocks({
    queryText,
    records: syntaxIndexBlock.records,
    mentionedPaths,
    workingTurnFiles,
    keyFiles: retrievalKeyFiles,
    recentPaths: retrievalRecentPaths,
    primaryPaths: syntaxIndexBlock.primaryPaths,
    definitionPaths: syntaxIndexBlock.definitionPaths,
    referencePaths: syntaxIndexBlock.referencePaths,
    focusSymbols: syntaxIndexBlock.focusSymbols,
    semanticPaths: semanticRetrievalBlock.candidatePaths,
    workflowPathScores: workflowRetrievalBlock.pathScores,
  });
  const codeMapCandidatesContent = buildCodeMapCandidatesContent({
    primaryPaths: syntaxIndexBlock.primaryPaths,
    definitionPaths: syntaxIndexBlock.definitionPaths,
    referencePaths: syntaxIndexBlock.referencePaths,
  });
  const symbolMapCandidatesContent = buildSymbolMapCandidatesContent({
    focusSymbols: syntaxIndexBlock.focusSymbols,
    primaryCandidates: syntaxIndexBlock.primarySymbolCandidates,
    definitionCandidates: syntaxIndexBlock.definitionSymbolCandidates,
    referenceCandidates: syntaxIndexBlock.referenceSymbolCandidates,
  });
  const manualPlanningContent =
    opts.agentType === 'manual'
      ? buildManualPlanningContent({
          focusSymbols: syntaxIndexBlock.focusSymbols,
          primaryPaths: syntaxIndexBlock.primaryPaths,
          definitionPaths: syntaxIndexBlock.definitionPaths,
          referencePaths: syntaxIndexBlock.referencePaths,
          primaryCandidates: syntaxIndexBlock.primarySymbolCandidates,
          definitionCandidates: syntaxIndexBlock.definitionSymbolCandidates,
        })
      : '';
  const evidenceBlock = buildRelevantToolEvidenceBlock({
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
  });
  const pendingReadPlan =
    opts.agentType === 'manual'
      ? prioritizeRefreshReadPlan(
          filterPendingReadPlan(syntaxIndexBlock.manualReadPlan, evidenceBlock.readPlanProgress),
          evidenceBlock.readPlanProgress,
        )
      : Object.freeze([]);
  const manualReadBatchesBlock =
    opts.agentType === 'manual'
      ? buildManualReadBatchesBlock({
          readPlan: pendingReadPlan,
        })
      : Object.freeze({
          content: '',
          items: Object.freeze([]),
        });
  const feedbackHybridRetrievalBlock = buildHybridRetrievalBlocks({
    queryText,
    records: syntaxIndexBlock.records,
    mentionedPaths,
    workingTurnFiles,
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
  });
  const hybridRetrievalBlock =
    feedbackHybridRetrievalBlock.candidatePaths.length > 0
      ? feedbackHybridRetrievalBlock
      : initialHybridRetrievalBlock;
  const contextNoteContent = opts.workingTurn?.contextNote?.trim() ?? '';
  const compactSummaryContent = opts.workingTurn?.compactSummary?.trim() ?? '';
  const workingPromptTokens = opts.workingTurn
    ? countContextTokens([opts.workingTurn.userMessage, ...opts.workingTurn.contextMessages]) +
      estimateTokens(contextNoteContent) +
      estimateTokens(compactSummaryContent)
    : 0;

  const notesMessage = buildContextMessage(notesContent, `ctx-notes-${Date.now()}`);
  if (notesMessage) {
    messages.push(notesMessage);
  }

  const systemPlatformMessage = buildContextMessage(systemPlatformContent, `ctx-platform-${Date.now()}`);
  if (systemPlatformMessage) {
    messages.push(systemPlatformMessage);
  }

  const taskMemoryMessage = buildContextMessage(taskMemoryContent, `ctx-task-memory-${Date.now()}`);
  if (taskMemoryMessage) {
    messages.push(taskMemoryMessage);
  }

  const projectMemoryMessage = buildContextMessage(projectMemoryContent, `ctx-project-memory-${Date.now()}`);
  if (projectMemoryMessage) {
    messages.push(projectMemoryMessage);
  }

  const activeTaskMessage = buildContextMessage(activeTaskMemoryContent, `ctx-active-task-${Date.now()}`);
  if (activeTaskMessage) {
    messages.push(activeTaskMessage);
  }

  const previousFinalConclusionMessage = buildContextMessage(
    previousFinalConclusionContent,
    `ctx-previous-final-conclusion-${Date.now()}`,
  );
  if (previousFinalConclusionMessage) {
    messages.push(previousFinalConclusionMessage);
  }

  const workflowRetrievalMessage = buildContextMessage(workflowRetrievalBlock.content, `ctx-workflow-retrieval-${Date.now()}`);
  if (workflowRetrievalMessage) {
    messages.push(workflowRetrievalMessage);
  }

  const codeMapCandidatesMessage = buildContextMessage(codeMapCandidatesContent, `ctx-code-map-${Date.now()}`);
  if (codeMapCandidatesMessage) {
    messages.push(codeMapCandidatesMessage);
  }

  const hybridRetrievalMessage = buildContextMessage(hybridRetrievalBlock.content, `ctx-hybrid-retrieval-${Date.now()}`);
  if (hybridRetrievalMessage) {
    messages.push(hybridRetrievalMessage);
  }

  const semanticRetrievalMessage = buildContextMessage(semanticRetrievalBlock.content, `ctx-semantic-retrieval-${Date.now()}`);
  if (semanticRetrievalMessage) {
    messages.push(semanticRetrievalMessage);
  }

  const semanticChunkMessage = buildContextMessage(semanticRetrievalBlock.chunkContent, `ctx-semantic-chunks-${Date.now()}`);
  if (semanticChunkMessage) {
    messages.push(semanticChunkMessage);
  }

  const skeletonRetrievalMessage = buildContextMessage(hybridRetrievalBlock.skeletonContent, `ctx-skeleton-retrieval-${Date.now()}`);
  if (skeletonRetrievalMessage) {
    messages.push(skeletonRetrievalMessage);
  }

  const symbolMapCandidatesMessage = buildContextMessage(symbolMapCandidatesContent, `ctx-symbol-map-${Date.now()}`);
  if (symbolMapCandidatesMessage) {
    messages.push(symbolMapCandidatesMessage);
  }

  const manualPlanningMessage = buildContextMessage(manualPlanningContent, `ctx-manual-plan-${Date.now()}`);
  if (manualPlanningMessage) {
    messages.push(manualPlanningMessage);
  }

  const manualReadBatchesMessage = buildContextMessage(manualReadBatchesBlock.content, `ctx-manual-batches-${Date.now()}`);
  if (manualReadBatchesMessage) {
    messages.push(manualReadBatchesMessage);
  }

  const readPlanProgressMessage = buildContextMessage(evidenceBlock.readPlanProgressContent, `ctx-read-plan-progress-${Date.now()}`);
  if (readPlanProgressMessage) {
    messages.push(readPlanProgressMessage);
  }

  const retrievalLifecycleMessage = buildContextMessage(
    evidenceBlock.retrievalLifecycleContent,
    `ctx-retrieval-lifecycle-${Date.now()}`,
  );
  if (retrievalLifecycleMessage) {
    messages.push(retrievalLifecycleMessage);
  }

  const antiLoopGuardrailsMessage = buildContextMessage(
    evidenceBlock.antiLoopGuardrailsContent,
    `ctx-anti-loop-${Date.now()}`,
  );
  if (antiLoopGuardrailsMessage) {
    messages.push(antiLoopGuardrailsMessage);
  }

  const evidenceReuseMessage = buildContextMessage(
    evidenceBlock.evidenceReuseContent,
    `ctx-evidence-reuse-${Date.now()}`,
  );
  if (evidenceReuseMessage) {
    messages.push(evidenceReuseMessage);
  }

  const syntaxIndexMessage = buildContextMessage(syntaxIndexBlock.content, `ctx-syntax-index-${Date.now()}`);
  if (syntaxIndexMessage) {
    messages.push(syntaxIndexMessage);
  }

  const evidenceMessage = buildContextMessage(evidenceBlock.content, `ctx-evidence-${Date.now()}`);
  if (evidenceMessage) {
    messages.push(evidenceMessage);
  }

  const contextNoteMessage = buildContextMessage(contextNoteContent, `ctx-working-${Date.now()}`);
  if (contextNoteMessage) {
    messages.push(contextNoteMessage);
  }

  const summaryMessage = buildContextMessage(compactSummaryContent, `ctx-working-summary-${Date.now()}`);
  if (summaryMessage) {
    messages.push(summaryMessage);
  }

  if (opts.workingTurn) {
    messages.push(opts.workingTurn.userMessage);
    messages.push(...opts.workingTurn.contextMessages);
  }

  const result = Object.freeze({
    messages: Object.freeze(messages),
    notesTokens: estimateTokens(notesContent) + estimateTokens(systemPlatformContent),
    taskMemoryTokens: estimateTokens(taskMemoryContent),
    activeTaskMemoryTokens: estimateTokens(activeTaskMemoryContent),
    projectMemoryTokens: estimateTokens(projectMemoryContent),
    sessionMemoryTokens: estimateTokens(activeTaskMemoryContent) + estimateTokens(projectMemoryContent),
    evidenceTokens: evidenceBlock.tokens + estimateTokens(evidenceBlock.readPlanProgressContent),
    syntaxIndexTokens:
      syntaxIndexBlock.tokens +
      estimateTokens(workflowRetrievalBlock.content) +
      semanticRetrievalBlock.tokens +
      estimateTokens(hybridRetrievalBlock.content) +
      estimateTokens(hybridRetrievalBlock.skeletonContent) +
      estimateTokens(codeMapCandidatesContent) +
      estimateTokens(symbolMapCandidatesContent) +
      estimateTokens(manualPlanningContent) +
      estimateTokens(manualReadBatchesBlock.content),
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

  appendTelemetryEvent(opts.sessionMemory.workspacePath, {
    kind: 'prompt_build',
    promptTokensEstimate: result.finalPromptTokens,
    evidenceEntryCount: result.evidenceEntryCount,
    syntaxIndexEntryCount: result.syntaxIndexEntryCount,
    confirmedReadCount: result.confirmedReadCount,
    readPlanCount: result.readPlanProgressItems.length,
    compactedWorkingTurn: result.compactedWorkingTurn,
    hybridCandidateCount: hybridRetrievalBlock.candidatePaths.length,
    semanticCandidateCount: semanticRetrievalBlock.candidatePaths.length,
  });
  appendTelemetryEvent(opts.sessionMemory.workspacePath, {
    kind: 'workflow_retrieval',
    flowQuery: workflowRetrievalBlock.flowQuery,
    hadHits: workflowRetrievalBlock.entryCount > 0,
    entryCount: workflowRetrievalBlock.entryCount,
    candidatePathCount: workflowRetrievalBlock.candidatePaths.length,
    rereadGuardEnabled: workflowRereadGuard.enabled,
  });

  return result;
}
