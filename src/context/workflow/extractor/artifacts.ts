/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-04-02
 * @desc Workflow artifact and summary builders derived from static graph snapshots.
 */

import { createHash } from 'node:crypto';
import type { WorkflowArtifactBuildInput, WorkflowArtifactBuildResult, WorkflowSnapshotSubgraph } from '../entities/artifacts';
import type {
  WorkflowEdgeRecord,
  WorkflowMapRecord,
  WorkflowMapSourceRecord,
  WorkflowNodeRecord,
  WorkflowTraceSummaryRecord,
} from '../entities/graph';
import {
  MAX_WORKFLOW_ARTIFACTS,
  MAX_WORKFLOW_SUMMARY_STEPS,
  MAX_WORKFLOW_TRACE_STEPS,
  WORKFLOW_MAP_ENTRY_TYPES,
} from '../entities/constants';

/**
 * Formats a workflow node for summary text.
 */
export function formatWorkflowNodeRef(node: WorkflowNodeRecord): string {
  const baseLabel = node.routeMethod && node.routePath ? `${node.routeMethod} ${node.routePath}` : node.label;
  return `[${node.nodeType}] ${baseLabel}`;
}

/**
 * Assigns a stable priority for workflow entry selection.
 */
export function getWorkflowEntryPriority(nodeType: string): number {
  switch (nodeType) {
    case 'screen':
    case 'component':
      return 1;
    case 'api_endpoint':
    case 'webhook_handler':
      return 2;
    case 'queue_topic':
    case 'job':
      return 3;
    case 'worker':
    case 'message_handler':
      return 4;
    case 'controller':
      return 5;
    default:
      return 10;
  }
}

/**
 * Maps node types to a coarse workflow artifact category.
 */
export function classifyWorkflowMapType(nodeType: string): string {
  switch (nodeType) {
    case 'screen':
    case 'component':
      return 'screen_flow';
    case 'api_endpoint':
    case 'webhook_handler':
    case 'controller':
      return 'request_flow';
    case 'worker':
    case 'job':
    case 'message_handler':
    case 'queue_topic':
      return 'async_flow';
    default:
      return 'workflow_flow';
  }
}

/**
 * Assigns a source-path priority so generated artifacts prefer real application code over temp outputs.
 */
function getWorkflowSourcePathPriority(filePath: string | undefined): number {
  if (!filePath) {
    return 5;
  }

  if (
    filePath.includes('/src/') ||
    filePath.includes('/app/') ||
    filePath.includes('/pages/') ||
    filePath.includes('/api/') ||
    filePath.includes('/routes/') ||
    filePath.includes('/controllers/') ||
    filePath.includes('/services/') ||
    filePath.includes('/workers/') ||
    filePath.includes('/jobs/')
  ) {
    return 0;
  }
  if (filePath.includes('/scripts/')) {
    return 1;
  }
  if (filePath.includes('/docs/') || filePath.includes('.vitepress')) {
    return 3;
  }
  if (filePath.includes('/dist/') || filePath.includes('/build/') || filePath.includes('/out/') || filePath.includes('/.temp/')) {
    return 4;
  }
  return 2;
}

/**
 * Counts how many edges touch the provided workflow node.
 */
function countConnectedEdges(nodeId: string, edges: readonly WorkflowEdgeRecord[]): number {
  return edges.reduce((count, edge) => count + (edge.fromNodeId === nodeId || edge.toNodeId === nodeId ? 1 : 0), 0);
}

/**
 * Creates a stable hash for workflow summary artifacts.
 */
export function createWorkflowArtifactHash(entryNodeId: string, nodeIds: readonly string[], edgeIds: readonly string[]): string {
  return createHash('sha1')
    .update(entryNodeId)
    .update('\n')
    .update(nodeIds.join('|'))
    .update('\n')
    .update(edgeIds.join('|'))
    .digest('hex');
}

/**
 * Builds a small subgraph around a chosen workflow entry node.
 */
export function buildSnapshotSubgraph(
  entryNodeId: string,
  nodeMap: ReadonlyMap<string, WorkflowNodeRecord>,
  edges: readonly WorkflowEdgeRecord[],
): WorkflowSnapshotSubgraph | null {
  const entryNode = nodeMap.get(entryNodeId);
  if (!entryNode) {
    return null;
  }

  const nodeIds = new Set<string>([entryNodeId]);
  const collectedEdges = new Map<string, WorkflowEdgeRecord>();
  let frontier = new Set<string>([entryNodeId]);

  for (let hop = 0; hop < 3 && frontier.size > 0 && nodeIds.size < 14; hop += 1) {
    const nextFrontier = new Set<string>();
    frontier.forEach((nodeId) => {
      edges.forEach((edge) => {
        if (edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId) {
          return;
        }
        collectedEdges.set(edge.id, edge);
        if (!nodeIds.has(edge.fromNodeId) && nodeIds.size < 14) {
          nodeIds.add(edge.fromNodeId);
          nextFrontier.add(edge.fromNodeId);
        }
        if (!nodeIds.has(edge.toNodeId) && nodeIds.size < 14) {
          nodeIds.add(edge.toNodeId);
          nextFrontier.add(edge.toNodeId);
        }
      });
    });
    frontier = nextFrontier;
  }

  const subgraphNodes = [...nodeIds]
    .map((id) => nodeMap.get(id))
    .filter((node): node is WorkflowNodeRecord => Boolean(node))
    .sort((a, b) => (getWorkflowEntryPriority(a.nodeType) - getWorkflowEntryPriority(b.nodeType)) || a.id.localeCompare(b.id));
  const subgraphEdges = [...collectedEdges.values()].sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({
    entryNode,
    nodes: Object.freeze(subgraphNodes),
    edges: Object.freeze(subgraphEdges),
  });
}

/**
 * Builds a concise workflow summary line from a subgraph.
 */
export function buildWorkflowMapSummary(subgraph: WorkflowSnapshotSubgraph): string {
  const relatedNodes = subgraph.nodes.filter((node) => node.id !== subgraph.entryNode.id);
  const filePaths = [...new Set(subgraph.nodes.flatMap((node) => (node.filePath ? [node.filePath] : [])))];
  const edgeTypes = [...new Set(subgraph.edges.map((edge) => edge.edgeType))];
  const steps = subgraph.edges.slice(0, MAX_WORKFLOW_SUMMARY_STEPS).map((edge) => {
    const fromNode = subgraph.nodes.find((node) => node.id === edge.fromNodeId);
    const toNode = subgraph.nodes.find((node) => node.id === edge.toNodeId);
    return `${fromNode ? formatWorkflowNodeRef(fromNode) : edge.fromNodeId} -> ${toNode ? formatWorkflowNodeRef(toNode) : edge.toNodeId}`;
  });

  const lines = [
    `${formatWorkflowNodeRef(subgraph.entryNode)} reaches ${relatedNodes.length} related nodes across ${filePaths.length || 1} file(s).`,
    edgeTypes.length > 0 ? `Key edges: ${edgeTypes.join(', ')}.` : '',
    steps.length > 0 ? `Path: ${steps.join(' | ')}` : '',
  ].filter(Boolean);
  return lines.join(' ').trim();
}

/**
 * Builds a numbered workflow trace narrative from a subgraph.
 */
export function buildWorkflowTraceNarrative(subgraph: WorkflowSnapshotSubgraph): string {
  const steps = subgraph.edges.slice(0, MAX_WORKFLOW_TRACE_STEPS).map((edge, index) => {
    const fromNode = subgraph.nodes.find((node) => node.id === edge.fromNodeId);
    const toNode = subgraph.nodes.find((node) => node.id === edge.toNodeId);
    return `${index + 1}. ${fromNode ? formatWorkflowNodeRef(fromNode) : edge.fromNodeId} --${edge.edgeType}--> ${toNode ? formatWorkflowNodeRef(toNode) : edge.toNodeId}`;
  });
  if (steps.length === 0) {
    return `${formatWorkflowNodeRef(subgraph.entryNode)} is an isolated workflow entry in the current static graph snapshot.`;
  }
  return steps.join(' ');
}

/**
 * Builds workflow map and trace artifacts from a full graph snapshot.
 */
export function buildWorkflowArtifacts(snapshot: WorkflowArtifactBuildInput): WorkflowArtifactBuildResult {
  const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node] as const));
  const entryNodes = snapshot.nodes
    .filter((node) => WORKFLOW_MAP_ENTRY_TYPES.has(node.nodeType))
    .sort((a, b) =>
      (getWorkflowEntryPriority(a.nodeType) - getWorkflowEntryPriority(b.nodeType)) ||
      (getWorkflowSourcePathPriority(a.filePath) - getWorkflowSourcePathPriority(b.filePath)) ||
      (countConnectedEdges(b.id, snapshot.edges) - countConnectedEdges(a.id, snapshot.edges)) ||
      (b.confidence ?? 0) - (a.confidence ?? 0) ||
      a.id.localeCompare(b.id),
    )
    .slice(0, MAX_WORKFLOW_ARTIFACTS);

  const maps: WorkflowMapRecord[] = [];
  const mapSources: WorkflowMapSourceRecord[] = [];
  const traceSummaries: WorkflowTraceSummaryRecord[] = [];

  entryNodes.forEach((entryNode) => {
    const subgraph = buildSnapshotSubgraph(entryNode.id, nodeMap, snapshot.edges);
    if (!subgraph || (subgraph.nodes.length < 2 && subgraph.edges.length === 0)) {
      return;
    }

    const nodeIds = subgraph.nodes.map((node) => node.id).sort((a, b) => a.localeCompare(b));
    const edgeIds = subgraph.edges.map((edge) => edge.id).sort((a, b) => a.localeCompare(b));
    const artifactHash = createWorkflowArtifactHash(entryNode.id, nodeIds, edgeIds);
    const generatedAt = Date.now();
    const mapId = `workflow-map:${entryNode.id}`;
    const traceId = `workflow-trace:${entryNode.id}`;
    const title = `Flow: ${entryNode.label}`;
    const summary = buildWorkflowMapSummary(subgraph);
    const narrative = buildWorkflowTraceNarrative(subgraph);
    const relatedFiles = [...new Set(subgraph.nodes.flatMap((node) => (node.filePath ? [node.filePath] : [])))];
    const confidence = Math.min(
      0.98,
      Math.max(
        0.7,
        (subgraph.nodes.reduce((sum, node) => sum + (node.confidence ?? 0.8), 0) +
          subgraph.edges.reduce((sum, edge) => sum + (edge.confidence ?? 0.75), 0)) /
          Math.max(subgraph.nodes.length + subgraph.edges.length, 1),
      ),
    );

    maps.push(Object.freeze({
      id: mapId,
      mapType: classifyWorkflowMapType(entryNode.nodeType),
      entryNodeId: entryNode.id,
      title,
      summary,
      confidence,
      sourceHash: artifactHash,
      generatedAt,
      updatedAt: generatedAt,
    }));

    traceSummaries.push(Object.freeze({
      id: traceId,
      traceKind: classifyWorkflowMapType(entryNode.nodeType),
      entryNodeId: entryNode.id,
      title,
      queryHint: [entryNode.label, entryNode.routePath, ...relatedFiles].filter(Boolean).join(' '),
      narrative,
      confidence,
      sourceHash: artifactHash,
      generatedAt,
      updatedAt: generatedAt,
    }));

    nodeIds.forEach((nodeId) => {
      mapSources.push(Object.freeze({
        workflowMapId: mapId,
        sourceKind: 'node',
        sourceRef: nodeId,
        sourceHash: artifactHash,
      }));
    });
    edgeIds.forEach((edgeId) => {
      mapSources.push(Object.freeze({
        workflowMapId: mapId,
        sourceKind: 'edge',
        sourceRef: edgeId,
        sourceHash: artifactHash,
      }));
    });
  });

  return Object.freeze({
    maps: Object.freeze(maps),
    mapSources: Object.freeze(mapSources),
    traceSummaries: Object.freeze(traceSummaries),
  });
}
