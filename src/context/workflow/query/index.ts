/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow graph lexical and hybrid query operations.
 */

import type {
  WorkflowGraphQueryResult,
  WorkflowSubgraphResult,
} from '../entities';
import {
  mapWorkflowEdgeRow,
  mapWorkflowMapRow,
  mapWorkflowNodeRow,
  mapWorkflowTraceRow,
  sortWorkflowScoredResults,
  tokenizeWorkflowQuery,
} from '../graph-helpers';
import { getProjectStorageInfo } from '../../project-store';
import { withRagMetadataDatabase } from '../../rag-metadata/database';
import { rerankWorkflowArtifactMatches } from '../artifact-semantic';

/**
 * Loads workflow nodes that satisfy one SQL predicate.
 */
function queryWorkflowNodesByPredicate(
  workspacePath: string,
  whereClause: string,
  params: readonly (string | number | null)[],
  limit: number,
) {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const workspaceId = getProjectStorageInfo(workspacePath).workspaceId;
    const rows = db.prepare(`
      SELECT id, node_type, label, file_path, symbol_name, route_method, route_path, start_line, end_line,
             description, description_source, confidence, provenance_json, source_hash, created_at, updated_at
      FROM workflow_nodes
      WHERE workspace_id = ?
        AND ${whereClause}
      ORDER BY confidence DESC, updated_at DESC, created_at DESC
      LIMIT ?
    `).all(workspaceId, ...params, limit) as Array<Parameters<typeof mapWorkflowNodeRow>[0]>;
    return Object.freeze(rows.map((row) => mapWorkflowNodeRow(row)));
  });
}

/**
 * Queries workflow nodes, maps, and traces using lexical matching.
 */
export function queryWorkflowGraph(
  workspacePath: string,
  queryText: string,
  limit = 5,
): WorkflowGraphQueryResult {
  const tokens = tokenizeWorkflowQuery(queryText);
  if (tokens.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      maps: Object.freeze([]),
      traces: Object.freeze([]),
    });
  }

  return withRagMetadataDatabase(workspacePath, (db) => {
    const workspaceId = getProjectStorageInfo(workspacePath).workspaceId;
    const nodeScores = new Map<string, number>();
    const mapScores = new Map<string, number>();
    const traceScores = new Map<string, number>();
    const nodeRows = new Map<string, ReturnType<typeof mapWorkflowNodeRow>>();
    const mapRows = new Map<string, ReturnType<typeof mapWorkflowMapRow>>();
    const traceRows = new Map<string, ReturnType<typeof mapWorkflowTraceRow>>();

    const nodeStmt = db.prepare(`
      SELECT id, node_type, label, file_path, symbol_name, route_method, route_path, start_line, end_line,
             description, description_source, confidence, provenance_json, source_hash, created_at, updated_at
      FROM workflow_nodes
      WHERE workspace_id = ?
        AND (
          label_lower LIKE ?
          OR symbol_name_lower LIKE ?
          OR route_path_lower LIKE ?
          OR lower(coalesce(file_path, '')) LIKE ?
        )
      LIMIT 32
    `);
    const mapStmt = db.prepare(`
      SELECT id, map_type, entry_node_id, title, summary, confidence, source_hash, generated_at, updated_at
      FROM workflow_maps
      WHERE workspace_id = ?
        AND (title_lower LIKE ? OR lower(summary) LIKE ?)
      LIMIT 24
    `);
    const traceStmt = db.prepare(`
      SELECT id, trace_kind, entry_node_id, title, query_hint, narrative, confidence, source_hash, generated_at, updated_at
      FROM workflow_trace_summaries
      WHERE workspace_id = ?
        AND (
          title_lower LIKE ?
          OR lower(narrative) LIKE ?
          OR lower(coalesce(query_hint, '')) LIKE ?
        )
      LIMIT 24
    `);

    const bump = (scores: Map<string, number>, id: string, amount: number): void => {
      scores.set(id, (scores.get(id) ?? 0) + amount);
    };

    tokens.forEach((token) => {
      const like = `%${token}%`;
      for (const row of nodeStmt.all(workspaceId, like, like, like, like) as Array<Parameters<typeof mapWorkflowNodeRow>[0]>) {
        nodeRows.set(row.id, mapWorkflowNodeRow(row));
        const exactLabel = row.label.toLowerCase() === token;
        const exactSymbol = row.symbol_name?.toLowerCase() === token;
        const exactRoute = row.route_path?.toLowerCase() === token;
        bump(nodeScores, row.id, exactLabel || exactSymbol ? 10 : exactRoute ? 9 : 4);
      }
      for (const row of mapStmt.all(workspaceId, like, like) as Array<Parameters<typeof mapWorkflowMapRow>[0]>) {
        mapRows.set(row.id, mapWorkflowMapRow(row));
        const exactTitle = row.title.toLowerCase() === token;
        bump(mapScores, row.id, exactTitle ? 9 : 4);
      }
      for (const row of traceStmt.all(workspaceId, like, like, like) as Array<Parameters<typeof mapWorkflowTraceRow>[0]>) {
        traceRows.set(row.id, mapWorkflowTraceRow(row));
        const exactTitle = row.title.toLowerCase() === token;
        bump(traceScores, row.id, exactTitle ? 8 : 3);
      }
    });

    return Object.freeze({
      nodes: Object.freeze(
        sortWorkflowScoredResults(nodeRows.entries(), nodeScores, limit).map(({ value, score }) => Object.freeze({ node: value, score })),
      ),
      maps: Object.freeze(
        sortWorkflowScoredResults(mapRows.entries(), mapScores, limit).map(({ value, score }) => Object.freeze({ map: value, score })),
      ),
      traces: Object.freeze(
        sortWorkflowScoredResults(traceRows.entries(), traceScores, limit).map(({ value, score }) => Object.freeze({ trace: value, score })),
      ),
    });
  });
}

/**
 * Queries workflow graph using lexical nodes plus semantic artifact reranking.
 */
export async function queryWorkflowGraphHybrid(
  workspacePath: string,
  queryText: string,
  limit = 5,
): Promise<WorkflowGraphQueryResult> {
  const lexicalResult = queryWorkflowGraph(workspacePath, queryText, limit);
  const rerankedArtifacts = await rerankWorkflowArtifactMatches({
    workspacePath,
    queryText,
    limit,
    lexicalResult,
  });
  return Object.freeze({
    nodes: lexicalResult.nodes,
    maps: rerankedArtifacts.maps,
    traces: rerankedArtifacts.traces,
  });
}

/**
 * Queries workflow nodes that originate from one source file.
 */
export function queryWorkflowNodesByFilePath(
  workspacePath: string,
  filePath: string,
  limit = 12,
) {
  return queryWorkflowNodesByPredicate(
    workspacePath,
    `lower(coalesce(file_path, '')) = lower(?)`,
    [filePath],
    limit,
  );
}

/**
 * Queries workflow nodes associated with one symbol name.
 */
export function queryWorkflowNodesBySymbolName(
  workspacePath: string,
  symbolName: string,
  limit = 12,
) {
  return queryWorkflowNodesByPredicate(
    workspacePath,
    `symbol_name_lower = lower(?)`,
    [symbolName],
    limit,
  );
}

/**
 * Queries workflow nodes associated with one route path.
 */
export function queryWorkflowNodesByRoutePath(
  workspacePath: string,
  routePath: string,
  limit = 12,
) {
  return queryWorkflowNodesByPredicate(
    workspacePath,
    `route_path_lower = lower(?)`,
    [routePath],
    limit,
  );
}

/**
 * Queries workflow nodes classified as screen-like entries.
 */
export function queryWorkflowScreens(
  workspacePath: string,
  queryText: string,
  limit = 12,
) {
  const normalized = `%${queryText.trim().toLowerCase()}%`;
  return queryWorkflowNodesByPredicate(
    workspacePath,
    `node_type = 'screen' AND (label_lower LIKE ? OR lower(coalesce(file_path, '')) LIKE ? OR symbol_name_lower LIKE ?)`,
    [normalized, normalized, normalized],
    limit,
  );
}

/**
 * Queries workflow nodes classified as endpoint-like entries.
 */
export function queryWorkflowEndpoints(
  workspacePath: string,
  queryText: string,
  limit = 12,
) {
  const normalized = `%${queryText.trim().toLowerCase()}%`;
  return queryWorkflowNodesByPredicate(
    workspacePath,
    `node_type IN ('api_endpoint', 'webhook_handler', 'rpc_endpoint', 'controller') AND (label_lower LIKE ? OR route_path_lower LIKE ? OR symbol_name_lower LIKE ?)`,
    [normalized, normalized, normalized],
    limit,
  );
}

/**
 * Expands a workflow subgraph around a chosen entry node.
 */
export function getWorkflowSubgraph(
  workspacePath: string,
  opts: Readonly<{
    entryNodeId: string;
    maxHops?: number;
    maxNodes?: number;
    includeIncoming?: boolean;
  }>,
): WorkflowSubgraphResult {
  const maxHops = Math.max(1, Math.min(opts.maxHops ?? 2, 4));
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 24, 60));
  const includeIncoming = opts.includeIncoming ?? true;

  return withRagMetadataDatabase(workspacePath, (db) => {
    const workspaceId = getProjectStorageInfo(workspacePath).workspaceId;
    const nodeIds = new Set<string>([opts.entryNodeId]);
    const edgeMap = new Map<string, ReturnType<typeof mapWorkflowEdgeRow>>();
    let frontier = new Set<string>([opts.entryNodeId]);

    const edgeStmt = db.prepare(`
      SELECT id, from_node_id, to_node_id, edge_type, label, confidence, provenance_json,
             supporting_file_path, supporting_symbol_name, supporting_line, source_hash, created_at, updated_at
      FROM workflow_edges
      WHERE workspace_id = ?
        AND (from_node_id = ? OR to_node_id = ?)
    `);

    for (let hop = 0; hop < maxHops && frontier.size > 0 && nodeIds.size < maxNodes; hop += 1) {
      const nextFrontier = new Set<string>();
      for (const nodeId of frontier) {
        for (const row of edgeStmt.all(workspaceId, nodeId, nodeId) as Array<Parameters<typeof mapWorkflowEdgeRow>[0]>) {
          const touchesIncoming = row.to_node_id === nodeId;
          if (!includeIncoming && touchesIncoming) {
            continue;
          }
          edgeMap.set(row.id, mapWorkflowEdgeRow(row));
          if (nodeIds.size < maxNodes) {
            if (!nodeIds.has(row.from_node_id)) {
              nodeIds.add(row.from_node_id);
              nextFrontier.add(row.from_node_id);
            }
            if (!nodeIds.has(row.to_node_id)) {
              nodeIds.add(row.to_node_id);
              nextFrontier.add(row.to_node_id);
            }
          }
        }
      }
      frontier = nextFrontier;
    }

    const nodeRows = nodeIds.size > 0
      ? db.prepare(`
          SELECT id, node_type, label, file_path, symbol_name, route_method, route_path, start_line, end_line,
                 description, description_source, confidence, provenance_json, source_hash, created_at, updated_at
          FROM workflow_nodes
          WHERE workspace_id = ?
            AND id IN (${[...nodeIds].map(() => '?').join(',')})
        `).all(workspaceId, ...nodeIds) as Array<Parameters<typeof mapWorkflowNodeRow>[0]>
      : [];
    const nodes = Object.freeze(nodeRows.map((row) => mapWorkflowNodeRow(row)).sort((left, right) => left.label.localeCompare(right.label)));

    const maps = Object.freeze(
      (db.prepare(`
        SELECT id, map_type, entry_node_id, title, summary, confidence, source_hash, generated_at, updated_at
        FROM workflow_maps
        WHERE workspace_id = ?
          AND entry_node_id = ?
        ORDER BY confidence DESC, updated_at DESC
      `).all(workspaceId, opts.entryNodeId) as Array<Parameters<typeof mapWorkflowMapRow>[0]>).map((row) => mapWorkflowMapRow(row)),
    );
    const traces = Object.freeze(
      (db.prepare(`
        SELECT id, trace_kind, entry_node_id, title, query_hint, narrative, confidence, source_hash, generated_at, updated_at
        FROM workflow_trace_summaries
        WHERE workspace_id = ?
          AND entry_node_id = ?
        ORDER BY confidence DESC, updated_at DESC
      `).all(workspaceId, opts.entryNodeId) as Array<Parameters<typeof mapWorkflowTraceRow>[0]>).map((row) => mapWorkflowTraceRow(row)),
    );

    const entryNode = nodes.find((node) => node.id === opts.entryNodeId);
    return Object.freeze({
      ...(entryNode ? { entryNode } : {}),
      nodes,
      edges: Object.freeze([...edgeMap.values()].sort((left, right) => left.fromNodeId.localeCompare(right.fromNodeId) || left.toNodeId.localeCompare(right.toNodeId))),
      maps,
      traces,
    });
  });
}
