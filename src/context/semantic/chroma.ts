/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Embedding and Chroma helpers for semantic retrieval.
 */

import { createChromaClient, resolveChromaUrl } from '../chroma-manager';
import { embedTexts, getGeminiEmbeddingModel } from '../gemini-embeddings';
import type { SemanticChunkRecord, SemanticIndexStore } from '../entities/semantic-index';
import { MANUAL_EMBEDDING_FUNCTION, EMBEDDING_BATCH_SIZE, MAX_RESULTS, SEMANTIC_CHROMA_TIMEOUT_MS } from './constants';
import { buildSemanticCollectionName } from './helpers';
import { saveStore } from './store';

/**
 * Ensures that semantic chunks have current Gemini embeddings.
 */
export async function ensureChunkEmbeddings(store: SemanticIndexStore): Promise<SemanticIndexStore> {
  const model = getGeminiEmbeddingModel();
  const missing = Object.entries(store.chunks).filter(([, chunk]) => !chunk.embedding || chunk.embeddingModel !== model);
  if (missing.length === 0) {
    return store;
  }

  const nextChunks: Record<string, SemanticChunkRecord> = { ...store.chunks };
  let changed = false;

  for (let index = 0; index < missing.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = missing.slice(index, index + EMBEDDING_BATCH_SIZE);
    const inputs = batch.map(([, chunk]) => `${chunk.title}\n${chunk.description ?? ''}\n${chunk.excerpt}`);
    const embeddings = await embedTexts(inputs, 'RETRIEVAL_DOCUMENT');
    if (!embeddings || embeddings.length !== batch.length) {
      continue;
    }

    batch.forEach(([chunkId, chunk], batchIndex) => {
      const embedding = embeddings[batchIndex];
      if (!embedding || embedding.length === 0) {
        return;
      }
      nextChunks[chunkId] = Object.freeze({
        ...chunk,
        embedding: Object.freeze([...embedding]),
        embeddingModel: model,
      });
      changed = true;
    });
  }

  if (!changed) {
    return store;
  }

  const nextStore = Object.freeze({
    ...store,
    updatedAt: Date.now(),
    chunks: Object.freeze(nextChunks),
  });
  saveStore(store.workspacePath, nextStore);
  return nextStore;
}

/**
 * Builds the document payload mirrored to Chroma for one semantic chunk.
 */
export function buildChromaDocument(chunk: SemanticChunkRecord): string {
  return [
    `File: ${chunk.filePath}`,
    `Title: ${chunk.title}`,
    chunk.symbolName ? `Symbol: ${chunk.symbolName}` : '',
    chunk.symbolKind ? `Kind: ${chunk.symbolKind}` : '',
    chunk.description ? `Description: ${chunk.description}` : '',
    `Excerpt: ${chunk.excerpt}`,
  ].filter(Boolean).join('\n');
}

/**
 * Mirrors semantic chunks to per-project Chroma storage.
 */
export async function syncChunksToChroma(opts: {
  workspacePath: string;
  workspaceId: string;
  chunks: readonly SemanticChunkRecord[];
}): Promise<void> {
  const chromaPath = await resolveChromaUrl(opts.workspacePath);
  if (!chromaPath || opts.chunks.length === 0) {
    return;
  }

  try {
    const client = createChromaClient(chromaPath);
    const collection = await Promise.race([
      client.getOrCreateCollection({
        name: buildSemanticCollectionName(opts.workspaceId),
        embeddingFunction: MANUAL_EMBEDDING_FUNCTION,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SEMANTIC_CHROMA_TIMEOUT_MS)),
    ]);
    if (!collection) {
      return;
    }

    const syncedChunks = opts.chunks.filter((chunk) => chunk.embedding && chunk.embedding.length > 0);
    if (syncedChunks.length === 0) {
      return;
    }

    await Promise.race([
      collection.upsert({
        ids: syncedChunks.map((chunk) => chunk.id),
        documents: syncedChunks.map((chunk) => buildChromaDocument(chunk)),
        embeddings: syncedChunks.map((chunk) => [...(chunk.embedding ?? [])]),
        metadatas: syncedChunks.map((chunk) => ({
          filePath: chunk.filePath,
          kind: chunk.kind,
          title: chunk.title,
          symbolName: chunk.symbolName ?? '',
          symbolKind: chunk.symbolKind ?? '',
          exported: Boolean(chunk.exported),
          startLine: chunk.startLine ?? -1,
          endLine: chunk.endLine ?? -1,
          description: chunk.description ?? '',
          descriptionSource: chunk.descriptionSource ?? '',
          mtimeMs: chunk.mtimeMs,
        })),
      }),
      new Promise<void>((resolve) => setTimeout(() => resolve(), SEMANTIC_CHROMA_TIMEOUT_MS)),
    ]);
  } catch {
    // Best effort only.
  }
}

/**
 * Queries Chroma for chunk similarity scores using a query embedding.
 */
export async function queryChromaChunkScores(opts: {
  workspacePath: string;
  workspaceId: string;
  queryEmbedding: readonly number[];
  limit: number;
}): Promise<ReadonlyMap<string, number>> {
  const chromaPath = await resolveChromaUrl(opts.workspacePath);
  if (!chromaPath) {
    return new Map<string, number>();
  }

  try {
    const client = createChromaClient(chromaPath);
    const collection = await Promise.race([
      client.getOrCreateCollection({
        name: buildSemanticCollectionName(opts.workspaceId),
        embeddingFunction: MANUAL_EMBEDDING_FUNCTION,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SEMANTIC_CHROMA_TIMEOUT_MS)),
    ]);
    if (!collection) {
      return new Map<string, number>();
    }

    const result = await Promise.race([
      collection.query({
        queryEmbeddings: [[...opts.queryEmbedding]],
        nResults: opts.limit,
        include: ['distances'],
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SEMANTIC_CHROMA_TIMEOUT_MS)),
    ]);
    if (!result) {
      return new Map<string, number>();
    }

    const ids = result.ids[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const scores = new Map<string, number>();
    ids.forEach((id, index) => {
      const distance = distances[index];
      scores.set(id, typeof distance === 'number' ? Math.max(0, 1 - distance) : 0);
    });
    return scores;
  } catch {
    return new Map<string, number>();
  }
}

/**
 * Queries embeddings for the current semantic retrieval request.
 */
export async function embedQueryText(queryText: string): Promise<readonly number[] | null> {
  return (await embedTexts([queryText], 'RETRIEVAL_QUERY'))?.[0] ?? null;
}
