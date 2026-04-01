/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Top-level semantic retrieval orchestration.
 */

import { estimateTokens } from '../compaction';
import { getProjectStorageInfo } from '../project-store';
import { queryRagHintPaths } from '../rag-metadata/metadata-sync';
import type { SemanticRetrievalResult } from '../entities/semantic-index';
import type { SyntaxContextRecordSummary } from '../entities/syntax-index';
import { MAX_RESULTS } from './constants';
import { ensureChunkEmbeddings, embedQueryText, queryChromaChunkScores, syncChunksToChroma } from './chroma';
import { computeSemanticChunkScore, syncStore } from './chunks';
import { buildTermVector } from './helpers';

/**
 * Builds the semantic retrieval prompt blocks for a user query.
 */
export async function buildSemanticRetrievalContext(opts: {
  workspacePath: string;
  queryText: string;
  candidateFiles: readonly string[];
  records: readonly SyntaxContextRecordSummary[];
  primaryPaths?: readonly string[];
  definitionPaths?: readonly string[];
  referencePaths?: readonly string[];
  workflowPathScores?: Readonly<Record<string, number>>;
}): Promise<SemanticRetrievalResult> {
  if (!opts.queryText.trim()) {
    return Object.freeze({
      content: '',
      chunkContent: '',
      tokens: 0,
      entryCount: 0,
      candidatePaths: Object.freeze([]),
    });
  }

  const sqliteHintPaths = queryRagHintPaths(opts.workspacePath, opts.queryText, 4);
  const syncedStore = await syncStore({
    workspacePath: opts.workspacePath,
    candidateFiles: [...opts.candidateFiles, ...sqliteHintPaths],
    records: opts.records,
  });
  const store = await ensureChunkEmbeddings(syncedStore).catch(() => syncedStore);
  const storage = getProjectStorageInfo(opts.workspacePath);
  void syncChunksToChroma({
    workspacePath: opts.workspacePath,
    workspaceId: storage.workspaceId,
    chunks: Object.values(store.chunks),
  });

  const queryVector = buildTermVector(opts.queryText);
  const queryEmbedding = await embedQueryText(opts.queryText);
  const chromaScores = queryEmbedding
    ? await queryChromaChunkScores({
        workspacePath: opts.workspacePath,
        workspaceId: storage.workspaceId,
        queryEmbedding,
        limit: Math.max(MAX_RESULTS * 3, 12),
      })
    : new Map<string, number>();

  const topChunks = Object.values(store.chunks)
    .map((chunk) => {
      const chromaScore = chromaScores.get(chunk.id);
      const score = computeSemanticChunkScore({
        chunk,
        queryTerms: queryVector.terms,
        queryMagnitude: queryVector.magnitude,
        queryEmbedding,
        candidateFiles: [...opts.candidateFiles, ...sqliteHintPaths],
        ...(opts.primaryPaths ? { primaryPaths: opts.primaryPaths } : {}),
        ...(opts.definitionPaths ? { definitionPaths: opts.definitionPaths } : {}),
        ...(opts.referencePaths ? { referencePaths: opts.referencePaths } : {}),
        ...(opts.workflowPathScores ? { workflowPathScores: opts.workflowPathScores } : {}),
        queryText: opts.queryText,
        ...(typeof chromaScore === 'number' ? { chromaScore } : {}),
      });
      return Object.freeze({ chunk, score, workflowBoost: opts.workflowPathScores?.[chunk.filePath] ?? 0 });
    })
    .filter((entry) => entry.score > 0.08)
    .sort((a, b) => b.score - a.score || a.chunk.filePath.localeCompare(b.chunk.filePath))
    .slice(0, MAX_RESULTS);

  if (topChunks.length === 0) {
    return Object.freeze({
      content: '',
      chunkContent: '',
      tokens: 0,
      entryCount: 0,
      candidatePaths: Object.freeze([]),
    });
  }

  const retrievalLines = ['[SEMANTIC RETRIEVAL]'];
  const chunkLines = ['[SEMANTIC CHUNKS]'];
  topChunks.forEach((entry, index) => {
    const signals = entry.workflowBoost > 0 ? ' workflow-graph' : '';
    retrievalLines.push(`- ${entry.chunk.filePath} :: ${entry.chunk.title} (score ${entry.score.toFixed(2)}${signals})`);
    if (index > 0) {
      chunkLines.push('');
    }
    chunkLines.push(`File: ${entry.chunk.filePath}`);
    chunkLines.push(`Chunk: ${entry.chunk.title}`);
    if (entry.chunk.description) {
      chunkLines.push(`Description: ${entry.chunk.description}`);
    }
    chunkLines.push(`Excerpt: ${entry.chunk.excerpt}`);
  });

  const content = retrievalLines.join('\n').trim();
  const chunkContent = chunkLines.join('\n').trim();
  return Object.freeze({
    content,
    chunkContent,
    tokens: estimateTokens(content) + estimateTokens(chunkContent),
    entryCount: topChunks.length,
    candidatePaths: Object.freeze([...new Set(topChunks.map((entry) => entry.chunk.filePath))]),
  });
}
