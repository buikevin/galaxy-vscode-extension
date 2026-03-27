import { DatabaseSync } from 'node:sqlite';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';

type SyntaxMetadataRecord = Readonly<{
  relativePath: string;
  language: string;
  mtimeMs: number;
  imports: readonly string[];
  exports: readonly string[];
  symbols: readonly Readonly<{
    name: string;
    kind: string;
    exported: boolean;
    line: number;
    signature: string;
  }>[];
}>;

type SemanticMetadataChunk = Readonly<{
  id: string;
  filePath: string;
  title: string;
  kind: string;
  symbolName?: string;
  exported?: boolean;
  startLine?: number;
  endLine?: number;
  mtimeMs: number;
  embeddingModel?: string;
  indexedAt: number;
}>;

type ToolEvidenceMetadata = Readonly<{
  evidenceId: string;
  toolName: string;
  success: boolean;
  stale: boolean;
  capturedAt: number;
  summary: string;
  targetPath?: string;
  turnId: string;
}>;

type ReadCacheRecord = Readonly<{
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  readMode: string;
  offset: number;
  limit: number;
  content: string;
  metaJson?: string;
}>;

export type TaskMemoryEntryRecord = Readonly<{
  workspaceId: string;
  turnId: string;
  turnKind: 'analysis' | 'implementation' | 'review' | 'validation' | 'repair';
  userIntent: string;
  assistantConclusion: string;
  filesJson?: string;
  attachmentsJson?: string;
  confidence?: number;
  freshnessScore?: number;
  createdAt: number;
}>;

const TASK_MEMORY_MIN_ASSISTANT_CHARS = 24;
const TASK_MEMORY_RETENTION_DAYS = 45;
const TASK_MEMORY_MAX_ENTRIES = 250;

export type TaskMemoryFindingRecord = Readonly<{
  id: string;
  entryTurnId: string;
  kind: 'accepted_finding' | 'review_finding' | 'validation_failure' | 'decision';
  summary: string;
  filePath?: string;
  line?: number;
  status?: 'open' | 'resolved' | 'dismissed';
  createdAt: number;
}>;

export type TaskMemoryEntrySummary = Readonly<{
  turnId: string;
  turnKind: string;
  userIntent: string;
  assistantConclusion: string;
  files: readonly string[];
  attachments: readonly string[];
  confidence: number;
  freshnessScore: number;
  createdAt: number;
}>;

export type TaskMemoryFindingSummary = Readonly<{
  id: string;
  entryTurnId: string;
  kind: string;
  summary: string;
  filePath?: string;
  line?: number;
  status: string;
  createdAt: number;
}>;

function tokenizeQuery(text: string): readonly string[] {
  return Object.freeze(
    [...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .filter((token) => token.length >= 2),
    )].slice(0, 12),
  );
}

function normalizeTaskMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function shouldPersistTaskMemoryEntry(entry: TaskMemoryEntryRecord): boolean {
  const assistantConclusion = normalizeTaskMemoryText(entry.assistantConclusion);
  const userIntent = normalizeTaskMemoryText(entry.userIntent);
  if (assistantConclusion.length < TASK_MEMORY_MIN_ASSISTANT_CHARS) {
    return false;
  }
  if (!userIntent) {
    return false;
  }
  const rejectedPatterns = [
    /^no final assistant response\.?$/i,
    /^attempting automatic repair/i,
    /^running (validation|review)/i,
  ];
  return !rejectedPatterns.some((pattern) => pattern.test(assistantConclusion));
}

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

function withDatabase<T>(workspacePath: string, fn: (db: DatabaseSync) => T): T {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  const db = new DatabaseSync(storage.ragMetadataDbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS syntax_files (
      relative_path TEXT PRIMARY KEY,
      language TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      import_count INTEGER NOT NULL,
      export_count INTEGER NOT NULL,
      symbol_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS syntax_symbols (
      relative_path TEXT NOT NULL,
      name TEXT NOT NULL,
      name_lower TEXT NOT NULL,
      kind TEXT NOT NULL,
      exported INTEGER NOT NULL,
      line INTEGER NOT NULL,
      signature TEXT NOT NULL,
      PRIMARY KEY (relative_path, name, line)
    );
    CREATE INDEX IF NOT EXISTS idx_syntax_symbols_name_lower ON syntax_symbols(name_lower);
    CREATE TABLE IF NOT EXISTS semantic_chunks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      title_lower TEXT NOT NULL,
      symbol_name TEXT,
      symbol_name_lower TEXT,
      exported INTEGER NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      mtime_ms INTEGER NOT NULL,
      embedding_model TEXT,
      indexed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_chunks_file_path ON semantic_chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_semantic_chunks_symbol_name_lower ON semantic_chunks(symbol_name_lower);
    CREATE TABLE IF NOT EXISTS tool_evidence_meta (
      evidence_id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      success INTEGER NOT NULL,
      stale INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      summary TEXT NOT NULL,
      target_path TEXT,
      turn_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_evidence_target_path ON tool_evidence_meta(target_path);
    CREATE TABLE IF NOT EXISTS read_cache (
      file_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      read_mode TEXT NOT NULL,
      offset_value INTEGER NOT NULL,
      limit_value INTEGER NOT NULL,
      content TEXT NOT NULL,
      meta_json TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (file_path, mtime_ms, size_bytes, read_mode, offset_value, limit_value)
    );
    CREATE INDEX IF NOT EXISTS idx_read_cache_file_path ON read_cache(file_path);
    CREATE TABLE IF NOT EXISTS task_memory_entries (
      turn_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_kind TEXT NOT NULL,
      user_intent TEXT NOT NULL,
      assistant_conclusion TEXT NOT NULL,
      files_json TEXT,
      attachments_json TEXT,
      confidence REAL NOT NULL,
      freshness_score REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_memory_entries_created_at ON task_memory_entries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_memory_entries_turn_kind ON task_memory_entries(turn_kind);
    CREATE TABLE IF NOT EXISTS task_memory_findings (
      id TEXT PRIMARY KEY,
      entry_turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      file_path TEXT,
      line INTEGER,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_memory_findings_entry_turn_id ON task_memory_findings(entry_turn_id);
    CREATE TABLE IF NOT EXISTS task_memory_artifacts (
      id TEXT PRIMARY KEY,
      entry_turn_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_memory_artifacts_entry_turn_id ON task_memory_artifacts(entry_turn_id);
    CREATE TABLE IF NOT EXISTS task_memory_embeddings (
      entry_turn_id TEXT PRIMARY KEY,
      embedding_model TEXT NOT NULL,
      embedding_vector TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );
  `);

  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function syncSyntaxMetadata(
  workspacePath: string,
  records: readonly SyntaxMetadataRecord[],
): void {
  withDatabase(workspacePath, (db) => {
    const now = Date.now();
    const filePaths = records.map((record) => record.relativePath);
    const deleteFiles = db.prepare(
      filePaths.length > 0
        ? `DELETE FROM syntax_files WHERE relative_path NOT IN (${filePaths.map(() => '?').join(',')})`
        : 'DELETE FROM syntax_files',
    );
    const deleteSymbols = db.prepare(
      filePaths.length > 0
        ? `DELETE FROM syntax_symbols WHERE relative_path NOT IN (${filePaths.map(() => '?').join(',')})`
        : 'DELETE FROM syntax_symbols',
    );
    if (filePaths.length > 0) {
      deleteFiles.run(...filePaths);
      deleteSymbols.run(...filePaths);
    } else {
      deleteFiles.run();
      deleteSymbols.run();
    }

    const upsertFile = db.prepare(`
      INSERT INTO syntax_files (relative_path, language, mtime_ms, import_count, export_count, symbol_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relative_path) DO UPDATE SET
        language = excluded.language,
        mtime_ms = excluded.mtime_ms,
        import_count = excluded.import_count,
        export_count = excluded.export_count,
        symbol_count = excluded.symbol_count,
        updated_at = excluded.updated_at
    `);
    const deleteFileSymbols = db.prepare('DELETE FROM syntax_symbols WHERE relative_path = ?');
    const insertSymbol = db.prepare(`
      INSERT INTO syntax_symbols (relative_path, name, name_lower, kind, exported, line, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    records.forEach((record) => {
      upsertFile.run(
        record.relativePath,
        record.language,
        record.mtimeMs,
        record.imports.length,
        record.exports.length,
        record.symbols.length,
        now,
      );
      deleteFileSymbols.run(record.relativePath);
      record.symbols.forEach((symbol) => {
        insertSymbol.run(
          record.relativePath,
          symbol.name,
          symbol.name.toLowerCase(),
          symbol.kind,
          symbol.exported ? 1 : 0,
          symbol.line,
          symbol.signature,
        );
      });
    });
  });
}

export function syncSemanticMetadata(
  workspacePath: string,
  chunks: readonly SemanticMetadataChunk[],
): void {
  withDatabase(workspacePath, (db) => {
    const chunkIds = chunks.map((chunk) => chunk.id);
    const deleteStmt = db.prepare(
      chunkIds.length > 0
        ? `DELETE FROM semantic_chunks WHERE id NOT IN (${chunkIds.map(() => '?').join(',')})`
        : 'DELETE FROM semantic_chunks',
    );
    if (chunkIds.length > 0) {
      deleteStmt.run(...chunkIds);
    } else {
      deleteStmt.run();
    }

    const upsertChunk = db.prepare(`
      INSERT INTO semantic_chunks (
        id, file_path, kind, title, title_lower, symbol_name, symbol_name_lower,
        exported, start_line, end_line, mtime_ms, embedding_model, indexed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        kind = excluded.kind,
        title = excluded.title,
        title_lower = excluded.title_lower,
        symbol_name = excluded.symbol_name,
        symbol_name_lower = excluded.symbol_name_lower,
        exported = excluded.exported,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        mtime_ms = excluded.mtime_ms,
        embedding_model = excluded.embedding_model,
        indexed_at = excluded.indexed_at
    `);

    chunks.forEach((chunk) => {
      upsertChunk.run(
        chunk.id,
        chunk.filePath,
        chunk.kind,
        chunk.title,
        chunk.title.toLowerCase(),
        chunk.symbolName ?? null,
        chunk.symbolName?.toLowerCase() ?? null,
        chunk.exported ? 1 : 0,
        chunk.startLine ?? null,
        chunk.endLine ?? null,
        chunk.mtimeMs,
        chunk.embeddingModel ?? null,
        chunk.indexedAt,
      );
    });
  });
}

export function appendToolEvidenceMetadata(workspacePath: string, evidence: ToolEvidenceMetadata): void {
  withDatabase(workspacePath, (db) => {
    db.prepare(`
      INSERT INTO tool_evidence_meta (evidence_id, tool_name, success, stale, captured_at, summary, target_path, turn_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        tool_name = excluded.tool_name,
        success = excluded.success,
        stale = excluded.stale,
        captured_at = excluded.captured_at,
        summary = excluded.summary,
        target_path = excluded.target_path,
        turn_id = excluded.turn_id
    `).run(
      evidence.evidenceId,
      evidence.toolName,
      evidence.success ? 1 : 0,
      evidence.stale ? 1 : 0,
      evidence.capturedAt,
      evidence.summary,
      evidence.targetPath ?? null,
      evidence.turnId,
    );
  });
}

export function clearToolEvidenceMetadata(workspacePath: string): void {
  withDatabase(workspacePath, (db) => {
    db.exec(`DELETE FROM tool_evidence_meta;`);
  });
}

export function getCachedReadResult(
  workspacePath: string,
  opts: Readonly<{
    filePath: string;
    mtimeMs: number;
    sizeBytes: number;
    readMode: string;
    offset: number;
    limit: number;
  }>,
): Readonly<{ content: string; meta?: Readonly<Record<string, unknown>> }> | null {
  return withDatabase(workspacePath, (db) => {
    const row = db.prepare(`
      SELECT content, meta_json
      FROM read_cache
      WHERE file_path = ?
        AND mtime_ms = ?
        AND size_bytes = ?
        AND read_mode = ?
        AND offset_value = ?
        AND limit_value = ?
      LIMIT 1
    `).get(
      opts.filePath,
      opts.mtimeMs,
      opts.sizeBytes,
      opts.readMode,
      opts.offset,
      opts.limit,
    ) as { content: string; meta_json: string | null } | undefined;

    if (!row) {
      return null;
    }

    let parsedMeta: Readonly<Record<string, unknown>> | undefined;
    if (row.meta_json) {
      try {
        parsedMeta = Object.freeze(JSON.parse(row.meta_json) as Record<string, unknown>);
      } catch {
        parsedMeta = undefined;
      }
    }

    return Object.freeze({
      content: row.content,
      ...(parsedMeta ? { meta: parsedMeta } : {}),
    });
  });
}

export function storeReadCache(workspacePath: string, record: ReadCacheRecord): void {
  withDatabase(workspacePath, (db) => {
    db.prepare(`
      INSERT INTO read_cache (
        file_path, mtime_ms, size_bytes, read_mode, offset_value, limit_value, content, meta_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, mtime_ms, size_bytes, read_mode, offset_value, limit_value) DO UPDATE SET
        content = excluded.content,
        meta_json = excluded.meta_json,
        updated_at = excluded.updated_at
    `).run(
      record.filePath,
      record.mtimeMs,
      record.sizeBytes,
      record.readMode,
      record.offset,
      record.limit,
      record.content,
      record.metaJson ?? null,
      Date.now(),
    );

    db.prepare(`
      DELETE FROM read_cache
      WHERE file_path = ?
        AND (mtime_ms != ? OR size_bytes != ?)
    `).run(record.filePath, record.mtimeMs, record.sizeBytes);
  });
}

export function queryRagHintPaths(
  workspacePath: string,
  queryText: string,
  limit = 6,
): readonly string[] {
  const tokens = tokenizeQuery(queryText);
  if (tokens.length === 0) {
    return Object.freeze([]);
  }

  return withDatabase(workspacePath, (db) => {
    const scores = new Map<string, number>();
    const bump = (filePath: string, amount: number): void => {
      scores.set(filePath, (scores.get(filePath) ?? 0) + amount);
    };

    const symbolStmt = db.prepare(`
      SELECT relative_path, name_lower, exported
      FROM syntax_symbols
      WHERE name_lower LIKE ?
      LIMIT 24
    `);
    const fileStmt = db.prepare(`
      SELECT relative_path
      FROM syntax_files
      WHERE lower(relative_path) LIKE ?
      LIMIT 24
    `);
    const chunkStmt = db.prepare(`
      SELECT file_path, title_lower, symbol_name_lower
      FROM semantic_chunks
      WHERE title_lower LIKE ? OR symbol_name_lower LIKE ?
      LIMIT 24
    `);
    const evidenceStmt = db.prepare(`
      SELECT target_path, tool_name, summary, captured_at
      FROM tool_evidence_meta
      WHERE success = 1
        AND stale = 0
        AND target_path IS NOT NULL
        AND (lower(target_path) LIKE ? OR lower(summary) LIKE ?)
      ORDER BY captured_at DESC
      LIMIT 24
    `);

    tokens.forEach((token) => {
      const like = `%${token}%`;
      for (const row of symbolStmt.all(like) as Array<{ relative_path: string; name_lower: string; exported: number }>) {
        bump(row.relative_path, row.name_lower === token ? 10 : row.exported ? 7 : 5);
      }
      for (const row of fileStmt.all(like) as Array<{ relative_path: string }>) {
        bump(row.relative_path, 4);
      }
      for (const row of chunkStmt.all(like, like) as Array<{ file_path: string; title_lower: string; symbol_name_lower: string | null }>) {
        const exactSymbol = row.symbol_name_lower === token;
        const exactTitle = row.title_lower === token;
        bump(row.file_path, exactSymbol ? 8 : exactTitle ? 6 : 3);
      }
      for (const row of evidenceStmt.all(like, like) as Array<{ target_path: string; tool_name: string; summary: string; captured_at: number }>) {
        const ageMs = Date.now() - row.captured_at;
        const recencyBoost = ageMs <= 5 * 60_000
          ? 10
          : ageMs <= 60 * 60_000
            ? 7
            : ageMs <= 24 * 60 * 60_000
              ? 4
              : 2;
        const pathLower = row.target_path.toLowerCase();
        const summaryLower = row.summary.toLowerCase();
        const exactPath = pathLower.endsWith(`/${token}`) || pathLower.endsWith(`\\${token}`) || pathLower === token;
        const summaryHit = summaryLower.includes(token);
        const toolBoost = row.tool_name === 'read_file' || row.tool_name === 'edit_file' || row.tool_name === 'edit_file_range' || row.tool_name === 'write_file'
          ? 2
          : 0;
        bump(row.target_path, recencyBoost + (exactPath ? 4 : summaryHit ? 2 : 0) + toolBoost);
      }
    });

    return Object.freeze(
      [...scores.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([filePath]) => filePath),
    );
  });
}

export function appendTaskMemoryEntry(workspacePath: string, entry: TaskMemoryEntryRecord): void {
  if (!shouldPersistTaskMemoryEntry(entry)) {
    return;
  }
  withDatabase(workspacePath, (db) => {
    db.prepare(`
      INSERT INTO task_memory_entries (
        turn_id,
        workspace_id,
        turn_kind,
        user_intent,
        assistant_conclusion,
        files_json,
        attachments_json,
        confidence,
        freshness_score,
        created_at,
        updated_at
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

export function replaceTaskMemoryFindings(
  workspacePath: string,
  entryTurnId: string,
  findings: readonly TaskMemoryFindingRecord[],
): void {
  withDatabase(workspacePath, (db) => {
    db.prepare(`DELETE FROM task_memory_findings WHERE entry_turn_id = ?`).run(entryTurnId);
    const insertFinding = db.prepare(`
      INSERT INTO task_memory_findings (
        id,
        entry_turn_id,
        kind,
        summary,
        file_path,
        line,
        status,
        created_at
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

export function updateTaskMemoryFindingStatus(
  workspacePath: string,
  findingId: string,
  status: 'open' | 'resolved' | 'dismissed',
): void {
  withDatabase(workspacePath, (db) => {
    db.prepare(`
      UPDATE task_memory_findings
      SET status = ?
      WHERE id = ?
    `).run(status, findingId);
  });
}

function safeParseStringArray(raw: string | null): readonly string[] {
  if (!raw) {
    return Object.freeze([]);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Object.freeze(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return Object.freeze([]);
  }
}

export function queryRelevantTaskMemory(
  workspacePath: string,
  queryText: string,
  limit = 3,
): Readonly<{
  entries: readonly TaskMemoryEntrySummary[];
  findings: readonly TaskMemoryFindingSummary[];
}> {
  const tokens = tokenizeQuery(queryText);
  return withDatabase(workspacePath, (db) => {
    const allEntries = db.prepare(`
      SELECT turn_id, turn_kind, user_intent, assistant_conclusion, files_json, attachments_json,
             confidence, freshness_score, created_at
      FROM task_memory_entries
      ORDER BY created_at DESC
      LIMIT 40
    `).all() as Array<{
      turn_id: string;
      turn_kind: string;
      user_intent: string;
      assistant_conclusion: string;
      files_json: string | null;
      attachments_json: string | null;
      confidence: number;
      freshness_score: number;
      created_at: number;
    }>;

    const scoredEntries = allEntries
      .map((entry) => {
        const haystack = `${entry.user_intent}\n${entry.assistant_conclusion}`.toLowerCase();
        const files = safeParseStringArray(entry.files_json);
        const attachments = safeParseStringArray(entry.attachments_json);
        const tokenHits = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
        const fileHits = tokens.reduce(
          (sum, token) => sum + (files.some((filePath) => filePath.toLowerCase().includes(token)) ? 1 : 0),
          0,
        );
        const attachmentHits = tokens.reduce(
          (sum, token) => sum + (attachments.some((item) => item.toLowerCase().includes(token)) ? 1 : 0),
          0,
        );
        const ageMs = Date.now() - entry.created_at;
        const recencyBoost = ageMs <= 60 * 60_000 ? 3 : ageMs <= 24 * 60 * 60_000 ? 2 : ageMs <= 7 * 24 * 60 * 60_000 ? 1 : 0;
        const freshnessWeight = Math.max(0.35, Math.min(1.25, entry.freshness_score || 1));
        const score = (tokenHits * 5 + fileHits * 4 + attachmentHits * 3 + recencyBoost) * freshnessWeight;
        return {
          entry: Object.freeze({
            turnId: entry.turn_id,
            turnKind: entry.turn_kind,
            userIntent: entry.user_intent,
            assistantConclusion: entry.assistant_conclusion,
            files,
            attachments,
            confidence: entry.confidence,
            freshnessScore: entry.freshness_score,
            createdAt: entry.created_at,
          } satisfies TaskMemoryEntrySummary),
          score,
        };
      })
      .filter((item) => item.score > 0 || tokens.length === 0)
      .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
      .slice(0, limit)
      .map((item) => item.entry);

    const entryTurnIds = scoredEntries.map((entry) => entry.turnId);
    const findings = entryTurnIds.length > 0
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
      : [];

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
  });
}
