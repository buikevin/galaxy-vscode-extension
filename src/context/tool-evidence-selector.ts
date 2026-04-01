/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Build prompt-ready tool-evidence context blocks from persisted evidence and read-plan state.
 */

import { estimateTokens } from './compaction';
import type { ReadPlanProgressItem, SessionMemory, WorkingTurn } from './entities/history';
import type { ManualReadPlanStep } from './entities/syntax-index';
import { loadRecentToolEvidence } from './tool-evidence-store';
import {
  buildAntiLoopGuardrails,
  buildEvidenceReuseBlock,
  buildRetrievalLifecycleBlock,
  deriveStaleEvidence,
  extractMentionedPaths,
  formatEvidence,
  getEvidenceTargetPath,
  scoreEvidence,
  scoreSymbolMatch,
} from './tool-evidence/selectors';
import { evaluateReadPlanProgress, scoreReadPlanMatch } from './tool-evidence/read-plan';
import { MAX_EVIDENCE_TOKENS } from './entities/constants';


/**
 * Builds the prompt block that summarizes relevant persisted tool evidence for the current turn.
 *
 * @param opts Session memory, working turn, and retrieval hints used to rank evidence.
 * @returns Prompt-ready evidence block and read-plan progress metadata.
 */
export function buildRelevantToolEvidenceBlock(opts: {
  sessionMemory: SessionMemory;
  workingTurn: WorkingTurn | null;
  preferredPaths?: readonly string[];
  definitionPaths?: readonly string[];
  referencePaths?: readonly string[];
  focusSymbols?: readonly string[];
  readPlan?: readonly ManualReadPlanStep[];
}): Readonly<{
  content: string;
  tokens: number;
  entryCount: number;
  readPlanProgress: readonly ReadPlanProgressItem[];
  readPlanProgressContent: string;
  confirmedReadPaths: readonly string[];
  confirmedSymbols: readonly string[];
  refreshReadPaths: readonly string[];
  refreshSymbols: readonly string[];
  confirmedReadCount: number;
  retrievalLifecycleContent: string;
  antiLoopGuardrailsContent: string;
  evidenceReuseContent: string;
}> {
  const evidence = loadRecentToolEvidence(opts.sessionMemory.workspacePath);
  const freshenedEvidence = deriveStaleEvidence(evidence);
  const readPlanProgress = evaluateReadPlanProgress(freshenedEvidence, opts.readPlan ?? []);
  const retrievalLifecycleContent = buildRetrievalLifecycleBlock(readPlanProgress.items);
  const antiLoopGuardrailsContent = buildAntiLoopGuardrails(freshenedEvidence, readPlanProgress.items);
  const evidenceReuseContent = buildEvidenceReuseBlock(readPlanProgress.items);
  if (freshenedEvidence.length === 0) {
    return Object.freeze({
      content: '',
      tokens: 0,
      entryCount: 0,
      readPlanProgress: readPlanProgress.items,
      readPlanProgressContent: readPlanProgress.content,
      confirmedReadPaths: readPlanProgress.confirmedPaths,
      confirmedSymbols: readPlanProgress.confirmedSymbols,
      refreshReadPaths: readPlanProgress.refreshPaths,
      refreshSymbols: readPlanProgress.refreshSymbols,
      confirmedReadCount: readPlanProgress.confirmedCount,
      retrievalLifecycleContent,
      antiLoopGuardrailsContent,
      evidenceReuseContent,
    });
  }

  const latestUserMessage = opts.workingTurn?.userMessage.content ?? '';
  const mentionedPaths = extractMentionedPaths(latestUserMessage);
  const workingTurnPaths = opts.workingTurn
    ? [
        ...opts.workingTurn.toolDigests.flatMap((digest) => [
          ...digest.filesRead,
          ...digest.filesWritten,
          ...digest.filesReverted,
        ]),
      ]
    : [];
  const candidatePaths = Object.freeze([
    ...new Set([
      ...mentionedPaths,
      ...opts.sessionMemory.keyFiles,
      ...workingTurnPaths,
      ...(opts.preferredPaths ?? []),
      ...(opts.definitionPaths ?? []),
      ...(opts.referencePaths ?? []),
    ]),
  ]);

  const selected = [...freshenedEvidence]
    .map((item) => {
      let score = scoreEvidence(item, mentionedPaths, candidatePaths);
      const targetPath = getEvidenceTargetPath(item);
      if (targetPath && (opts.preferredPaths ?? []).some((candidate) => targetPath.includes(candidate) || candidate.includes(targetPath))) {
        score += 5;
      }
      if (targetPath && (opts.definitionPaths ?? []).some((candidate) => targetPath.includes(candidate) || candidate.includes(targetPath))) {
        score += 4;
      }
      if (targetPath && (opts.referencePaths ?? []).some((candidate) => targetPath.includes(candidate) || candidate.includes(targetPath))) {
        score += 3;
      }
      score += scoreSymbolMatch(item, opts.focusSymbols ?? []);
      score += scoreReadPlanMatch(item, opts.readPlan ?? []);
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.capturedAt - a.item.capturedAt)
    .slice(0, 8)
    .map((entry) => entry.item);

  if (selected.length === 0) {
    return Object.freeze({
      content: '',
      tokens: 0,
      entryCount: 0,
      readPlanProgress: readPlanProgress.items,
      readPlanProgressContent: readPlanProgress.content,
      confirmedReadPaths: readPlanProgress.confirmedPaths,
      confirmedSymbols: readPlanProgress.confirmedSymbols,
      refreshReadPaths: readPlanProgress.refreshPaths,
      refreshSymbols: readPlanProgress.refreshSymbols,
      confirmedReadCount: readPlanProgress.confirmedCount,
      retrievalLifecycleContent,
      antiLoopGuardrailsContent,
      evidenceReuseContent,
    });
  }

  const lines = ['[RELEVANT TOOL EVIDENCE]'];
  for (const item of selected) {
    const line = formatEvidence(item);
    const nextContent = `${lines.join('\n')}\n${line}`;
    if (estimateTokens(nextContent) > MAX_EVIDENCE_TOKENS) {
      break;
    }
    lines.push(line);
  }

  const content = lines.join('\n').trim();
  return Object.freeze({
    content,
    tokens: estimateTokens(content),
    entryCount: selected.length,
    readPlanProgress: readPlanProgress.items,
    readPlanProgressContent: readPlanProgress.content,
    confirmedReadPaths: readPlanProgress.confirmedPaths,
    confirmedSymbols: readPlanProgress.confirmedSymbols,
    refreshReadPaths: readPlanProgress.refreshPaths,
    refreshSymbols: readPlanProgress.refreshSymbols,
    confirmedReadCount: readPlanProgress.confirmedCount,
    retrievalLifecycleContent,
    antiLoopGuardrailsContent,
    evidenceReuseContent,
  });
}
