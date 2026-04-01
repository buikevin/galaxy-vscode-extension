/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Task-memory persistence and retrieval helpers for the RAG metadata store.
 */

import { DatabaseSync } from 'node:sqlite';
import { createChromaClient, resolveChromaUrl } from '../chroma-manager';
import { cosineSimilarityEmbedding, embedTexts, getGeminiEmbeddingModel } from '../gemini-embeddings';
import type {
  TaskMemoryEntryRecord,
  TaskMemoryEntrySummary,
  TaskMemoryFindingRecord,
  TaskMemoryFindingSummary,
} from '../entities/rag-metadata';
import { withRagMetadataDatabase } from './database';
import { buildTaskMemoryEmbeddingDocument, parseStoredEmbedding, safeParseStringArray, shouldPersistTaskMemoryEntry, tokenizeQuery } from './helpers';
import {
  MANUAL_EMBEDDING_FUNCTION,
  TASK_MEMORY_CHROMA_TIMEOUT_MS,
  TASK_MEMORY_EMBED_BATCH_SIZE,
  TASK_MEMORY_MAX_ENTRIES,
  TASK_MEMORY_RETENTION_DAYS,
  TASK_MEMORY_SEMANTIC_CANDIDATE_LIMIT,
} from './constants';
/**
 * Prunes old or excess task memory rows from the SQLite store.
 */
function pruneTaskMemory(db: DatabaseSync): void {
  const retentionCutoff = Date.now() - TASK_MEMORY_RETENTION_DAYS * 24 * 60 * 60_000;
  db.prepare(`
    DELETE FROM task_memory_findings
    WHERE entry_turn_id IN (
      SELECT turn_id FROM task_memory_entries WHERE created_at < ?
    )
  `).run(retentionCutoff);
  db.prepare(`
    DELETE FROM task_memory_artifacts
    WHERE entry_turn_id IN (
      SELECT turn_id FROM task_memory_entries WHERE created_at < ?
    )
  `).run(retentionCutoff);
  db.prepare(`
    DELETE FROM task_memory_embeddings
    WHERE entry_turn_id IN (
      SELECT turn_id FROM task_memory_entries WHERE created_at < ?
    )
  `).run(retentionCutoff);
  db.prepare(`DELETE FROM task_memory_entries WHERE created_at < ?`).run(retentionCutoff);

  const rows = db.prepare(`
    SELECT turn_id
    FROM task_memory_entries
    ORDER BY created_at DESC
    LIMIT -1 OFFSET ?
  `).all(TASK_MEMORY_MAX_ENTRIES) as Array<{ turn_id: string }>;
  if (rows.length === 0) {
    return;
  }
  const staleTurnIds = rows.map((row) => row.turn_id);
  const placeholders = staleTurnIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM task_memory_findings WHERE entry_turn_id IN (${placeholders})`).run(...staleTurnIds);
  db.prepare(`DELETE FROM task_memory_artifacts WHERE entry_turn_id IN (${placeholders})`).run(...staleTurnIds);
  db.prepare(`DELETE FROM task_memory_embeddings WHERE entry_turn_id IN (${placeholders})`).run(...staleTurnIds);
  db.prepare(`DELETE FROM task_memory_entries WHERE turn_id IN (${placeholders})`).run(...staleTurnIds);
}

/**
 * Persists one task memory entry when it passes quality filters.
 */
export function appendTaskMemoryEntry(workspacePath: string, entry: TaskMemoryEntryRecord): void {
  if (!shouldPersistTaskMemoryEntry(entry)) {
    return;
  }
  withRagMetadataDatabase(workspacePath, (db) => {
    db.prepare(`
      INSERT INTO task_memory_entries (
        turn_id, workspace_id, turn_kind, user_intent, assistant_conclusion,
        files_json, attachments_json, confidence, freshness_score, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        turn_kind = excluded.turn_kind,
        user_intent = excluded.user_intent,
        assistant_conclusion = excluded.assistant_conclusion,
        files_json = excluded.files_json,
        attachments_json = excluded.attachments_json,
        confidence = excluded.confidence,
        freshness_score = excluded.freshness_score,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      entry.turnId,
      entry.workspaceId,
      entry.turnKind,
      entry.userIntent,
      entry.assistantConclusion,
      entry.filesJson ?? null,
      entry.attachmentsJson ?? null,
      entry.confidence ?? 0.8,
      entry.freshnessScore ?? 1,
      entry.createdAt,
      Date.now(),
    );
    pruneTaskMemory(db);
  });
}

/**
 * Replaces findings associated with one task memory entry.
 */
export function replaceTaskMemoryFindings(
  workspacePath: string,
  entryTurnId: string,
  findings: readonly TaskMemoryFindingRecord[],
): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    db.prepare(`DELETE FROM task_memory_findings WHERE entry_turn_id = ?`).run(entryTurnId);
    const insertFinding = db.prepare(`
      INSERT INTO task_memory_findings (
        id, entry_turn_id, kind, summary, file_path, line, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    findings.forEach((finding) => {
      insertFinding.run(
        finding.id,
        finding.entryTurnId,
        finding.kind,
        finding.summary,
        finding.filePath ?? null,
        finding.line ?? null,
        finding.status ?? 'open',
        finding.createdAt,
      );
    });
  });
}

/**
 * Updates the status of one persisted task-memory finding.
 */
export function updateTaskMemoryFindingStatus(
  workspacePath: string,
  findingId: string,
  status: 'open' | 'resolved' | 'dismissed',
): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    db.prepare(`
      UPDATE task_memory_findings
      SET status = ?
      WHERE id = ?
    `).run(status, findingId);
  });
}

/**
 * Queries similar task memory rows from Chroma using a precomputed query embedding.
 */
async function queryChromaTaskMemory(opts: {
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
        name: `galaxy-task-memory-v2-${opts.workspaceId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`,
        embeddingFunction: MANUAL_EMBEDDING_FUNCTION,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TASK_MEMORY_CHROMA_TIMEOUT_MS)),
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
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TASK_MEMORY_CHROMA_TIMEOUT_MS)),
    ]);
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
 * Ensures each candidate task-memory entry has a current embedding vector.
 */
async function ensureTaskMemoryEmbeddings(opts: {
  workspacePath: string;
  entries: readonly Readonly<{
    turnId: string;
    workspaceId: string;
    turnKind: string;
    userIntent: string;
    assistantConclusion: string;
    files: readonly string[];
    attachments: readonly string[];
    updatedAt: number;
    createdAt: number;
  }>[];
}): Promise<ReadonlyMap<string, readonly number[]>> {
  const model = getGeminiEmbeddingModel();
  const cached = new Map<string, readonly number[]>();
  const pending: Array<(typeof opts.entries)[number]> = [];

  withRagMetadataDatabase(opts.workspacePath, (db) => {
    const rows = db.prepare(`
      SELECT entry_turn_id, embedding_model, embedding_vector, indexed_at
      FROM task_memory_embeddings
      WHERE entry_turn_id IN (${opts.entries.map(() => '?').join(',')})
    `).all(...opts.entries.map((entry) => entry.turnId)) as Array<{
      entry_turn_id: string;
      embedding_model: string;
      embedding_vector: string;
      indexed_at: number;
    }>;
    const rowMap = new Map(rows.map((row) => [row.entry_turn_id, row]));
    opts.entries.forEach((entry) => {
      const existing = rowMap.get(entry.turnId);
      const parsedEmbedding = existing ? parseStoredEmbedding(existing.embedding_vector) : null;
      if (existing && existing.embedding_model === model && parsedEmbedding && existing.indexed_at >= entry.updatedAt) {
        cached.set(entry.turnId, parsedEmbedding);
      } else {
        pending.push(entry);
      }
    });
  });

  for (let index = 0; index < pending.length; index += TASK_MEMORY_EMBED_BATCH_SIZE) {
    const batch = pending.slice(index, index + TASK_MEMORY_EMBED_BATCH_SIZE);
    const embeddings = await embedTexts(batch.map((entry) => buildTaskMemoryEmbeddingDocument(entry)), 'RETRIEVAL_DOCUMENT');
    if (!embeddings || embeddings.length !== batch.length) {
      continue;
    }
    withRagMetadataDatabase(opts.workspacePath, (db) => {
      const upsert = db.prepare(`
        INSERT INTO task_memory_embeddings (entry_turn_id, embedding_model, embedding_vector, indexed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(entry_turn_id) DO UPDATE SET
          embedding_model = excluded.embedding_model,
          embedding_vector = excluded.embedding_vector,
          indexed_at = excluded.indexed_at
      `);
      batch.forEach((entry, batchIndex) => {
        const embedding = embeddings[batchIndex];
        if (!embedding || embedding.length === 0) {
          return;
        }
        const frozen = Object.freeze([...embedding]);
        cached.set(entry.turnId, frozen);
        upsert.run(entry.turnId, model, JSON.stringify(frozen), Date.now());
      });
    });
  }

  return cached;
}

/**
 * Mirrors task-memory entries to Chroma using the precomputed embeddings.
 */
async function syncTaskMemoryToChroma(opts: {
  workspacePath: string;
  workspaceId: string;
  entries: readonly Readonly<{
    turnId: string;
    turnKind: string;
    userIntent: string;
    assistantConclusion: string;
    files: readonly string[];
    attachments: readonly string[];
    createdAt: number;
  }>[];
  embeddings: ReadonlyMap<string, readonly number[]>;
}): Promise<void> {
  const chromaPath = await resolveChromaUrl(opts.workspacePath);
  if (!chromaPath) {
    return;
  }

  try {
    const client = createChromaClient(chromaPath);
    const collection = await Promise.race([
      client.getOrCreateCollection({
        name: `galaxy-task-memory-v2-${opts.workspaceId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`,
        embeddingFunction: MANUAL_EMBEDDING_FUNCTION,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TASK_MEMORY_CHROMA_TIMEOUT_MS)),
    ]);
    if (!collection) {
      return;
    }

    const ids: string[] = [];
    const documents: string[] = [];
    const embeddings: number[][] = [];
    const metadatas: Record<string, string | number | boolean | null>[] = [];
    opts.entries.forEach((entry) => {
      const embedding = opts.embeddings.get(entry.turnId);
      if (!embedding || embedding.length === 0) {
        return;
      }
      ids.push(entry.turnId);
      documents.push(buildTaskMemoryEmbeddingDocument(entry));
      embeddings.push([...embedding]);
      metadatas.push({
        turnKind: entry.turnKind,
        fileCount: entry.files.length,
        attachmentCount: entry.attachments.length,
        createdAt: entry.createdAt,
      });
    });
    if (ids.length === 0) {
      return;
    }
    await Promise.race([
      collection.upsert({ ids, documents, embeddings, metadatas }),
      new Promise<void>((resolve) => setTimeout(() => resolve(), TASK_MEMORY_CHROMA_TIMEOUT_MS)),
    ]);
  } catch {
    // Best effort only.
  }
}

/**
 * Retrieves the most relevant task-memory entries and related findings for a query.
 */
export async function queryRelevantTaskMemory(
  workspacePath: string,
  queryText: string,
  limit = 3,
): Promise<Readonly<{
  entries: readonly TaskMemoryEntrySummary[];
  findings: readonly TaskMemoryFindingSummary[];
}>> {
  const tokens = tokenizeQuery(queryText);
  const allEntries = withRagMetadataDatabase(workspacePath, (db) => {
    const allEntries = db.prepare(`
      SELECT turn_id, workspace_id, turn_kind, user_intent, assistant_conclusion, files_json, attachments_json,
             confidence, freshness_score, created_at, updated_at
      FROM task_memory_entries
      ORDER BY created_at DESC
      LIMIT ?
    `).all(TASK_MEMORY_SEMANTIC_CANDIDATE_LIMIT) as Array<{
      turn_id: string;
      workspace_id: string;
      turn_kind: string;
      user_intent: string;
      assistant_conclusion: string;
      files_json: string | null;
      attachments_json: string | null;
      confidence: number;
      freshness_score: number;
      created_at: number;
      updated_at: number;
    }>;
    return Object.freeze(allEntries.map((entry) => Object.freeze({
      turnId: entry.turn_id,
      workspaceId: entry.workspace_id,
      turnKind: entry.turn_kind,
      userIntent: entry.user_intent,
      assistantConclusion: entry.assistant_conclusion,
      files: safeParseStringArray(entry.files_json),
      attachments: safeParseStringArray(entry.attachments_json),
      confidence: entry.confidence,
      freshnessScore: entry.freshness_score,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    })));
  });

  if (allEntries.length === 0) {
    return Object.freeze({ entries: Object.freeze([]), findings: Object.freeze([]) });
  }

  const embeddings = await ensureTaskMemoryEmbeddings({ workspacePath, entries: allEntries });
  void syncTaskMemoryToChroma({
    workspacePath,
    workspaceId: allEntries[0]!.workspaceId,
    entries: allEntries,
    embeddings,
  });
  const queryEmbedding = queryText.trim()
    ? (await embedTexts([queryText], 'RETRIEVAL_QUERY'))?.[0] ?? null
    : null;
  const chromaScores = queryEmbedding
    ? await queryChromaTaskMemory({
        workspacePath,
        workspaceId: allEntries[0]!.workspaceId,
        queryEmbedding,
        limit: Math.max(limit * 3, 8),
      })
    : new Map<string, number>();

  const scoredEntries = allEntries
    .map((entry) => {
      const haystack = `${entry.userIntent}\n${entry.assistantConclusion}`.toLowerCase();
      const tokenHits = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      const fileHits = tokens.reduce(
        (sum, token) => sum + (entry.files.some((filePath) => filePath.toLowerCase().includes(token)) ? 1 : 0),
        0,
      );
      const attachmentHits = tokens.reduce(
        (sum, token) => sum + (entry.attachments.some((item) => item.toLowerCase().includes(token)) ? 1 : 0),
        0,
      );
      const ageMs = Date.now() - entry.createdAt;
      const recencyBoost = ageMs <= 60 * 60_000 ? 3 : ageMs <= 24 * 60 * 60_000 ? 2 : ageMs <= 7 * 24 * 60 * 60_000 ? 1 : 0;
      const freshnessWeight = Math.max(0.35, Math.min(1.25, entry.freshnessScore || 1));
      const lexicalScore = (tokenHits * 5 + fileHits * 4 + attachmentHits * 3 + recencyBoost) * freshnessWeight;
      const localSemanticScore = queryEmbedding
        ? cosineSimilarityEmbedding(queryEmbedding, embeddings.get(entry.turnId) ?? null)
        : 0;
      const chromaScore = chromaScores.get(entry.turnId) ?? 0;
      return {
        entry: Object.freeze({
          turnId: entry.turnId,
          turnKind: entry.turnKind,
          userIntent: entry.userIntent,
          assistantConclusion: entry.assistantConclusion,
          files: entry.files,
          attachments: entry.attachments,
          confidence: entry.confidence,
          freshnessScore: entry.freshnessScore,
          createdAt: entry.createdAt,
        } satisfies TaskMemoryEntrySummary),
        score: lexicalScore + Math.max(localSemanticScore, chromaScore) * 9,
      };
    })
    .filter((item) => item.score > 0 || tokens.length === 0)
    .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
    .slice(0, limit)
    .map((item) => item.entry);

  const entryTurnIds = scoredEntries.map((entry) => entry.turnId);
  const findings = withRagMetadataDatabase(workspacePath, (db) => entryTurnIds.length > 0
    ? (db.prepare(
        `SELECT id, entry_turn_id, kind, summary, file_path, line, status, created_at
         FROM task_memory_findings
         WHERE entry_turn_id IN (${entryTurnIds.map(() => '?').join(',')})
         ORDER BY created_at DESC
         LIMIT 12`,
      ).all(...entryTurnIds) as Array<{
        id: string;
        entry_turn_id: string;
        kind: string;
        summary: string;
        file_path: string | null;
        line: number | null;
        status: string;
        created_at: number;
      }>)
    : []);

  return Object.freeze({
    entries: Object.freeze(scoredEntries),
    findings: Object.freeze(
      findings.map((finding) =>
        Object.freeze({
          id: finding.id,
          entryTurnId: finding.entry_turn_id,
          kind: finding.kind,
          summary: finding.summary,
          ...(finding.file_path ? { filePath: finding.file_path } : {}),
          ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
          status: finding.status,
          createdAt: finding.created_at,
        } satisfies TaskMemoryFindingSummary),
      ),
    ),
  });
}
