/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Semantic indexing and Chroma synchronization for workflow map artifacts.
 */

import { createChromaClient, resolveChromaUrl } from '../../chroma-manager';
import type {
  WorkflowArtifactRecord,
  WorkflowGraphQueryResult,
  WorkflowMapSummary,
  WorkflowTraceSummary,
} from '../entities/graph';
import {
  MANUAL_WORKFLOW_EMBEDDING_FUNCTION,
  WORKFLOW_ARTIFACT_CHROMA_TIMEOUT_MS,
  WORKFLOW_ARTIFACT_EMBED_BATCH_SIZE,
  WORKFLOW_ARTIFACT_QUERY_EMBED_TIMEOUT_MS,
} from '../entities/constants';
import { cosineSimilarityEmbedding, embedTexts, getGeminiEmbeddingModel } from '../../gemini-embeddings';
import {
  buildWorkflowArtifactCollectionName,
  buildWorkflowArtifactDocument,
  buildWorkflowArtifactEmbeddingId,
  combineWorkflowArtifactScore,
  mapWorkflowMapRow,
  mapWorkflowTraceRow,
  parseStoredWorkflowEmbedding,
  withWorkflowTimeout,
} from '../graph-helpers';
import { getProjectStorageInfo } from '../../project-store';
import { withRagMetadataDatabase } from '../../rag-metadata/database';

const workflowArtifactPrimeByWorkspace = new Map<string, Promise<void>>();

/**
 * Loads workflow maps and trace summaries for semantic artifact retrieval.
 */
function loadWorkflowArtifacts(workspacePath: string): Readonly<{
  workspaceId: string;
  maps: readonly WorkflowMapSummary[];
  traces: readonly WorkflowTraceSummary[];
  artifacts: readonly WorkflowArtifactRecord[];
}> {
  const storage = getProjectStorageInfo(workspacePath);
  return withRagMetadataDatabase(workspacePath, (db) => {
    const maps = Object.freeze(
      (db.prepare(`
        SELECT id, map_type, entry_node_id, title, summary, confidence, source_hash, generated_at, updated_at
        FROM workflow_maps
        WHERE workspace_id = ?
        ORDER BY confidence DESC, updated_at DESC
      `).all(storage.workspaceId) as Array<Parameters<typeof mapWorkflowMapRow>[0]>).map((row) => mapWorkflowMapRow(row)),
    );
    const traces = Object.freeze(
      (db.prepare(`
        SELECT id, trace_kind, entry_node_id, title, query_hint, narrative, confidence, source_hash, generated_at, updated_at
        FROM workflow_trace_summaries
        WHERE workspace_id = ?
        ORDER BY confidence DESC, updated_at DESC
      `).all(storage.workspaceId) as Array<Parameters<typeof mapWorkflowTraceRow>[0]>).map((row) => mapWorkflowTraceRow(row)),
    );

    const artifacts: WorkflowArtifactRecord[] = [];
    maps.forEach((map) => {
      artifacts.push(Object.freeze({
        id: map.id,
        kind: 'workflow_map',
        workspaceId: storage.workspaceId,
        ...(map.entryNodeId ? { entryNodeId: map.entryNodeId } : {}),
        title: map.title,
        content: map.summary,
        confidence: map.confidence,
        sourceHash: map.sourceHash ?? '',
        updatedAt: map.updatedAt,
      }));
    });
    traces.forEach((trace) => {
      artifacts.push(Object.freeze({
        id: trace.id,
        kind: 'workflow_trace',
        workspaceId: storage.workspaceId,
        ...(trace.entryNodeId ? { entryNodeId: trace.entryNodeId } : {}),
        title: trace.title,
        content: trace.narrative,
        ...(trace.queryHint ? { queryHint: trace.queryHint } : {}),
        confidence: trace.confidence,
        sourceHash: trace.sourceHash ?? '',
        updatedAt: trace.updatedAt,
      }));
    });

    return Object.freeze({
      workspaceId: storage.workspaceId,
      maps,
      traces,
      artifacts: Object.freeze(artifacts),
    });
  });
}

/**
 * Loads reusable workflow artifact embeddings from SQLite.
 */
function getCachedWorkflowArtifactEmbeddings(opts: {
  workspacePath: string;
  workspaceId: string;
  artifacts: readonly WorkflowArtifactRecord[];
}): ReadonlyMap<string, readonly number[]> {
  if (opts.artifacts.length === 0) {
    return new Map<string, readonly number[]>();
  }

  return withRagMetadataDatabase(opts.workspacePath, (db) => {
    const scopedIds = opts.artifacts.map((artifact) => buildWorkflowArtifactEmbeddingId(opts.workspaceId, artifact.id));
    const rows = db.prepare(`
      SELECT artifact_id, source_hash, embedding_model, embedding_vector, indexed_at
      FROM workflow_artifact_embeddings
      WHERE artifact_id IN (${scopedIds.map(() => '?').join(',')})
    `).all(...scopedIds) as Array<{
      artifact_id: string;
      source_hash: string;
      embedding_model: string;
      embedding_vector: string;
      indexed_at: number;
    }>;

    const rowMap = new Map(rows.map((row) => [row.artifact_id, row] as const));
    const model = getGeminiEmbeddingModel();
    const cached = new Map<string, readonly number[]>();

    opts.artifacts.forEach((artifact) => {
      const existing = rowMap.get(buildWorkflowArtifactEmbeddingId(opts.workspaceId, artifact.id));
      const parsedEmbedding = existing ? parseStoredWorkflowEmbedding(existing.embedding_vector) : null;
      if (
        existing &&
        existing.embedding_model === model &&
        existing.source_hash === artifact.sourceHash &&
        parsedEmbedding &&
        existing.indexed_at >= artifact.updatedAt
      ) {
        cached.set(artifact.id, parsedEmbedding);
      }
    });

    return cached;
  });
}

/**
 * Generates and caches missing workflow artifact embeddings.
 */
async function ensureWorkflowArtifactEmbeddings(opts: {
  workspacePath: string;
  workspaceId: string;
  artifacts: readonly WorkflowArtifactRecord[];
}): Promise<ReadonlyMap<string, readonly number[]>> {
  const cached = new Map(getCachedWorkflowArtifactEmbeddings(opts));
  const pending = opts.artifacts.filter((artifact) => !cached.has(artifact.id));
  if (pending.length === 0) {
    return cached;
  }

  const model = getGeminiEmbeddingModel();
  for (let index = 0; index < pending.length; index += WORKFLOW_ARTIFACT_EMBED_BATCH_SIZE) {
    const batch = pending.slice(index, index + WORKFLOW_ARTIFACT_EMBED_BATCH_SIZE);
    const embeddings = await embedTexts(batch.map((artifact) => buildWorkflowArtifactDocument(artifact)), 'RETRIEVAL_DOCUMENT');
    if (!embeddings || embeddings.length !== batch.length) {
      continue;
    }

    withRagMetadataDatabase(opts.workspacePath, (db) => {
      const upsert = db.prepare(`
        INSERT INTO workflow_artifact_embeddings (
          artifact_id, artifact_kind, source_hash, embedding_model, embedding_vector, indexed_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          artifact_kind = excluded.artifact_kind,
          source_hash = excluded.source_hash,
          embedding_model = excluded.embedding_model,
          embedding_vector = excluded.embedding_vector,
          indexed_at = excluded.indexed_at
      `);

      batch.forEach((artifact, batchIndex) => {
        const embedding = embeddings[batchIndex];
        if (!embedding || embedding.length === 0) {
          return;
        }
        const frozen = Object.freeze([...embedding]);
        cached.set(artifact.id, frozen);
        upsert.run(
          buildWorkflowArtifactEmbeddingId(opts.workspaceId, artifact.id),
          artifact.kind,
          artifact.sourceHash,
          model,
          JSON.stringify(frozen),
          Date.now(),
        );
      });
    });
  }

  return cached;
}

/**
 * Mirrors workflow artifacts into Chroma for semantic queries.
 */
async function syncWorkflowArtifactsToChroma(opts: {
  workspacePath: string;
  workspaceId: string;
  artifacts: readonly WorkflowArtifactRecord[];
  embeddings: ReadonlyMap<string, readonly number[]>;
}): Promise<void> {
  const chromaPath = await resolveChromaUrl(opts.workspacePath);
  if (!chromaPath) {
    return;
  }

  try {
    const client = createChromaClient(chromaPath);
    const collection = await withWorkflowTimeout(
      client.getOrCreateCollection({
        name: buildWorkflowArtifactCollectionName(opts.workspaceId),
        embeddingFunction: MANUAL_WORKFLOW_EMBEDDING_FUNCTION,
      }),
      WORKFLOW_ARTIFACT_CHROMA_TIMEOUT_MS,
    );
    if (!collection) {
      return;
    }

    const ids: string[] = [];
    const documents: string[] = [];
    const embeddings: number[][] = [];
    const metadatas: Record<string, string | number | boolean | null>[] = [];
    opts.artifacts.forEach((artifact) => {
      const embedding = opts.embeddings.get(artifact.id);
      if (!embedding || embedding.length === 0) {
        return;
      }
      ids.push(artifact.id);
      documents.push(buildWorkflowArtifactDocument(artifact));
      embeddings.push([...embedding]);
      metadatas.push({
        artifactKind: artifact.kind,
        entryNodeId: artifact.entryNodeId ?? null,
        title: artifact.title,
        updatedAt: artifact.updatedAt,
      });
    });

    if (ids.length === 0) {
      return;
    }

    await withWorkflowTimeout(
      collection.upsert({ ids, documents, embeddings, metadatas }),
      WORKFLOW_ARTIFACT_CHROMA_TIMEOUT_MS,
    );
  } catch {
    // Best effort only.
  }
}

/**
 * Queries Chroma for workflow artifact scores.
 */
async function queryChromaWorkflowArtifactScores(opts: {
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
    const collection = await withWorkflowTimeout(
      client.getOrCreateCollection({
        name: buildWorkflowArtifactCollectionName(opts.workspaceId),
        embeddingFunction: MANUAL_WORKFLOW_EMBEDDING_FUNCTION,
      }),
      WORKFLOW_ARTIFACT_CHROMA_TIMEOUT_MS,
    );
    if (!collection) {
      return new Map<string, number>();
    }

    const result = await withWorkflowTimeout(
      collection.query({
        queryEmbeddings: [[...opts.queryEmbedding]],
        nResults: opts.limit,
        include: ['distances'],
      }),
      WORKFLOW_ARTIFACT_CHROMA_TIMEOUT_MS,
    );
    if (!result) {
      return new Map<string, number>();
    }

    const scores = new Map<string, number>();
    const ids = result.ids[0] ?? [];
    const distances = result.distances?.[0] ?? [];
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
 * Prewarms workflow artifact embeddings and mirrors them into Chroma.
 */
export async function primeWorkflowArtifactSemanticIndex(workspacePath: string): Promise<void> {
  const storage = getProjectStorageInfo(workspacePath);
  const existing = workflowArtifactPrimeByWorkspace.get(storage.workspaceId);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const loaded = loadWorkflowArtifacts(workspacePath);
    if (loaded.artifacts.length === 0) {
      return;
    }
    const embeddings = await ensureWorkflowArtifactEmbeddings({
      workspacePath,
      workspaceId: loaded.workspaceId,
      artifacts: loaded.artifacts,
    });
    await syncWorkflowArtifactsToChroma({
      workspacePath,
      workspaceId: loaded.workspaceId,
      artifacts: loaded.artifacts,
      embeddings,
    });
  })().finally(() => {
    workflowArtifactPrimeByWorkspace.delete(storage.workspaceId);
  });

  workflowArtifactPrimeByWorkspace.set(storage.workspaceId, task);
  return task;
}

/**
 * Reranks workflow maps and traces using lexical, local embedding, and Chroma scores.
 */
export async function rerankWorkflowArtifactMatches(opts: {
  workspacePath: string;
  queryText: string;
  limit: number;
  lexicalResult: WorkflowGraphQueryResult;
}): Promise<Readonly<Pick<WorkflowGraphQueryResult, 'maps' | 'traces'>>> {
  if (!opts.queryText.trim()) {
    return Object.freeze({
      maps: opts.lexicalResult.maps,
      traces: opts.lexicalResult.traces,
    });
  }

  const loaded = loadWorkflowArtifacts(opts.workspacePath);
  if (loaded.artifacts.length === 0) {
    return Object.freeze({
      maps: opts.lexicalResult.maps,
      traces: opts.lexicalResult.traces,
    });
  }

  const cachedEmbeddings = getCachedWorkflowArtifactEmbeddings({
    workspacePath: opts.workspacePath,
    workspaceId: loaded.workspaceId,
    artifacts: loaded.artifacts,
  });
  if (cachedEmbeddings.size === 0) {
    void primeWorkflowArtifactSemanticIndex(opts.workspacePath);
    return Object.freeze({
      maps: opts.lexicalResult.maps,
      traces: opts.lexicalResult.traces,
    });
  }
  if (cachedEmbeddings.size < loaded.artifacts.length) {
    void primeWorkflowArtifactSemanticIndex(opts.workspacePath);
  }

  const queryEmbeddings = await withWorkflowTimeout(
    embedTexts([opts.queryText], 'RETRIEVAL_QUERY'),
    WORKFLOW_ARTIFACT_QUERY_EMBED_TIMEOUT_MS,
  );
  const queryEmbedding = queryEmbeddings?.[0];
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return Object.freeze({
      maps: opts.lexicalResult.maps,
      traces: opts.lexicalResult.traces,
    });
  }

  const localSemanticScores = new Map<string, number>();
  loaded.artifacts.forEach((artifact) => {
    const embedding = cachedEmbeddings.get(artifact.id);
    if (!embedding || embedding.length === 0) {
      return;
    }
    localSemanticScores.set(artifact.id, cosineSimilarityEmbedding(queryEmbedding, embedding));
  });

  const chromaScores = await queryChromaWorkflowArtifactScores({
    workspacePath: opts.workspacePath,
    workspaceId: loaded.workspaceId,
    queryEmbedding,
    limit: Math.max(opts.limit * 3, 8),
  });

  const lexicalMapScores = new Map(opts.lexicalResult.maps.map((entry) => [entry.map.id, entry.score] as const));
  const lexicalTraceScores = new Map(opts.lexicalResult.traces.map((entry) => [entry.trace.id, entry.score] as const));

  const maps = Object.freeze(
    loaded.maps
      .map((map) => Object.freeze({
        map,
        score: combineWorkflowArtifactScore({
          lexicalScore: lexicalMapScores.get(map.id) ?? 0,
          localSemanticScore: localSemanticScores.get(map.id) ?? 0,
          chromaScore: chromaScores.get(map.id) ?? 0,
          confidence: map.confidence,
        }),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.map.title.localeCompare(right.map.title))
      .slice(0, opts.limit),
  );

  const traces = Object.freeze(
    loaded.traces
      .map((trace) => Object.freeze({
        trace,
        score: combineWorkflowArtifactScore({
          lexicalScore: lexicalTraceScores.get(trace.id) ?? 0,
          localSemanticScore: localSemanticScores.get(trace.id) ?? 0,
          chromaScore: chromaScores.get(trace.id) ?? 0,
          confidence: trace.confidence,
        }),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.trace.title.localeCompare(right.trace.title))
      .slice(0, opts.limit),
  );

  return Object.freeze({ maps, traces });
}
