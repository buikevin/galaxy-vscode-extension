import { getProjectStorageInfo } from "../../project-store";
import { withRagMetadataDatabase } from "../../rag-metadata/database";
import {
  mapWorkflowEdgeRow,
  mapWorkflowMapRow,
  mapWorkflowNodeRow,
  mapWorkflowTraceRow,
} from "../graph-helpers";
import type { WorkflowGraphSnapshot } from "../entities";

export const WORKFLOW_PROJECTION_VERSION = "workflow-phase-1-v1";

export type WorkflowProjectionPropertyValue = string | number | boolean | null;

export type WorkflowProjectionNode = Readonly<{
  id: string;
  labels: readonly string[];
  properties: Readonly<Record<string, WorkflowProjectionPropertyValue>>;
}>;

export type WorkflowProjectionRelationship = Readonly<{
  id: string;
  type: string;
  fromId: string;
  toId: string;
  properties: Readonly<Record<string, WorkflowProjectionPropertyValue>>;
}>;

export type WorkflowProjectionPayload = Readonly<{
  workspaceId: string;
  workspacePath: string;
  projectionVersion: string;
  projectedAt: number;
  nodes: readonly WorkflowProjectionNode[];
  relationships: readonly WorkflowProjectionRelationship[];
}>;

function buildFlowNodeProjectionId(
  workspaceId: string,
  sourceId: string,
): string {
  return `${workspaceId}:${sourceId}`;
}

function buildWorkflowMapProjectionId(
  workspaceId: string,
  sourceId: string,
): string {
  return `${workspaceId}:${sourceId}`;
}

function buildTraceSummaryProjectionId(
  workspaceId: string,
  sourceId: string,
): string {
  return `${workspaceId}:${sourceId}`;
}

function buildPreview(value: string): string {
  return value.trim();
}

function getFlowNodeLabels(nodeType: string): readonly string[] {
  switch (nodeType) {
    case "screen":
      return Object.freeze(["FlowNode", "Screen"]);
    case "component":
      return Object.freeze(["FlowNode", "Component"]);
    case "api_endpoint":
      return Object.freeze(["FlowNode", "ApiEndpoint"]);
    case "rpc_endpoint":
      return Object.freeze(["FlowNode", "RpcEndpoint"]);
    case "webhook_handler":
      return Object.freeze(["FlowNode", "WebhookHandler"]);
    case "controller":
      return Object.freeze(["FlowNode", "Controller"]);
    case "backend_service":
      return Object.freeze(["FlowNode", "Service"]);
    case "frontend_service":
      return Object.freeze(["FlowNode", "FrontendService"]);
    case "repository":
      return Object.freeze(["FlowNode", "Repository"]);
    case "db_query":
      return Object.freeze(["FlowNode", "DbQuery"]);
    case "queue_topic":
      return Object.freeze(["FlowNode", "QueueTopic"]);
    case "worker":
      return Object.freeze(["FlowNode", "Worker"]);
    case "job":
      return Object.freeze(["FlowNode", "Job"]);
    case "message_handler":
      return Object.freeze(["FlowNode", "MessageHandler"]);
    case "external_dependency":
      return Object.freeze(["FlowNode", "ExternalDependency"]);
    case "entrypoint":
      return Object.freeze(["FlowNode", "Entrypoint"]);
    case "desktop_entrypoint":
      return Object.freeze(["FlowNode", "DesktopEntrypoint"]);
    default:
      return Object.freeze(["FlowNode", "UnknownFlowNode"]);
  }
}

function sortProjectionNodes(
  left: WorkflowProjectionNode,
  right: WorkflowProjectionNode,
): number {
  return left.id.localeCompare(right.id);
}

function sortProjectionRelationships(
  left: WorkflowProjectionRelationship,
  right: WorkflowProjectionRelationship,
): number {
  return left.id.localeCompare(right.id);
}

export function loadWorkflowGraphSnapshotForProjection(
  workspacePath: string,
): WorkflowGraphSnapshot {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const workspaceId = getProjectStorageInfo(workspacePath).workspaceId;
    const nodeRows = db
      .prepare(
        `
			SELECT id, node_type, label, file_path, symbol_name, route_method, route_path, start_line, end_line,
			       description, description_source, confidence, provenance_json, source_hash, created_at, updated_at
			FROM workflow_nodes
			WHERE workspace_id = ?
			ORDER BY id ASC
		`,
      )
      .all(workspaceId) as Array<Parameters<typeof mapWorkflowNodeRow>[0]>;
    const edgeRows = db
      .prepare(
        `
			SELECT id, from_node_id, to_node_id, edge_type, label, confidence, provenance_json,
			       supporting_file_path, supporting_symbol_name, supporting_line, source_hash, created_at, updated_at
			FROM workflow_edges
			WHERE workspace_id = ?
			ORDER BY id ASC
		`,
      )
      .all(workspaceId) as Array<Parameters<typeof mapWorkflowEdgeRow>[0]>;
    const mapRows = db
      .prepare(
        `
			SELECT id, map_type, entry_node_id, title, summary, confidence, source_hash, generated_at, updated_at
			FROM workflow_maps
			WHERE workspace_id = ?
			ORDER BY id ASC
		`,
      )
      .all(workspaceId) as Array<Parameters<typeof mapWorkflowMapRow>[0]>;
    const mapSources = db
      .prepare(
        `
			SELECT source.workflow_map_id, source.source_kind, source.source_ref, source.source_hash
			FROM workflow_map_sources AS source
			JOIN workflow_maps AS map ON map.id = source.workflow_map_id
			WHERE map.workspace_id = ?
			ORDER BY source.workflow_map_id ASC, source.source_kind ASC, source.source_ref ASC
		`,
      )
      .all(workspaceId) as Array<{
      workflow_map_id: string;
      source_kind: string;
      source_ref: string;
      source_hash: string | null;
    }>;
    const traceRows = db
      .prepare(
        `
			SELECT id, trace_kind, entry_node_id, title, query_hint, narrative, confidence, source_hash, generated_at, updated_at
			FROM workflow_trace_summaries
			WHERE workspace_id = ?
			ORDER BY id ASC
		`,
      )
      .all(workspaceId) as Array<Parameters<typeof mapWorkflowTraceRow>[0]>;

    return Object.freeze({
      nodes: Object.freeze(nodeRows.map((row) => mapWorkflowNodeRow(row))),
      edges: Object.freeze(edgeRows.map((row) => mapWorkflowEdgeRow(row))),
      maps: Object.freeze(mapRows.map((row) => mapWorkflowMapRow(row))),
      mapSources: Object.freeze(
        mapSources.map((source) =>
          Object.freeze({
            workflowMapId: source.workflow_map_id,
            sourceKind: source.source_kind,
            sourceRef: source.source_ref,
            ...(source.source_hash ? { sourceHash: source.source_hash } : {}),
          }),
        ),
      ),
      traceSummaries: Object.freeze(
        traceRows.map((row) => mapWorkflowTraceRow(row)),
      ),
    });
  });
}

export function buildWorkflowProjectionPayload(
  workspacePath: string,
  projectedAt = Date.now(),
): WorkflowProjectionPayload {
  const snapshot = loadWorkflowGraphSnapshotForProjection(workspacePath);
  const storage = getProjectStorageInfo(workspacePath);
  const workspaceId = storage.workspaceId;
  const nodesById = new Map<string, WorkflowProjectionNode>();
  const relationshipsById = new Map<string, WorkflowProjectionRelationship>();

  for (const [sourceOrdinal, node] of [...snapshot.nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .entries()) {
    const flowNodeId = buildFlowNodeProjectionId(workspaceId, node.id);
    nodesById.set(
      flowNodeId,
      Object.freeze({
        id: flowNodeId,
        labels: getFlowNodeLabels(node.nodeType),
        properties: Object.freeze({
          id: flowNodeId,
          workspaceId,
          sourceId: node.id,
          sourceOrdinal,
          nodeType: node.nodeType,
          label: node.label,
          filePath: node.filePath ?? null,
          symbolName: node.symbolName ?? null,
          routeMethod: node.routeMethod ?? null,
          routePath: node.routePath ?? null,
          startLine: node.startLine ?? null,
          endLine: node.endLine ?? null,
          description: node.description ?? null,
          descriptionSource: node.descriptionSource ?? null,
          confidence: node.confidence ?? 0.85,
          sourceHash: node.sourceHash ?? null,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt ?? node.createdAt,
        }),
      }),
    );
  }

  for (const [sourceOrdinal, edge] of [...snapshot.edges]
    .sort((left, right) => left.id.localeCompare(right.id))
    .entries()) {
    const relationshipId = `${workspaceId}:${edge.id}`;
    relationshipsById.set(
      relationshipId,
      Object.freeze({
        id: relationshipId,
        type: "WORKFLOW_EDGE",
        fromId: buildFlowNodeProjectionId(workspaceId, edge.fromNodeId),
        toId: buildFlowNodeProjectionId(workspaceId, edge.toNodeId),
        properties: Object.freeze({
          id: relationshipId,
          workspaceId,
          sourceId: edge.id,
          sourceOrdinal,
          edgeType: edge.edgeType,
          label: edge.label ?? null,
          confidence: edge.confidence ?? 0.8,
          supportingFilePath: edge.supportingFilePath ?? null,
          supportingSymbolName: edge.supportingSymbolName ?? null,
          supportingLine: edge.supportingLine ?? null,
          sourceHash: edge.sourceHash ?? null,
          createdAt: edge.createdAt,
          updatedAt: edge.updatedAt ?? edge.createdAt,
        }),
      }),
    );
  }

  for (const [sourceOrdinal, map] of [...(snapshot.maps ?? [])]
    .sort((left, right) => left.id.localeCompare(right.id))
    .entries()) {
    const mapId = buildWorkflowMapProjectionId(workspaceId, map.id);
    nodesById.set(
      mapId,
      Object.freeze({
        id: mapId,
        labels: Object.freeze(["WorkflowMap"]),
        properties: Object.freeze({
          id: mapId,
          workspaceId,
          sourceId: map.id,
          sourceOrdinal,
          mapType: map.mapType,
          entryNodeId: map.entryNodeId
            ? buildFlowNodeProjectionId(workspaceId, map.entryNodeId)
            : null,
          title: map.title,
          summaryPreview: buildPreview(map.summary),
          confidence: map.confidence ?? 0.8,
          sourceHash: map.sourceHash ?? null,
          generatedAt: map.generatedAt,
          updatedAt: map.updatedAt ?? map.generatedAt,
        }),
      }),
    );
  }

  for (const [sourceOrdinal, trace] of [...(snapshot.traceSummaries ?? [])]
    .sort((left, right) => left.id.localeCompare(right.id))
    .entries()) {
    const traceId = buildTraceSummaryProjectionId(workspaceId, trace.id);
    nodesById.set(
      traceId,
      Object.freeze({
        id: traceId,
        labels: Object.freeze(["TraceSummary"]),
        properties: Object.freeze({
          id: traceId,
          workspaceId,
          sourceId: trace.id,
          sourceOrdinal,
          traceKind: trace.traceKind,
          entryNodeId: trace.entryNodeId
            ? buildFlowNodeProjectionId(workspaceId, trace.entryNodeId)
            : null,
          title: trace.title,
          queryHint: trace.queryHint ?? null,
          narrativePreview: buildPreview(trace.narrative),
          confidence: trace.confidence ?? 0.8,
          sourceHash: trace.sourceHash ?? null,
          generatedAt: trace.generatedAt,
          updatedAt: trace.updatedAt ?? trace.generatedAt,
        }),
      }),
    );
  }

  return Object.freeze({
    workspaceId,
    workspacePath: storage.workspacePath,
    projectionVersion: WORKFLOW_PROJECTION_VERSION,
    projectedAt,
    nodes: Object.freeze([...nodesById.values()].sort(sortProjectionNodes)),
    relationships: Object.freeze(
      [...relationshipsById.values()].sort(sortProjectionRelationships),
    ),
  });
}
