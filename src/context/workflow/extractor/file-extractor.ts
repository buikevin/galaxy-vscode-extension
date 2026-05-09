/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-07
 * @modify date 2026-05-07
 * @desc Per-file workflow graph extraction dispatcher with content-hash caching and stale-node cleanup.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { WorkflowExtractorAdapter, WorkflowGraphContribution } from '../entities/extractor';
import { reactTsxWorkflowExtractorAdapter } from './adapters/react-tsx';
import { typeScriptWorkflowExtractorAdapter } from './adapters/typescript';
import { resolveWorkspaceRelativePath } from './files';
import { serializeWorkflowProvenance } from '../graph-helpers';
import { getProjectStorageInfo } from '../../project-store';
import { withRagMetadataDatabase } from '../../rag-metadata/database';

/**
 * Outcome describing what happened during a per-file extraction request.
 */
export type WorkflowFileExtractionResult = Readonly<{
  /** Workspace-relative path of the file processed (null when the file was rejected). */
  relativePath: string | null;
  /** Adapter id that handled the file or null when no adapter applied. */
  adapterId: string | null;
  /** True when the cached row matched the source hash and no work was performed. */
  cached: boolean;
  /** True when the file content was extracted and persisted. */
  reindexed: boolean;
  /** Number of nodes persisted for this file (0 when cached or no contribution). */
  nodeCount: number;
  /** Number of edges persisted for this file (0 when cached or no contribution). */
  edgeCount: number;
}>;

/**
 * Options for the per-file extraction entry point.
 */
export type ExtractWorkflowForFileOptions = Readonly<{
  /** Force re-extraction even when the source hash matches the cached entry. */
  force?: boolean;
}>;

const FILE_LEVEL_ADAPTERS: readonly WorkflowExtractorAdapter[] = Object.freeze([
  reactTsxWorkflowExtractorAdapter,
  typeScriptWorkflowExtractorAdapter,
]);

/**
 * Selects file-level adapters that declare support for a relative path.
 *
 * @param relativePath Workspace-relative file path under consideration.
 * @returns Ordered list of adapters whose `supportsFile` returns true (most-specific first).
 */
function selectFileLevelAdapters(relativePath: string): readonly WorkflowExtractorAdapter[] {
  return FILE_LEVEL_ADAPTERS.filter((adapter) =>
    typeof adapter.supportsFile === 'function' && adapter.extractFromFile && adapter.supportsFile(relativePath),
  );
}

/**
 * Computes a stable content hash for a file's source text.
 *
 * @param content UTF-8 source text of the file.
 * @returns Hex-encoded SHA-1 of the content (matches the adapter's internal hash conventions).
 */
function hashFileContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * Reads file metadata required by the per-file extraction pipeline.
 *
 * @param absolutePath Absolute filesystem path of the source file.
 * @returns File stats and decoded content, or null when the file is missing/unreadable.
 */
function loadFileForExtraction(absolutePath: string): { mtimeMs: number; content: string } | null {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return null;
    }
    const content = fs.readFileSync(absolutePath, 'utf-8');
    return { mtimeMs: stat.mtimeMs, content };
  } catch {
    return null;
  }
}

/**
 * Merges contributions from multiple adapters into a single contribution.
 *
 * @param contributions Per-adapter contributions for the same file.
 * @returns Combined contribution with deduplicated nodes/edges keyed by id.
 */
function mergeContributions(contributions: readonly WorkflowGraphContribution[]): WorkflowGraphContribution {
  const nodes = new Map<string, WorkflowGraphContribution['nodes'][number]>();
  const edges = new Map<string, WorkflowGraphContribution['edges'][number]>();
  contributions.forEach((contribution) => {
    contribution.nodes.forEach((node) => {
      if (!nodes.has(node.id)) {
        nodes.set(node.id, node);
      }
    });
    contribution.edges.forEach((edge) => {
      if (!edges.has(edge.id)) {
        edges.set(edge.id, edge);
      }
    });
  });
  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

const SELECT_FILE_INDEX_ROW = `
  SELECT source_hash, adapter_id, node_ids_json, edge_ids_json
  FROM workflow_file_index
  WHERE workspace_id = ? AND file_path = ?
`;

const UPSERT_FILE_INDEX_ROW = `
  INSERT INTO workflow_file_index (
    workspace_id, file_path, source_hash, adapter_id, mtime_ms, indexed_at,
    node_ids_json, edge_ids_json, node_count, edge_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(workspace_id, file_path) DO UPDATE SET
    source_hash = excluded.source_hash,
    adapter_id = excluded.adapter_id,
    mtime_ms = excluded.mtime_ms,
    indexed_at = excluded.indexed_at,
    node_ids_json = excluded.node_ids_json,
    edge_ids_json = excluded.edge_ids_json,
    node_count = excluded.node_count,
    edge_count = excluded.edge_count
`;

const UPSERT_NODE_SQL = `
  INSERT INTO workflow_nodes (
    id, workspace_id, node_type, label, label_lower, file_path, symbol_name, symbol_name_lower,
    route_method, route_path, route_path_lower, start_line, end_line, description, description_source,
    confidence, provenance_json, source_hash, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    node_type = excluded.node_type,
    label = excluded.label,
    label_lower = excluded.label_lower,
    file_path = excluded.file_path,
    symbol_name = excluded.symbol_name,
    symbol_name_lower = excluded.symbol_name_lower,
    route_method = excluded.route_method,
    route_path = excluded.route_path,
    route_path_lower = excluded.route_path_lower,
    start_line = excluded.start_line,
    end_line = excluded.end_line,
    description = excluded.description,
    description_source = excluded.description_source,
    confidence = excluded.confidence,
    provenance_json = excluded.provenance_json,
    source_hash = excluded.source_hash,
    updated_at = excluded.updated_at
`;

const UPSERT_EDGE_SQL = `
  INSERT INTO workflow_edges (
    id, workspace_id, from_node_id, to_node_id, edge_type, label, label_lower, confidence,
    provenance_json, supporting_file_path, supporting_symbol_name, supporting_symbol_name_lower,
    supporting_line, source_hash, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    from_node_id = excluded.from_node_id,
    to_node_id = excluded.to_node_id,
    edge_type = excluded.edge_type,
    label = excluded.label,
    label_lower = excluded.label_lower,
    confidence = excluded.confidence,
    provenance_json = excluded.provenance_json,
    supporting_file_path = excluded.supporting_file_path,
    supporting_symbol_name = excluded.supporting_symbol_name,
    supporting_symbol_name_lower = excluded.supporting_symbol_name_lower,
    supporting_line = excluded.supporting_line,
    source_hash = excluded.source_hash,
    updated_at = excluded.updated_at
`;

/**
 * Returns the empty extraction result used for files that were rejected before any work was done.
 *
 * @param relativePath Workspace-relative path of the rejected file (or null).
 * @returns Frozen result indicating no extraction occurred.
 */
function buildEmptyResult(relativePath: string | null): WorkflowFileExtractionResult {
  return Object.freeze({
    relativePath,
    adapterId: null,
    cached: false,
    reindexed: false,
    nodeCount: 0,
    edgeCount: 0,
  });
}

/**
 * Extracts and persists workflow graph data scoped to a single source file.
 *
 * Skips work when the file's content hash matches the cached `workflow_file_index` row.
 * On change, removes nodes/edges previously contributed by this file before inserting new ones,
 * keeping the per-file footprint accurate even when symbols are renamed or deleted.
 *
 * @param workspacePath Absolute workspace root path.
 * @param filePath Absolute or workspace-relative path of the source file to process.
 * @param opts Optional flags such as `force` to bypass the cache hit shortcut.
 * @returns Outcome describing whether the file was cached, reindexed, or skipped.
 */
export async function extractWorkflowForFile(
  workspacePath: string,
  filePath: string,
  opts: ExtractWorkflowForFileOptions = {},
): Promise<WorkflowFileExtractionResult> {
  const relativePath = resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!relativePath) {
    return buildEmptyResult(null);
  }
  const adapters = selectFileLevelAdapters(relativePath);
  if (adapters.length === 0) {
    return buildEmptyResult(relativePath);
  }
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workspacePath, relativePath);
  const fileMeta = loadFileForExtraction(absolutePath);
  if (!fileMeta) {
    return buildEmptyResult(relativePath);
  }
  const sourceHash = hashFileContent(fileMeta.content);
  const adapterId = adapters.map((adapter) => adapter.id).join('+');

  const storage = getProjectStorageInfo(workspacePath);
  const workspaceId = storage.workspaceId;

  const cacheHit = withRagMetadataDatabase(workspacePath, (db) => {
    const row = db.prepare(SELECT_FILE_INDEX_ROW).get(workspaceId, relativePath) as
      | { source_hash: string; adapter_id: string; node_ids_json: string; edge_ids_json: string }
      | undefined;
    return row && row.source_hash === sourceHash && row.adapter_id === adapterId ? row : null;
  });
  if (cacheHit && !opts.force) {
    return Object.freeze({
      relativePath,
      adapterId,
      cached: true,
      reindexed: false,
      nodeCount: 0,
      edgeCount: 0,
    });
  }

  const contributions = await Promise.all(
    adapters.map((adapter) => adapter.extractFromFile!(workspacePath, relativePath)),
  );
  const merged = mergeContributions(contributions);
  const newNodeIds = merged.nodes.map((node) => node.id);
  const newEdgeIds = merged.edges.map((edge) => edge.id);
  const now = Date.now();

  withRagMetadataDatabase(workspacePath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare(SELECT_FILE_INDEX_ROW).get(workspaceId, relativePath) as
        | { source_hash: string; adapter_id: string; node_ids_json: string; edge_ids_json: string }
        | undefined;
      const previousNodeIds: readonly string[] = previous ? safeParseIdArray(previous.node_ids_json) : [];
      const previousEdgeIds: readonly string[] = previous ? safeParseIdArray(previous.edge_ids_json) : [];
      const newNodeIdSet = new Set(newNodeIds);
      const newEdgeIdSet = new Set(newEdgeIds);
      const orphanNodeIds = previousNodeIds.filter((id) => !newNodeIdSet.has(id));
      const orphanEdgeIds = previousEdgeIds.filter((id) => !newEdgeIdSet.has(id));
      if (orphanNodeIds.length > 0) {
        const placeholders = orphanNodeIds.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM workflow_nodes WHERE workspace_id = ? AND id IN (${placeholders})`,
        ).run(workspaceId, ...orphanNodeIds);
      }
      if (orphanEdgeIds.length > 0) {
        const placeholders = orphanEdgeIds.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM workflow_edges WHERE workspace_id = ? AND id IN (${placeholders})`,
        ).run(workspaceId, ...orphanEdgeIds);
      }

      const upsertNode = db.prepare(UPSERT_NODE_SQL);
      merged.nodes.forEach((node) => {
        upsertNode.run(
          node.id,
          node.workspaceId ?? workspaceId,
          node.nodeType,
          node.label,
          node.label.toLowerCase(),
          node.filePath ?? relativePath,
          node.symbolName ?? null,
          node.symbolName?.toLowerCase() ?? null,
          node.routeMethod ?? null,
          node.routePath ?? null,
          node.routePath?.toLowerCase() ?? null,
          node.startLine ?? null,
          node.endLine ?? null,
          node.description ?? null,
          node.descriptionSource ?? null,
          node.confidence ?? 0.85,
          serializeWorkflowProvenance(node.provenance),
          node.sourceHash ?? sourceHash,
          node.createdAt ?? now,
          node.updatedAt ?? now,
        );
      });

      const upsertEdge = db.prepare(UPSERT_EDGE_SQL);
      merged.edges.forEach((edge) => {
        upsertEdge.run(
          edge.id,
          edge.workspaceId ?? workspaceId,
          edge.fromNodeId,
          edge.toNodeId,
          edge.edgeType,
          edge.label ?? null,
          edge.label?.toLowerCase() ?? null,
          edge.confidence ?? 0.8,
          serializeWorkflowProvenance(edge.provenance),
          edge.supportingFilePath ?? relativePath,
          edge.supportingSymbolName ?? null,
          edge.supportingSymbolName?.toLowerCase() ?? null,
          edge.supportingLine ?? null,
          edge.sourceHash ?? sourceHash,
          edge.createdAt ?? now,
          edge.updatedAt ?? now,
        );
      });

      db.prepare(UPSERT_FILE_INDEX_ROW).run(
        workspaceId,
        relativePath,
        sourceHash,
        adapterId,
        Math.round(fileMeta.mtimeMs),
        now,
        JSON.stringify(newNodeIds),
        JSON.stringify(newEdgeIds),
        newNodeIds.length,
        newEdgeIds.length,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });

  return Object.freeze({
    relativePath,
    adapterId,
    cached: false,
    reindexed: true,
    nodeCount: newNodeIds.length,
    edgeCount: newEdgeIds.length,
  });
}

/**
 * Removes the per-file index row and all nodes/edges contributed by a file.
 *
 * Use when a file is deleted or fully reverted, ensuring the workflow graph stays accurate.
 *
 * @param workspacePath Absolute workspace root path.
 * @param filePath Absolute or workspace-relative path of the file whose contributions should be removed.
 * @returns True when a row was removed, false when the file had no cached contribution.
 */
export function clearWorkflowForFile(workspacePath: string, filePath: string): boolean {
  const relativePath = resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!relativePath) {
    return false;
  }
  const storage = getProjectStorageInfo(workspacePath);
  const workspaceId = storage.workspaceId;
  return withRagMetadataDatabase(workspacePath, (db) => {
    const row = db.prepare(SELECT_FILE_INDEX_ROW).get(workspaceId, relativePath) as
      | { node_ids_json: string; edge_ids_json: string }
      | undefined;
    if (!row) {
      return false;
    }
    const nodeIds = safeParseIdArray(row.node_ids_json);
    const edgeIds = safeParseIdArray(row.edge_ids_json);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (nodeIds.length > 0) {
        const placeholders = nodeIds.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM workflow_nodes WHERE workspace_id = ? AND id IN (${placeholders})`,
        ).run(workspaceId, ...nodeIds);
      }
      if (edgeIds.length > 0) {
        const placeholders = edgeIds.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM workflow_edges WHERE workspace_id = ? AND id IN (${placeholders})`,
        ).run(workspaceId, ...edgeIds);
      }
      db.prepare(`DELETE FROM workflow_file_index WHERE workspace_id = ? AND file_path = ?`).run(
        workspaceId,
        relativePath,
      );
      db.exec('COMMIT');
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

/**
 * Parses a JSON-encoded id list, returning an empty array on malformed input.
 *
 * @param raw JSON string previously stored in `workflow_file_index`.
 * @returns Decoded id array or empty array when parsing fails.
 */
function safeParseIdArray(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((value) => typeof value === 'string') as string[]) : [];
  } catch {
    return [];
  }
}
