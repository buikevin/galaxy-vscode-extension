/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-21
 * @modify date 2026-04-21
 * @desc Graph-to-view composition helpers for explorer and diagram export flows.
 */

import type {
  WorkflowEdgeSummary,
  WorkflowMapSummary,
  WorkflowNodeSummary,
  WorkflowSubgraphResult,
  WorkflowTraceSummary,
} from "../entities";
import {
  getWorkflowSubgraph,
  queryWorkflowNodesByFilePath,
  queryWorkflowNodesByRoutePath,
} from "../query/index";
import type {
  WorkflowViewGraphComposeOptions,
  WorkflowViewGraphEdge,
  WorkflowViewGraphGroup,
  WorkflowViewGraphModel,
  WorkflowViewGraphNode,
  WorkflowViewGroupKind,
  WorkflowViewScopeKind,
} from "./model";

const FRONTEND_NODE_TYPES = new Set([
  "screen",
  "component",
  "page",
  "view",
  "layout",
]);
const BACKEND_NODE_TYPES = new Set([
  "api_endpoint",
  "controller",
  "service",
  "webhook_handler",
  "rpc_endpoint",
  "message_handler",
]);
const DATA_NODE_TYPES = new Set([
  "db_query",
  "repository",
  "database_table",
  "cache",
]);
const ASYNC_NODE_TYPES = new Set(["queue_topic", "job", "worker", "scheduler"]);
const EXTERNAL_NODE_TYPES = new Set(["external_dependency"]);

const NODE_TYPE_PRIORITY = new Map<string, number>([
  ["screen", 90],
  ["api_endpoint", 85],
  ["controller", 82],
  ["service", 80],
  ["queue_topic", 78],
  ["job", 76],
  ["worker", 74],
  ["component", 70],
  ["db_query", 66],
  ["external_dependency", 20],
]);

const GROUP_KIND_ORDER = new Map<WorkflowViewGroupKind, number>([
  ["frontend", 1],
  ["backend", 2],
  ["data", 3],
  ["async", 4],
  ["external", 5],
  ["module", 6],
  ["unknown", 7],
]);

type GroupDescriptor = Readonly<{
  groupKey: string;
  title: string;
  kind: WorkflowViewGroupKind;
  colorToken: string;
}>;

type FilteredSubgraph = Readonly<{
  entryNode?: WorkflowNodeSummary;
  nodes: readonly WorkflowNodeSummary[];
  edges: readonly WorkflowEdgeSummary[];
  maps: readonly WorkflowMapSummary[];
  traces: readonly WorkflowTraceSummary[];
}>;

function normalizeNodeTypeSet(values?: readonly string[]): Set<string> | null {
  if (!values || values.length === 0) {
    return null;
  }
  return new Set(
    values.map((value) => String(value ?? "").trim()).filter(Boolean),
  );
}

function inferModuleGroup(filePath?: string): GroupDescriptor {
  if (!filePath) {
    return Object.freeze({
      groupKey: "unknown",
      title: "Unassigned",
      kind: "unknown" as const,
      colorToken: "slate",
    });
  }

  const segments = filePath.split("/").filter(Boolean);
  const title =
    segments.slice(0, Math.min(2, segments.length)).join("/") || filePath;
  return Object.freeze({
    groupKey: `module:${title.toLowerCase()}`,
    title,
    kind: "module" as const,
    colorToken: "slate",
  });
}

function classifyNodeGroup(node: WorkflowNodeSummary): GroupDescriptor {
  const loweredPath = node.filePath?.toLowerCase() ?? "";
  if (EXTERNAL_NODE_TYPES.has(node.nodeType)) {
    return Object.freeze({
      groupKey: "layer:external",
      title: "External",
      kind: "external",
      colorToken: "rose",
    });
  }
  if (
    FRONTEND_NODE_TYPES.has(node.nodeType) ||
    loweredPath.includes("/pages/") ||
    loweredPath.includes("/components/") ||
    loweredPath.includes("/app/")
  ) {
    return Object.freeze({
      groupKey: "layer:frontend",
      title: "Frontend",
      kind: "frontend",
      colorToken: "sky",
    });
  }
  if (
    ASYNC_NODE_TYPES.has(node.nodeType) ||
    loweredPath.includes("/jobs/") ||
    loweredPath.includes("/workers/") ||
    loweredPath.includes("/queues/")
  ) {
    return Object.freeze({
      groupKey: "layer:async",
      title: "Async",
      kind: "async",
      colorToken: "amber",
    });
  }
  if (
    DATA_NODE_TYPES.has(node.nodeType) ||
    loweredPath.includes("/repositories/") ||
    loweredPath.includes("/database/") ||
    loweredPath.includes("/db/")
  ) {
    return Object.freeze({
      groupKey: "layer:data",
      title: "Data",
      kind: "data",
      colorToken: "emerald",
    });
  }
  if (
    BACKEND_NODE_TYPES.has(node.nodeType) ||
    loweredPath.includes("/server/") ||
    loweredPath.includes("/routes/") ||
    loweredPath.includes("/controllers/") ||
    loweredPath.includes("/services/") ||
    loweredPath.includes("/api/")
  ) {
    return Object.freeze({
      groupKey: "layer:backend",
      title: "Backend",
      kind: "backend",
      colorToken: "violet",
    });
  }
  return inferModuleGroup(node.filePath);
}

function pickPrimaryNode(
  nodes: readonly WorkflowNodeSummary[],
  scopeLabel: string,
): WorkflowNodeSummary {
  const sorted = [...nodes].sort((left, right) => {
    const priorityDelta =
      (NODE_TYPE_PRIORITY.get(right.nodeType) ?? 0) -
      (NODE_TYPE_PRIORITY.get(left.nodeType) ?? 0);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    const confidenceDelta = (right.confidence ?? 0) - (left.confidence ?? 0);
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }
    return left.label.localeCompare(right.label);
  });
  if (sorted.length === 0) {
    throw new Error(`No workflow node matched ${scopeLabel}.`);
  }
  return sorted[0];
}

function applyViewFilters(
  subgraph: WorkflowSubgraphResult,
  entryNodeId: string,
  opts?: WorkflowViewGraphComposeOptions,
): FilteredSubgraph {
  const nodeTypes = normalizeNodeTypeSet(opts?.nodeTypes);
  const edgeTypes = normalizeNodeTypeSet(opts?.edgeTypes);
  const includeExternal = opts?.includeExternal ?? true;

  const nodeMap = new Map<string, WorkflowNodeSummary>();
  for (const node of subgraph.nodes) {
    if (!includeExternal && EXTERNAL_NODE_TYPES.has(node.nodeType)) {
      continue;
    }
    if (nodeTypes && node.id !== entryNodeId && !nodeTypes.has(node.nodeType)) {
      continue;
    }
    nodeMap.set(node.id, node);
  }

  if (!nodeMap.has(entryNodeId) && subgraph.entryNode) {
    nodeMap.set(entryNodeId, subgraph.entryNode);
  }

  const edges = subgraph.edges.filter((edge) => {
    if (edgeTypes && !edgeTypes.has(edge.edgeType)) {
      return false;
    }
    return nodeMap.has(edge.fromNodeId) && nodeMap.has(edge.toNodeId);
  });

  return Object.freeze({
    entryNode: nodeMap.get(entryNodeId),
    nodes: Object.freeze([...nodeMap.values()]),
    edges: Object.freeze(edges),
    maps: subgraph.maps,
    traces: subgraph.traces,
  });
}

function buildIncidentCountMap(
  edges: readonly WorkflowEdgeSummary[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const bump = (nodeId: string): void => {
    counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  };
  for (const edge of edges) {
    bump(edge.fromNodeId);
    bump(edge.toNodeId);
  }
  return counts;
}

function computeNodeImportance(
  node: WorkflowNodeSummary,
  entryNodeId: string,
  incidentCount: number,
): number {
  let score = node.id === entryNodeId ? 20 : 0;
  score += Math.round((node.confidence ?? 0) * 10);
  score += Math.min(incidentCount * 3, 12);
  score += Math.round((NODE_TYPE_PRIORITY.get(node.nodeType) ?? 10) / 10);
  if (node.routePath) {
    score += 2;
  }
  if (node.symbolName) {
    score += 1;
  }
  return score;
}

function computeEdgeImportance(
  edge: WorkflowEdgeSummary,
  entryNodeId: string,
  nodeImportance: ReadonlyMap<string, number>,
): number {
  let score = Math.round((edge.confidence ?? 0) * 10);
  if (edge.fromNodeId === entryNodeId || edge.toNodeId === entryNodeId) {
    score += 6;
  }
  score += edge.label ? 2 : 1;
  score += Math.round(
    ((nodeImportance.get(edge.fromNodeId) ?? 0) +
      (nodeImportance.get(edge.toNodeId) ?? 0)) /
      8,
  );
  return score;
}

function inferDominantFlowKind(
  nodes: readonly WorkflowNodeSummary[],
  maps: readonly WorkflowMapSummary[],
  traces: readonly WorkflowTraceSummary[],
): string {
  if (maps[0]?.mapType) {
    return maps[0].mapType;
  }
  if (traces[0]?.traceKind) {
    return traces[0].traceKind;
  }
  if (nodes.some((node) => ASYNC_NODE_TYPES.has(node.nodeType))) {
    return "async_flow";
  }
  if (
    nodes.some((node) => FRONTEND_NODE_TYPES.has(node.nodeType)) &&
    nodes.some(
      (node) =>
        BACKEND_NODE_TYPES.has(node.nodeType) ||
        DATA_NODE_TYPES.has(node.nodeType),
    )
  ) {
    return "request_flow";
  }
  return "code_flow";
}

function buildPrimaryPath(
  entryNodeId: string | undefined,
  nodes: readonly WorkflowViewGraphNode[],
  edges: readonly WorkflowViewGraphEdge[],
): string | null {
  if (!entryNodeId) {
    return null;
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  if (!nodeMap.has(entryNodeId)) {
    return null;
  }

  const outgoing = new Map<string, WorkflowViewGraphEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.fromNodeId) ?? [];
    list.push(edge);
    outgoing.set(edge.fromNodeId, list);
  }

  for (const list of outgoing.values()) {
    list.sort(
      (left, right) =>
        right.importanceScore - left.importanceScore ||
        left.id.localeCompare(right.id),
    );
  }

  const visited = new Set<string>([entryNodeId]);
  const labels: string[] = [nodeMap.get(entryNodeId)?.label ?? entryNodeId];
  let currentNodeId = entryNodeId;

  for (let depth = 0; depth < 4; depth += 1) {
    const nextEdge = (outgoing.get(currentNodeId) ?? []).find(
      (edge) => !visited.has(edge.toNodeId),
    );
    if (!nextEdge) {
      break;
    }
    visited.add(nextEdge.toNodeId);
    labels.push(nodeMap.get(nextEdge.toNodeId)?.label ?? nextEdge.toNodeId);
    currentNodeId = nextEdge.toNodeId;
  }

  if (labels.length < 2) {
    return null;
  }
  return labels.join(" -> ");
}

function buildGraphSummary(
  entryNode: WorkflowNodeSummary | undefined,
  nodes: readonly WorkflowViewGraphNode[],
  edges: readonly WorkflowViewGraphEdge[],
  groups: readonly WorkflowViewGraphGroup[],
  maps: readonly WorkflowMapSummary[],
  traces: readonly WorkflowTraceSummary[],
): string {
  const preferred = maps[0]?.summary || traces[0]?.narrative;
  if (preferred) {
    return preferred.trim();
  }
  const groupList = groups
    .slice(0, 3)
    .map((group) => group.title.toLowerCase())
    .join(", ");
  const entryLabel = entryNode?.label ?? "Selected graph";
  return `${entryLabel} spans ${nodes.length} nodes and ${edges.length} edges across ${groups.length} groups${groupList ? ` (${groupList})` : ""}.`;
}

function buildGraphTitle(
  scopeKind: WorkflowViewScopeKind,
  scopeValue: string,
  entryNode: WorkflowNodeSummary | undefined,
  maps: readonly WorkflowMapSummary[],
): string {
  if (scopeKind === "route") {
    return `Route Context: ${scopeValue}`;
  }
  if (scopeKind === "file") {
    return `File Context: ${scopeValue}`;
  }
  return maps[0]?.title ?? `Flow: ${entryNode?.label ?? scopeValue}`;
}

function sortGroups(
  groups: readonly WorkflowViewGraphGroup[],
): readonly WorkflowViewGraphGroup[] {
  return Object.freeze(
    [...groups].sort((left, right) => {
      const kindDelta =
        (GROUP_KIND_ORDER.get(left.kind) ?? 99) -
        (GROUP_KIND_ORDER.get(right.kind) ?? 99);
      if (kindDelta !== 0) {
        return kindDelta;
      }
      return left.title.localeCompare(right.title);
    }),
  );
}

function composeViewGraphModel(
  scopeKind: WorkflowViewScopeKind,
  scopeValue: string,
  subgraph: WorkflowSubgraphResult,
  entryNodeId: string,
  opts?: WorkflowViewGraphComposeOptions,
): WorkflowViewGraphModel {
  const filtered = applyViewFilters(subgraph, entryNodeId, opts);
  const incidentCounts = buildIncidentCountMap(filtered.edges);
  const groupEntries = new Map<
    string,
    {
      descriptor: GroupDescriptor;
      nodeIds: string[];
    }
  >();

  const nodes = filtered.nodes
    .map((node) => {
      const descriptor = classifyNodeGroup(node);
      const importanceScore = computeNodeImportance(
        node,
        entryNodeId,
        incidentCounts.get(node.id) ?? 0,
      );
      const current = groupEntries.get(descriptor.groupKey);
      if (current) {
        current.nodeIds.push(node.id);
      } else {
        groupEntries.set(descriptor.groupKey, {
          descriptor,
          nodeIds: [node.id],
        });
      }
      return Object.freeze({
        id: node.id,
        label: node.label,
        nodeType: node.nodeType,
        groupKey: descriptor.groupKey,
        importanceScore,
        ...(node.filePath ? { filePath: node.filePath } : {}),
        ...(node.symbolName ? { symbolName: node.symbolName } : {}),
        ...(node.routePath ? { routePath: node.routePath } : {}),
        ...(node.routeMethod ? { routeMethod: node.routeMethod } : {}),
        ...(typeof node.startLine === "number"
          ? { startLine: node.startLine }
          : {}),
        ...(typeof node.endLine === "number" ? { endLine: node.endLine } : {}),
        ...(node.description ? { description: node.description } : {}),
        isEntry: node.id === entryNodeId,
        isExternal: EXTERNAL_NODE_TYPES.has(node.nodeType),
      });
    })
    .sort(
      (left, right) =>
        right.importanceScore - left.importanceScore ||
        left.label.localeCompare(right.label),
    );

  const nodeImportance = new Map(
    nodes.map((node) => [node.id, node.importanceScore]),
  );
  const edges = filtered.edges
    .map((edge) =>
      Object.freeze({
        id: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        edgeType: edge.edgeType,
        ...(edge.label ? { label: edge.label } : {}),
        importanceScore: computeEdgeImportance(
          edge,
          entryNodeId,
          nodeImportance,
        ),
        ...(edge.supportingFilePath
          ? { supportingFilePath: edge.supportingFilePath }
          : {}),
        ...(edge.supportingSymbolName
          ? { supportingSymbolName: edge.supportingSymbolName }
          : {}),
        ...(typeof edge.supportingLine === "number"
          ? { supportingLine: edge.supportingLine }
          : {}),
      }),
    )
    .sort(
      (left, right) =>
        right.importanceScore - left.importanceScore ||
        left.id.localeCompare(right.id),
    );

  const groups = sortGroups(
    [...groupEntries.values()].map(({ descriptor, nodeIds }) =>
      Object.freeze({
        groupKey: descriptor.groupKey,
        title: descriptor.title,
        kind: descriptor.kind,
        colorToken: descriptor.colorToken,
        nodeIds: Object.freeze(
          nodeIds.sort((left, right) => left.localeCompare(right)),
        ),
      }),
    ),
  );

  const focusPaths = new Set<string>();
  if (filtered.maps[0]?.title) {
    focusPaths.add(filtered.maps[0].title);
  }
  if (filtered.traces[0]?.title) {
    focusPaths.add(filtered.traces[0].title);
  }
  const primaryPath = buildPrimaryPath(entryNodeId, nodes, edges);
  if (primaryPath) {
    focusPaths.add(primaryPath);
  }

  const entryNode =
    filtered.entryNode ??
    filtered.nodes.find((node) => node.id === entryNodeId);
  return Object.freeze({
    scopeKind,
    scopeValue,
    ...(entryNode ? { entryNodeId } : {}),
    graphTitle: buildGraphTitle(
      scopeKind,
      scopeValue,
      entryNode,
      filtered.maps,
    ),
    graphSummary: buildGraphSummary(
      entryNode,
      nodes,
      edges,
      groups,
      filtered.maps,
      filtered.traces,
    ),
    dominantFlowKind: inferDominantFlowKind(
      filtered.nodes,
      filtered.maps,
      filtered.traces,
    ),
    focusPaths: Object.freeze([...focusPaths].slice(0, 3)),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    groups,
    maps: filtered.maps,
    traces: filtered.traces,
  });
}

/**
 * Builds a graph view model from a known workflow entry node id.
 */
export function buildViewGraphModelFromEntryNode(
  workspacePath: string,
  opts: Readonly<{ entryNodeId: string }> & WorkflowViewGraphComposeOptions,
): WorkflowViewGraphModel {
  const subgraph = getWorkflowSubgraph(workspacePath, {
    entryNodeId: opts.entryNodeId,
    ...(typeof opts.maxHops === "number" ? { maxHops: opts.maxHops } : {}),
    ...(typeof opts.maxNodes === "number" ? { maxNodes: opts.maxNodes } : {}),
    ...(typeof opts.includeIncoming === "boolean"
      ? { includeIncoming: opts.includeIncoming }
      : {}),
  });

  if (!subgraph.entryNode) {
    throw new Error(`Workflow entry node ${opts.entryNodeId} was not found.`);
  }

  return composeViewGraphModel(
    "entry_node",
    opts.entryNodeId,
    subgraph,
    opts.entryNodeId,
    opts,
  );
}

/**
 * Resolves a route path to its best entry node and composes a graph view model.
 */
export function buildViewGraphModelFromRoute(
  workspacePath: string,
  routePath: string,
  opts?: WorkflowViewGraphComposeOptions,
): WorkflowViewGraphModel {
  const entryNode = pickPrimaryNode(
    queryWorkflowNodesByRoutePath(workspacePath, routePath, 12),
    `route path ${routePath}`,
  );
  const subgraph = getWorkflowSubgraph(workspacePath, {
    entryNodeId: entryNode.id,
    ...(typeof opts?.maxHops === "number" ? { maxHops: opts.maxHops } : {}),
    ...(typeof opts?.maxNodes === "number" ? { maxNodes: opts.maxNodes } : {}),
    ...(typeof opts?.includeIncoming === "boolean"
      ? { includeIncoming: opts.includeIncoming }
      : {}),
  });
  return composeViewGraphModel(
    "route",
    routePath,
    subgraph,
    entryNode.id,
    opts,
  );
}

/**
 * Resolves a file path to its strongest workflow node and composes a graph view model.
 */
export function buildViewGraphModelFromFile(
  workspacePath: string,
  filePath: string,
  opts?: WorkflowViewGraphComposeOptions,
): WorkflowViewGraphModel {
  const entryNode = pickPrimaryNode(
    queryWorkflowNodesByFilePath(workspacePath, filePath, 12),
    `file path ${filePath}`,
  );
  const subgraph = getWorkflowSubgraph(workspacePath, {
    entryNodeId: entryNode.id,
    ...(typeof opts?.maxHops === "number" ? { maxHops: opts.maxHops } : {}),
    ...(typeof opts?.maxNodes === "number" ? { maxNodes: opts.maxNodes } : {}),
    ...(typeof opts?.includeIncoming === "boolean"
      ? { includeIncoming: opts.includeIncoming }
      : {}),
  });
  return composeViewGraphModel("file", filePath, subgraph, entryNode.id, opts);
}

/**
 * Builds a concise narrative summary suitable for prompt context or UI sidebars.
 */
export function summarizeViewGraphModel(model: WorkflowViewGraphModel): string {
  const focus = model.focusPaths[0]
    ? ` Primary path: ${model.focusPaths[0]}.`
    : "";
  return `${model.graphTitle}. ${model.graphSummary}${focus}`.trim();
}
