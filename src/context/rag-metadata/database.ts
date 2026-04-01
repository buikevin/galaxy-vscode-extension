/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Database bootstrap helpers for the RAG metadata SQLite store.
 */

import { DatabaseSync } from 'node:sqlite';
import { ensureProjectStorage, getProjectStorageInfo } from '../project-store';

/**
 * Adds newly introduced semantic chunk columns to existing databases.
 */
function ensureSemanticChunkColumns(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(semantic_chunks)`).all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  if (!existing.has('description')) {
    db.exec(`ALTER TABLE semantic_chunks ADD COLUMN description TEXT;`);
  }
  if (!existing.has('description_source')) {
    db.exec(`ALTER TABLE semantic_chunks ADD COLUMN description_source TEXT;`);
  }
}

/**
 * Opens the per-project RAG metadata database, ensures schema, and closes it after use.
 */
export function withRagMetadataDatabase<T>(workspacePath: string, fn: (db: DatabaseSync) => T): T {
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
    CREATE TABLE IF NOT EXISTS workflow_artifact_embeddings (
      artifact_id TEXT PRIMARY KEY,
      artifact_kind TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_vector TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_nodes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      label TEXT NOT NULL,
      label_lower TEXT NOT NULL,
      file_path TEXT,
      symbol_name TEXT,
      symbol_name_lower TEXT,
      route_method TEXT,
      route_path TEXT,
      route_path_lower TEXT,
      start_line INTEGER,
      end_line INTEGER,
      description TEXT,
      description_source TEXT,
      confidence REAL NOT NULL,
      provenance_json TEXT,
      source_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workspace_id ON workflow_nodes(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_nodes_label_lower ON workflow_nodes(label_lower);
    CREATE INDEX IF NOT EXISTS idx_workflow_nodes_file_path ON workflow_nodes(file_path);
    CREATE INDEX IF NOT EXISTS idx_workflow_nodes_symbol_name_lower ON workflow_nodes(symbol_name_lower);
    CREATE INDEX IF NOT EXISTS idx_workflow_nodes_route_path_lower ON workflow_nodes(route_path_lower);
    CREATE TABLE IF NOT EXISTS workflow_edges (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      label TEXT,
      label_lower TEXT,
      confidence REAL NOT NULL,
      provenance_json TEXT,
      supporting_file_path TEXT,
      supporting_symbol_name TEXT,
      supporting_symbol_name_lower TEXT,
      supporting_line INTEGER,
      source_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_edges_workspace_id ON workflow_edges(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_edges_from_node_id ON workflow_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_edges_to_node_id ON workflow_edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_edges_edge_type ON workflow_edges(edge_type);
    CREATE INDEX IF NOT EXISTS idx_workflow_edges_supporting_file_path ON workflow_edges(supporting_file_path);
    CREATE INDEX IF NOT EXISTS idx_workflow_edges_supporting_symbol_name_lower ON workflow_edges(supporting_symbol_name_lower);
    CREATE TABLE IF NOT EXISTS workflow_maps (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      map_type TEXT NOT NULL,
      entry_node_id TEXT,
      title TEXT NOT NULL,
      title_lower TEXT NOT NULL,
      summary TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_hash TEXT,
      generated_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_maps_workspace_id ON workflow_maps(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_maps_map_type ON workflow_maps(map_type);
    CREATE INDEX IF NOT EXISTS idx_workflow_maps_entry_node_id ON workflow_maps(entry_node_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_maps_title_lower ON workflow_maps(title_lower);
    CREATE TABLE IF NOT EXISTS workflow_map_sources (
      workflow_map_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_hash TEXT,
      PRIMARY KEY (workflow_map_id, source_kind, source_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_map_sources_source_ref ON workflow_map_sources(source_ref);
    CREATE TABLE IF NOT EXISTS workflow_trace_summaries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      trace_kind TEXT NOT NULL,
      entry_node_id TEXT,
      title TEXT NOT NULL,
      title_lower TEXT NOT NULL,
      query_hint TEXT,
      narrative TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_hash TEXT,
      generated_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_trace_summaries_workspace_id ON workflow_trace_summaries(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_trace_summaries_entry_node_id ON workflow_trace_summaries(entry_node_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_trace_summaries_title_lower ON workflow_trace_summaries(title_lower);
  `);
  ensureSemanticChunkColumns(db);

  try {
    return fn(db);
  } finally {
    db.close();
  }
}
