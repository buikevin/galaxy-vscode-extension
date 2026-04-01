/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Hybrid prompt retrieval ranking and skeleton block construction.
 */

import type { SyntaxContextRecordSummary } from '../entities/syntax-index';
import { MAX_HYBRID_FILES, MAX_SKELETON_SYMBOLS } from './constants';
import { extractQueryIdentifiers, scorePathAffinity, scoreQueryIdentifierHits } from './retrieval-helpers';

/**
 * Builds ranked hybrid retrieval and skeleton blocks for prompt context.
 */
export function buildHybridRetrievalBlocks(opts: {
  queryText: string;
  records: readonly SyntaxContextRecordSummary[];
  mentionedPaths: readonly string[];
  workingTurnFiles: readonly string[];
  keyFiles: readonly string[];
  recentPaths: readonly string[];
  primaryPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
  focusSymbols: readonly string[];
  semanticPaths?: readonly string[];
  workflowPathScores?: Readonly<Record<string, number>>;
  deprioritizedPaths?: readonly string[];
  deprioritizedSymbols?: readonly string[];
}): Readonly<{
  content: string;
  skeletonContent: string;
  candidatePaths: readonly string[];
}> {
  const queryIdentifiers = extractQueryIdentifiers(opts.queryText);

  const ranked = opts.records
    .map((record) => {
      let score = 0;
      const reasons: string[] = [];
      const matchedSymbols: string[] = [];

      const addReason = (label: string, points: number): void => {
        score += points;
        if (!reasons.includes(label)) {
          reasons.push(label);
        }
      };

      const mentionedPathScore = scorePathAffinity(record.relativePath, opts.mentionedPaths);
      if (mentionedPathScore > 0) {
        addReason('mentioned path', mentionedPathScore);
      }

      const workingTurnPathScore = scorePathAffinity(record.relativePath, opts.workingTurnFiles);
      if (workingTurnPathScore > 0) {
        addReason('active turn file', Math.max(workingTurnPathScore, 8));
      }

      const keyFileScore = scorePathAffinity(record.relativePath, opts.keyFiles);
      if (keyFileScore > 0) {
        addReason('session key file', Math.max(keyFileScore, 5));
      }

      const recentPathScore = scorePathAffinity(record.relativePath, opts.recentPaths);
      if (recentPathScore > 0) {
        addReason('recent task file', Math.max(recentPathScore, 3));
      }

      const primaryPathScore = scorePathAffinity(record.relativePath, opts.primaryPaths);
      if (primaryPathScore > 0) {
        addReason('primary candidate', Math.max(primaryPathScore, 6));
      }

      const definitionPathScore = scorePathAffinity(record.relativePath, opts.definitionPaths);
      if (definitionPathScore > 0) {
        addReason('definition edge', Math.max(definitionPathScore, 4));
      }

      const referencePathScore = scorePathAffinity(record.relativePath, opts.referencePaths);
      if (referencePathScore > 0) {
        addReason('reference edge', Math.max(referencePathScore, 3));
      }

      const semanticPathScore = scorePathAffinity(record.relativePath, opts.semanticPaths ?? []);
      if (semanticPathScore > 0) {
        addReason('semantic retrieval hit', Math.max(semanticPathScore, 4));
      }

      const workflowGraphScore = opts.workflowPathScores?.[record.relativePath] ?? 0;
      if (workflowGraphScore > 0) {
        addReason('workflow graph path', workflowGraphScore);
      }

      const deprioritizedPathScore = scorePathAffinity(record.relativePath, opts.deprioritizedPaths ?? []);
      if (deprioritizedPathScore > 0) {
        addReason('already confirmed by evidence', -Math.max(Math.floor(deprioritizedPathScore / 2), 4));
      }

      opts.focusSymbols.forEach((focusSymbol) => {
        const matched = record.symbols.find((symbol) => symbol.name.toLowerCase() === focusSymbol.toLowerCase());
        if (!matched) {
          return;
        }

        const isDeprioritized = (opts.deprioritizedSymbols ?? []).some(
          (symbol) => symbol.toLowerCase() === matched.name.toLowerCase(),
        );
        addReason(
          isDeprioritized ? `already confirmed symbol ${matched.name}` : `focus symbol ${matched.name}`,
          isDeprioritized ? -6 : 6,
        );
        if (!matchedSymbols.includes(matched.name)) {
          matchedSymbols.push(matched.name);
        }
      });

      const queryHits = scoreQueryIdentifierHits({
        record,
        queryIdentifiers,
      });
      queryHits.reasons.forEach((reason) => addReason(reason, 0));
      score += queryHits.score;

      const graphAffinity =
        record.resolvedImports.filter((item) => opts.primaryPaths.includes(item) || opts.definitionPaths.includes(item)).length +
        opts.referencePaths.filter((item) => item === record.relativePath).length;
      if (graphAffinity > 0) {
        addReason('syntax graph affinity', Math.min(graphAffinity, 3) * 2);
      }

      return Object.freeze({
        record,
        score,
        reasons: Object.freeze(reasons),
        matchedSymbols: Object.freeze(matchedSymbols),
      });
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.relativePath.localeCompare(b.record.relativePath))
    .slice(0, MAX_HYBRID_FILES);

  if (ranked.length === 0) {
    return Object.freeze({
      content: '',
      skeletonContent: '',
      candidatePaths: Object.freeze([]),
    });
  }

  const retrievalLines = ['[HYBRID RETRIEVAL]'];
  ranked.forEach((entry) => {
    retrievalLines.push(`- ${entry.record.relativePath} (score ${entry.score}): ${entry.reasons.join(', ')}`);
  });

  const skeletonLines = ['[SKELETON RETRIEVAL]'];
  ranked.forEach((entry, index) => {
    if (index > 0) {
      skeletonLines.push('');
    }
    skeletonLines.push(`File: ${entry.record.relativePath}`);
    const preferredSymbols = entry.matchedSymbols.length > 0
      ? entry.record.symbols.filter((symbol) => entry.matchedSymbols.includes(symbol.name))
      : entry.record.symbols.filter((symbol) => symbol.exported);
    const deprioritizedSymbols = new Set((opts.deprioritizedSymbols ?? []).map((symbol) => symbol.toLowerCase()));
    const candidateSymbols = preferredSymbols.length > 0 ? preferredSymbols : entry.record.symbols;
    const filteredSymbols = candidateSymbols.filter((symbol) => !deprioritizedSymbols.has(symbol.name.toLowerCase()));
    const skeletonSymbols = (filteredSymbols.length > 0 ? filteredSymbols : candidateSymbols).slice(0, MAX_SKELETON_SYMBOLS);
    skeletonSymbols.forEach((symbol) => {
      skeletonLines.push(`- ${symbol.signature}`);
    });
  });

  return Object.freeze({
    content: retrievalLines.join('\n').trim(),
    skeletonContent: skeletonLines.join('\n').trim(),
    candidatePaths: Object.freeze(ranked.map((entry) => entry.record.relativePath)),
  });
}
