/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow graph persistence and cleanup operations.
 */

import type { WorkflowGraphSnapshot } from './entities/graph';
import {
  buildWorkflowArtifactEmbeddingId,
  serializeWorkflowProvenance,
} from './graph-helpers';
import { getProjectStorageInfo } from '../project-store';
import { withRagMetadataDatabase } from '../rag-metadata/database';

/**
 * Persists a workflow graph snapshot and keeps artifact timestamps stable when hashes do not change.
 */
export function syncWorkflowGraphSnapshot(workspacePath: string, snapshot: WorkflowGraphSnapshot): void {
  const storage = getProjectStorageInfo(workspacePath);
  const workspaceId = storage.workspaceId;
  const nodeIds = snapshot.nodes.map((node) => node.id);
  const edgeIds = snapshot.edges.map((edge) => edge.id);
  const mapIds = (snapshot.maps ?? []).map((map) => map.id);
  const traceIds = (snapshot.traceSummaries ?? []).map((trace) => trace.id);
  const scopedArtifactIds = [
    ...mapIds.map((id) => buildWorkflowArtifactEmbeddingId(workspaceId, id)),
    ...traceIds.map((id) => buildWorkflowArtifactEmbeddingId(workspaceId, id)),
  ];

  withRagMetadataDatabase(workspacePath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existingMaps = new Map(
        (db.prepare(`
          SELECT id, source_hash, generated_at, updated_at
          FROM workflow_maps
          WHERE workspace_id = ?
        `).all(workspaceId) as Array<{
          id: string;
          source_hash: string | null;
          generated_at: number;
          updated_at: number;
        }>).map((row) => [row.id, row] as const),
      );
      const existingTraces = new Map(
        (db.prepare(`
          SELECT id, source_hash, generated_at, updated_at
          FROM workflow_trace_summaries
          WHERE workspace_id = ?
        `).all(workspaceId) as Array<{
          id: string;
          source_hash: string | null;
          generated_at: number;
          updated_at: number;
        }>).map((row) => [row.id, row] as const),
      );
      const existingMapIds = [...existingMaps.keys()];

      db.prepare(
        nodeIds.length > 0
          ? `DELETE FROM workflow_nodes WHERE workspace_id = ? AND id NOT IN (${nodeIds.map(() => '?').join(',')})`
          : 'DELETE FROM workflow_nodes WHERE workspace_id = ?',
      ).run(workspaceId, ...nodeIds);
      db.prepare(
        edgeIds.length > 0
          ? `DELETE FROM workflow_edges WHERE workspace_id = ? AND id NOT IN (${edgeIds.map(() => '?').join(',')})`
          : 'DELETE FROM workflow_edges WHERE workspace_id = ?',
      ).run(workspaceId, ...edgeIds);
      db.prepare(
        mapIds.length > 0
          ? `DELETE FROM workflow_maps WHERE workspace_id = ? AND id NOT IN (${mapIds.map(() => '?').join(',')})`
          : 'DELETE FROM workflow_maps WHERE workspace_id = ?',
      ).run(workspaceId, ...mapIds);
      db.prepare(
        traceIds.length > 0
          ? `DELETE FROM workflow_trace_summaries WHERE workspace_id = ? AND id NOT IN (${traceIds.map(() => '?').join(',')})`
          : 'DELETE FROM workflow_trace_summaries WHERE workspace_id = ?',
      ).run(workspaceId, ...traceIds);
      if (existingMapIds.length > 0) {
        db.prepare(
          mapIds.length > 0
            ? `DELETE FROM workflow_map_sources WHERE workflow_map_id IN (${existingMapIds.map(() => '?').join(',')}) AND workflow_map_id NOT IN (${mapIds.map(() => '?').join(',')})`
            : `DELETE FROM workflow_map_sources WHERE workflow_map_id IN (${existingMapIds.map(() => '?').join(',')})`,
        ).run(...existingMapIds, ...mapIds);
      }
      db.prepare(
        scopedArtifactIds.length > 0
          ? `DELETE FROM workflow_artifact_embeddings WHERE artifact_id LIKE ? AND artifact_id NOT IN (${scopedArtifactIds.map(() => '?').join(',')})`
          : 'DELETE FROM workflow_artifact_embeddings WHERE artifact_id LIKE ?',
      ).run(`${workspaceId}:%`, ...scopedArtifactIds);

      const upsertNode = db.prepare(`
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
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);
      snapshot.nodes.forEach((node) => {
        upsertNode.run(
          node.id,
          node.workspaceId ?? workspaceId,
          node.nodeType,
          node.label,
          node.label.toLowerCase(),
          node.filePath ?? null,
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
          node.sourceHash ?? null,
          node.createdAt,
          node.updatedAt ?? Date.now(),
        );
      });

      const upsertEdge = db.prepare(`
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
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);
      snapshot.edges.forEach((edge) => {
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
          edge.supportingFilePath ?? null,
          edge.supportingSymbolName ?? null,
          edge.supportingSymbolName?.toLowerCase() ?? null,
          edge.supportingLine ?? null,
          edge.sourceHash ?? null,
          edge.createdAt,
          edge.updatedAt ?? Date.now(),
        );
      });

      const upsertMap = db.prepare(`
        INSERT INTO workflow_maps (
          id, workspace_id, map_type, entry_node_id, title, title_lower, summary,
          confidence, source_hash, generated_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          map_type = excluded.map_type,
          entry_node_id = excluded.entry_node_id,
          title = excluded.title,
          title_lower = excluded.title_lower,
          summary = excluded.summary,
          confidence = excluded.confidence,
          source_hash = excluded.source_hash,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
      `);
      (snapshot.maps ?? []).forEach((map) => {
        const existing = existingMaps.get(map.id);
        const sourceHash = map.sourceHash ?? null;
        const generatedAt = existing && existing.source_hash === sourceHash
          ? existing.generated_at
          : map.generatedAt;
        const updatedAt = existing && existing.source_hash === sourceHash
          ? existing.updated_at
          : map.updatedAt ?? Date.now();
        upsertMap.run(
          map.id,
          map.workspaceId ?? workspaceId,
          map.mapType,
          map.entryNodeId ?? null,
          map.title,
          map.title.toLowerCase(),
          map.summary,
          map.confidence ?? 0.8,
          sourceHash,
          generatedAt,
          updatedAt,
        );
      });

      const insertMapSource = db.prepare(`
        INSERT INTO workflow_map_sources (workflow_map_id, source_kind, source_ref, source_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workflow_map_id, source_kind, source_ref) DO UPDATE SET
          source_hash = excluded.source_hash
      `);
      (snapshot.mapSources ?? []).forEach((source) => {
        insertMapSource.run(
          source.workflowMapId,
          source.sourceKind,
          source.sourceRef,
          source.sourceHash ?? null,
        );
      });

      const upsertTrace = db.prepare(`
        INSERT INTO workflow_trace_summaries (
          id, workspace_id, trace_kind, entry_node_id, title, title_lower, query_hint,
          narrative, confidence, source_hash, generated_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          trace_kind = excluded.trace_kind,
          entry_node_id = excluded.entry_node_id,
          title = excluded.title,
          title_lower = excluded.title_lower,
          query_hint = excluded.query_hint,
          narrative = excluded.narrative,
          confidence = excluded.confidence,
          source_hash = excluded.source_hash,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
      `);
      (snapshot.traceSummaries ?? []).forEach((trace) => {
        const existing = existingTraces.get(trace.id);
        const sourceHash = trace.sourceHash ?? null;
        const generatedAt = existing && existing.source_hash === sourceHash
          ? existing.generated_at
          : trace.generatedAt;
        const updatedAt = existing && existing.source_hash === sourceHash
          ? existing.updated_at
          : trace.updatedAt ?? Date.now();
        upsertTrace.run(
          trace.id,
          trace.workspaceId ?? workspaceId,
          trace.traceKind,
          trace.entryNodeId ?? null,
          trace.title,
          trace.title.toLowerCase(),
          trace.queryHint ?? null,
          trace.narrative,
          trace.confidence ?? 0.8,
          sourceHash,
          generatedAt,
          updatedAt,
        );
      });

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

/**
 * Clears workflow graph data for a single workspace without touching other projects.
 */
export function clearWorkflowGraph(workspacePath: string): void {
  const storage = getProjectStorageInfo(workspacePath);
  withRagMetadataDatabase(workspacePath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        DELETE FROM workflow_map_sources
        WHERE workflow_map_id IN (
          SELECT id FROM workflow_maps WHERE workspace_id = ?
        )
      `).run(storage.workspaceId);
      db.prepare(`DELETE FROM workflow_nodes WHERE workspace_id = ?`).run(storage.workspaceId);
      db.prepare(`DELETE FROM workflow_edges WHERE workspace_id = ?`).run(storage.workspaceId);
      db.prepare(`DELETE FROM workflow_maps WHERE workspace_id = ?`).run(storage.workspaceId);
      db.prepare(`DELETE FROM workflow_trace_summaries WHERE workspace_id = ?`).run(storage.workspaceId);
      db.prepare(`DELETE FROM workflow_artifact_embeddings WHERE artifact_id LIKE ?`).run(`${storage.workspaceId}:%`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}
