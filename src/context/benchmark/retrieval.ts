import { getProjectStorageInfo } from "../project-store";
import { buildRetrievalStrategy } from "../retrieval-core";
import { queryRelevantTaskMemoryLexical } from "../rag-metadata/task-memory";
import type {
  WorkflowGraphQueryResult,
  WorkflowSubgraphResult,
} from "../workflow/entities";
import {
  buildKuzuWorkflowProjectionStats,
  queryWorkflowGraphFromKuzu,
  queryWorkflowSubgraphFromKuzu,
} from "../workflow/projector/kuzu";
import {
  getWorkflowSubgraph,
  queryWorkflowGraph,
  queryWorkflowGraphHybrid,
} from "../workflow/query";

type WorkflowQueryBackendReport = Readonly<{
  nodeHitCount: number;
  mapHitCount: number;
  traceHitCount: number;
  topNodes: readonly Readonly<{
    id: string;
    label: string;
    nodeType: string;
    filePath?: string;
    score: number;
  }>[];
  topMaps: readonly Readonly<{
    id: string;
    title: string;
    entryNodeId?: string;
    score: number;
  }>[];
  topTraces: readonly Readonly<{
    id: string;
    title: string;
    entryNodeId?: string;
    score: number;
  }>[];
  candidatePaths: readonly string[];
}>;

type WorkflowSubgraphBackendReport = Readonly<{
  nodeCount: number;
  edgeCount: number;
  mapCount: number;
  traceCount: number;
  candidatePaths: readonly string[];
}>;

type WorkflowSubgraphParityComparison = Readonly<{
  aligned: boolean;
  localOnly: Readonly<{
    nodeIds: readonly string[];
    edgeIds: readonly string[];
    mapIds: readonly string[];
    traceIds: readonly string[];
    candidatePaths: readonly string[];
  }>;
  backendOnly: Readonly<{
    nodeIds: readonly string[];
    edgeIds: readonly string[];
    mapIds: readonly string[];
    traceIds: readonly string[];
    candidatePaths: readonly string[];
  }>;
}>;

type WorkflowQueryParityComparison = Readonly<{
  aligned: boolean;
  localOnly: Readonly<{
    nodeIds: readonly string[];
    mapIds: readonly string[];
    traceIds: readonly string[];
    candidatePaths: readonly string[];
  }>;
  backendOnly: Readonly<{
    nodeIds: readonly string[];
    mapIds: readonly string[];
    traceIds: readonly string[];
    candidatePaths: readonly string[];
  }>;
  ranking: Readonly<{
    nodeIds: readonly string[];
    mapIds: readonly string[];
    traceIds: readonly string[];
  }>;
  scoreMismatches: Readonly<{
    nodes: readonly Readonly<{
      id: string;
      localScore: number;
      backendScore: number;
    }>[];
    maps: readonly Readonly<{
      id: string;
      localScore: number;
      backendScore: number;
    }>[];
    traces: readonly Readonly<{
      id: string;
      localScore: number;
      backendScore: number;
    }>[];
  }>;
}>;

type WorkflowBackendParityDiagnostic = Readonly<{
  available: boolean;
  aligned: boolean | null;
  details: readonly string[];
}>;

type WorkflowBackendDiagnostics = Readonly<{
  query: WorkflowBackendParityDiagnostic;
  subgraph: WorkflowBackendParityDiagnostic;
}>;

export type RetrievalBenchmarkMode = "lexical" | "hybrid";

export type RetrievalBenchmarkReport = Readonly<{
  workspaceId: string;
  workspacePath: string;
  queryText: string;
  mode: RetrievalBenchmarkMode;
  retrieval: Readonly<{
    primaryIntent: string;
    secondaryIntents: readonly string[];
    requiresExactEvidence: boolean;
    signals: readonly string[];
    stageOrder: readonly string[];
    promptBlocks: readonly string[];
    stopTarget: string;
  }>;
  workflow: Readonly<{
    nodeHitCount: number;
    mapHitCount: number;
    traceHitCount: number;
    entryNodeId: string | null;
    topNodes: readonly Readonly<{
      id: string;
      label: string;
      nodeType: string;
      filePath?: string;
      score: number;
    }>[];
    topMaps: readonly Readonly<{
      id: string;
      title: string;
      entryNodeId?: string;
      score: number;
    }>[];
    topTraces: readonly Readonly<{
      id: string;
      title: string;
      entryNodeId?: string;
      score: number;
    }>[];
    subgraph: Readonly<{
      nodeCount: number;
      edgeCount: number;
      mapCount: number;
      traceCount: number;
      candidatePaths: readonly string[];
    }>;
  }>;
  taskMemory: Readonly<{
    entryHitCount: number;
    findingHitCount: number;
    topEntries: readonly Readonly<{
      turnId: string;
      turnKind: string;
      userIntent: string;
      files: readonly string[];
      createdAt: number;
    }>[];
    topFindings: readonly Readonly<{
      id: string;
      entryTurnId: string;
      kind: string;
      summary: string;
      filePath?: string;
      line?: number;
      status: string;
    }>[];
  }>;
  projection: Readonly<{
    nodeCount: number;
    relationshipCount: number;
    schemaStatementCount: number;
    mergeStatementCount: number;
    cleanupStatementCount: number;
  }>;
  kuzuWorkflowQuery: WorkflowQueryBackendReport | null;
  kuzuSubgraph: WorkflowSubgraphBackendReport | null;
  kuzuComparison: WorkflowSubgraphParityComparison | null;
  kuzuQueryComparison: WorkflowQueryParityComparison | null;
  kuzuDiagnostics: WorkflowBackendDiagnostics;
  candidatePaths: readonly string[];
}>;

function uniquePaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const candidate of paths) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    next.push(trimmed);
  }
  return Object.freeze(next);
}

function diffStringLists(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const rightSet = new Set(right);
  return Object.freeze(
    [...left]
      .filter((value) => !rightSet.has(value))
      .sort((a, b) => a.localeCompare(b)),
  );
}

function diffSharedRankedPositions(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const sharedLeft = left.filter((value) => rightSet.has(value));
  const sharedRight = right.filter((value) => leftSet.has(value));
  const mismatches: string[] = [];
  const maxLength = Math.max(sharedLeft.length, sharedRight.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = sharedLeft[index];
    const rightValue = sharedRight[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (leftValue && !mismatches.includes(leftValue)) {
      mismatches.push(leftValue);
    }
    if (rightValue && !mismatches.includes(rightValue)) {
      mismatches.push(rightValue);
    }
  }
  return Object.freeze(mismatches);
}

function collectScoreMismatches(
  localEntries: readonly Readonly<{ id: string; score: number }>[],
  backendEntries: readonly Readonly<{ id: string; score: number }>[],
): readonly Readonly<{
  id: string;
  localScore: number;
  backendScore: number;
}>[] {
  const backendScores = new Map(
    backendEntries.map((entry) => [entry.id, entry.score] as const),
  );
  const mismatches = localEntries.flatMap((entry) => {
    const backendScore = backendScores.get(entry.id);
    if (backendScore === undefined || backendScore === entry.score) {
      return [];
    }
    return [
      Object.freeze({
        id: entry.id,
        localScore: entry.score,
        backendScore,
      }),
    ];
  });
  return Object.freeze(mismatches);
}

function collectSubgraphCandidatePaths(
  subgraph: Pick<WorkflowSubgraphResult, "nodes" | "edges">,
): readonly string[] {
  return uniquePaths([
    ...subgraph.nodes.flatMap((node) => (node.filePath ? [node.filePath] : [])),
    ...subgraph.edges.flatMap((edge) =>
      edge.supportingFilePath ? [edge.supportingFilePath] : [],
    ),
  ]);
}

function collectWorkflowQueryCandidatePaths(
  result: Pick<WorkflowGraphQueryResult, "nodes">,
): readonly string[] {
  return uniquePaths(
    result.nodes.flatMap((entry) =>
      entry.node.filePath ? [entry.node.filePath] : [],
    ),
  );
}

function buildWorkflowSubgraphComparison(
  localSubgraph: WorkflowSubgraphResult,
  backendSubgraph: WorkflowSubgraphResult,
): WorkflowSubgraphParityComparison {
  const localCandidatePaths = collectSubgraphCandidatePaths(localSubgraph);
  const backendCandidatePaths = collectSubgraphCandidatePaths(backendSubgraph);
  const localOnly = Object.freeze({
    nodeIds: diffStringLists(
      localSubgraph.nodes.map((node) => node.id),
      backendSubgraph.nodes.map((node) => node.id),
    ),
    edgeIds: diffStringLists(
      localSubgraph.edges.map((edge) => edge.id),
      backendSubgraph.edges.map((edge) => edge.id),
    ),
    mapIds: diffStringLists(
      localSubgraph.maps.map((map) => map.id),
      backendSubgraph.maps.map((map) => map.id),
    ),
    traceIds: diffStringLists(
      localSubgraph.traces.map((trace) => trace.id),
      backendSubgraph.traces.map((trace) => trace.id),
    ),
    candidatePaths: diffStringLists(localCandidatePaths, backendCandidatePaths),
  });
  const backendOnly = Object.freeze({
    nodeIds: diffStringLists(
      backendSubgraph.nodes.map((node) => node.id),
      localSubgraph.nodes.map((node) => node.id),
    ),
    edgeIds: diffStringLists(
      backendSubgraph.edges.map((edge) => edge.id),
      localSubgraph.edges.map((edge) => edge.id),
    ),
    mapIds: diffStringLists(
      backendSubgraph.maps.map((map) => map.id),
      localSubgraph.maps.map((map) => map.id),
    ),
    traceIds: diffStringLists(
      backendSubgraph.traces.map((trace) => trace.id),
      localSubgraph.traces.map((trace) => trace.id),
    ),
    candidatePaths: diffStringLists(backendCandidatePaths, localCandidatePaths),
  });
  return Object.freeze({
    aligned:
      localOnly.nodeIds.length === 0 &&
      localOnly.edgeIds.length === 0 &&
      localOnly.mapIds.length === 0 &&
      localOnly.traceIds.length === 0 &&
      localOnly.candidatePaths.length === 0 &&
      backendOnly.nodeIds.length === 0 &&
      backendOnly.edgeIds.length === 0 &&
      backendOnly.mapIds.length === 0 &&
      backendOnly.traceIds.length === 0 &&
      backendOnly.candidatePaths.length === 0,
    localOnly,
    backendOnly,
  });
}

function buildWorkflowQueryComparison(
  localQuery: WorkflowGraphQueryResult,
  backendQuery: WorkflowGraphQueryResult,
): WorkflowQueryParityComparison {
  const localNodeIds = localQuery.nodes.map((entry) => entry.node.id);
  const backendNodeIds = backendQuery.nodes.map((entry) => entry.node.id);
  const localMapIds = localQuery.maps.map((entry) => entry.map.id);
  const backendMapIds = backendQuery.maps.map((entry) => entry.map.id);
  const localTraceIds = localQuery.traces.map((entry) => entry.trace.id);
  const backendTraceIds = backendQuery.traces.map((entry) => entry.trace.id);
  const localCandidatePaths = collectWorkflowQueryCandidatePaths(localQuery);
  const backendCandidatePaths =
    collectWorkflowQueryCandidatePaths(backendQuery);
  const localOnly = Object.freeze({
    nodeIds: diffStringLists(localNodeIds, backendNodeIds),
    mapIds: diffStringLists(localMapIds, backendMapIds),
    traceIds: diffStringLists(localTraceIds, backendTraceIds),
    candidatePaths: diffStringLists(localCandidatePaths, backendCandidatePaths),
  });
  const backendOnly = Object.freeze({
    nodeIds: diffStringLists(backendNodeIds, localNodeIds),
    mapIds: diffStringLists(backendMapIds, localMapIds),
    traceIds: diffStringLists(backendTraceIds, localTraceIds),
    candidatePaths: diffStringLists(backendCandidatePaths, localCandidatePaths),
  });
  const ranking = Object.freeze({
    nodeIds: diffSharedRankedPositions(localNodeIds, backendNodeIds),
    mapIds: diffSharedRankedPositions(localMapIds, backendMapIds),
    traceIds: diffSharedRankedPositions(localTraceIds, backendTraceIds),
  });
  const scoreMismatches = Object.freeze({
    nodes: collectScoreMismatches(
      localQuery.nodes.map((entry) => ({
        id: entry.node.id,
        score: entry.score,
      })),
      backendQuery.nodes.map((entry) => ({
        id: entry.node.id,
        score: entry.score,
      })),
    ),
    maps: collectScoreMismatches(
      localQuery.maps.map((entry) => ({
        id: entry.map.id,
        score: entry.score,
      })),
      backendQuery.maps.map((entry) => ({
        id: entry.map.id,
        score: entry.score,
      })),
    ),
    traces: collectScoreMismatches(
      localQuery.traces.map((entry) => ({
        id: entry.trace.id,
        score: entry.score,
      })),
      backendQuery.traces.map((entry) => ({
        id: entry.trace.id,
        score: entry.score,
      })),
    ),
  });
  return Object.freeze({
    aligned:
      localOnly.nodeIds.length === 0 &&
      localOnly.mapIds.length === 0 &&
      localOnly.traceIds.length === 0 &&
      localOnly.candidatePaths.length === 0 &&
      backendOnly.nodeIds.length === 0 &&
      backendOnly.mapIds.length === 0 &&
      backendOnly.traceIds.length === 0 &&
      backendOnly.candidatePaths.length === 0 &&
      ranking.nodeIds.length === 0 &&
      ranking.mapIds.length === 0 &&
      ranking.traceIds.length === 0 &&
      scoreMismatches.nodes.length === 0 &&
      scoreMismatches.maps.length === 0 &&
      scoreMismatches.traces.length === 0,
    localOnly,
    backendOnly,
    ranking,
    scoreMismatches,
  });
}

function buildWorkflowQueryBackendReport(
  query: WorkflowGraphQueryResult,
): WorkflowQueryBackendReport {
  return Object.freeze({
    nodeHitCount: query.nodes.length,
    mapHitCount: query.maps.length,
    traceHitCount: query.traces.length,
    topNodes: Object.freeze(
      query.nodes.map((entry) =>
        Object.freeze({
          id: entry.node.id,
          label: entry.node.label,
          nodeType: entry.node.nodeType,
          ...(entry.node.filePath ? { filePath: entry.node.filePath } : {}),
          score: entry.score,
        }),
      ),
    ),
    topMaps: Object.freeze(
      query.maps.map((entry) =>
        Object.freeze({
          id: entry.map.id,
          title: entry.map.title,
          ...(entry.map.entryNodeId
            ? { entryNodeId: entry.map.entryNodeId }
            : {}),
          score: entry.score,
        }),
      ),
    ),
    topTraces: Object.freeze(
      query.traces.map((entry) =>
        Object.freeze({
          id: entry.trace.id,
          title: entry.trace.title,
          ...(entry.trace.entryNodeId
            ? { entryNodeId: entry.trace.entryNodeId }
            : {}),
          score: entry.score,
        }),
      ),
    ),
    candidatePaths: collectWorkflowQueryCandidatePaths(query),
  });
}

function buildWorkflowSubgraphBackendReport(
  subgraph: WorkflowSubgraphResult,
): WorkflowSubgraphBackendReport {
  return Object.freeze({
    nodeCount: subgraph.nodes.length,
    edgeCount: subgraph.edges.length,
    mapCount: subgraph.maps.length,
    traceCount: subgraph.traces.length,
    candidatePaths: collectSubgraphCandidatePaths(subgraph),
  });
}

function summarizeDiagnosticValues(
  label: string,
  values: readonly string[],
  limit = 5,
): string | null {
  if (values.length === 0) {
    return null;
  }
  const preview = values.slice(0, limit).join(", ");
  const suffix =
    values.length > limit ? ` (+${values.length - limit} more)` : "";
  return `${label}: ${preview}${suffix}`;
}

function summarizeScoreMismatchDetails(
  label: string,
  mismatches: readonly Readonly<{
    id: string;
    localScore: number;
    backendScore: number;
  }>[],
  limit = 4,
): string | null {
  if (mismatches.length === 0) {
    return null;
  }
  const preview = mismatches
    .slice(0, limit)
    .map((entry) => `${entry.id}(${entry.localScore}!=${entry.backendScore})`)
    .join(", ");
  const suffix =
    mismatches.length > limit ? ` (+${mismatches.length - limit} more)` : "";
  return `${label}: ${preview}${suffix}`;
}

function buildWorkflowQueryDiagnosticDetails(
  comparison: WorkflowQueryParityComparison | null,
): readonly string[] {
  if (!comparison) {
    return Object.freeze([]);
  }
  return Object.freeze(
    [
      summarizeDiagnosticValues(
        "localOnly.nodeIds",
        comparison.localOnly.nodeIds,
      ),
      summarizeDiagnosticValues(
        "localOnly.mapIds",
        comparison.localOnly.mapIds,
      ),
      summarizeDiagnosticValues(
        "localOnly.traceIds",
        comparison.localOnly.traceIds,
      ),
      summarizeDiagnosticValues(
        "localOnly.candidatePaths",
        comparison.localOnly.candidatePaths,
      ),
      summarizeDiagnosticValues(
        "backendOnly.nodeIds",
        comparison.backendOnly.nodeIds,
      ),
      summarizeDiagnosticValues(
        "backendOnly.mapIds",
        comparison.backendOnly.mapIds,
      ),
      summarizeDiagnosticValues(
        "backendOnly.traceIds",
        comparison.backendOnly.traceIds,
      ),
      summarizeDiagnosticValues(
        "backendOnly.candidatePaths",
        comparison.backendOnly.candidatePaths,
      ),
      summarizeDiagnosticValues("ranking.nodeIds", comparison.ranking.nodeIds),
      summarizeDiagnosticValues("ranking.mapIds", comparison.ranking.mapIds),
      summarizeDiagnosticValues(
        "ranking.traceIds",
        comparison.ranking.traceIds,
      ),
      summarizeScoreMismatchDetails(
        "scoreMismatches.nodes",
        comparison.scoreMismatches.nodes,
      ),
      summarizeScoreMismatchDetails(
        "scoreMismatches.maps",
        comparison.scoreMismatches.maps,
      ),
      summarizeScoreMismatchDetails(
        "scoreMismatches.traces",
        comparison.scoreMismatches.traces,
      ),
    ].filter((entry): entry is string => entry !== null),
  );
}

function buildWorkflowSubgraphDiagnosticDetails(
  comparison: WorkflowSubgraphParityComparison | null,
): readonly string[] {
  if (!comparison) {
    return Object.freeze([]);
  }
  return Object.freeze(
    [
      summarizeDiagnosticValues(
        "localOnly.nodeIds",
        comparison.localOnly.nodeIds,
      ),
      summarizeDiagnosticValues(
        "localOnly.edgeIds",
        comparison.localOnly.edgeIds,
      ),
      summarizeDiagnosticValues(
        "localOnly.mapIds",
        comparison.localOnly.mapIds,
      ),
      summarizeDiagnosticValues(
        "localOnly.traceIds",
        comparison.localOnly.traceIds,
      ),
      summarizeDiagnosticValues(
        "localOnly.candidatePaths",
        comparison.localOnly.candidatePaths,
      ),
      summarizeDiagnosticValues(
        "backendOnly.nodeIds",
        comparison.backendOnly.nodeIds,
      ),
      summarizeDiagnosticValues(
        "backendOnly.edgeIds",
        comparison.backendOnly.edgeIds,
      ),
      summarizeDiagnosticValues(
        "backendOnly.mapIds",
        comparison.backendOnly.mapIds,
      ),
      summarizeDiagnosticValues(
        "backendOnly.traceIds",
        comparison.backendOnly.traceIds,
      ),
      summarizeDiagnosticValues(
        "backendOnly.candidatePaths",
        comparison.backendOnly.candidatePaths,
      ),
    ].filter((entry): entry is string => entry !== null),
  );
}

function buildWorkflowBackendDiagnostics(opts: {
  workflowQuery: WorkflowQueryBackendReport | null;
  workflowSubgraph: WorkflowSubgraphBackendReport | null;
  queryComparison: WorkflowQueryParityComparison | null;
  subgraphComparison: WorkflowSubgraphParityComparison | null;
}): WorkflowBackendDiagnostics {
  return Object.freeze({
    query: Object.freeze({
      available: opts.workflowQuery !== null,
      aligned: opts.queryComparison?.aligned ?? null,
      details: buildWorkflowQueryDiagnosticDetails(opts.queryComparison),
    }),
    subgraph: Object.freeze({
      available: opts.workflowSubgraph !== null,
      aligned: opts.subgraphComparison?.aligned ?? null,
      details: buildWorkflowSubgraphDiagnosticDetails(opts.subgraphComparison),
    }),
  });
}

export async function buildRetrievalBenchmarkReport(opts: {
  workspacePath: string;
  queryText: string;
  limit?: number;
  mode?: RetrievalBenchmarkMode;
}): Promise<RetrievalBenchmarkReport> {
  const limit = Math.max(1, Math.min(opts.limit ?? 3, 10));
  const mode = opts.mode ?? "lexical";
  const strategy = buildRetrievalStrategy(opts.queryText);
  const workspace = getProjectStorageInfo(opts.workspacePath);
  const workflowResult =
    mode === "hybrid"
      ? await queryWorkflowGraphHybrid(
          opts.workspacePath,
          opts.queryText,
          limit,
        )
      : queryWorkflowGraph(opts.workspacePath, opts.queryText, limit);
  const entryNodeId =
    workflowResult.maps[0]?.map.entryNodeId ??
    workflowResult.traces[0]?.trace.entryNodeId ??
    workflowResult.nodes[0]?.node.id ??
    null;
  const subgraph = entryNodeId
    ? getWorkflowSubgraph(opts.workspacePath, {
        entryNodeId,
        maxHops: 3,
        maxNodes: 24,
      })
    : Object.freeze({
        nodes: Object.freeze([]),
        edges: Object.freeze([]),
        maps: Object.freeze([]),
        traces: Object.freeze([]),
      });
  const taskMemory = queryRelevantTaskMemoryLexical(
    opts.workspacePath,
    opts.queryText,
    limit,
  );
  const kuzuWorkflowQuery =
    mode === "lexical"
      ? queryWorkflowGraphFromKuzu(opts.workspacePath, opts.queryText, limit)
      : null;
  const kuzuSubgraph = entryNodeId
    ? queryWorkflowSubgraphFromKuzu(opts.workspacePath, {
        entryNodeId,
        maxHops: 3,
        maxNodes: 24,
      })
    : null;
  const kuzuQueryComparison = kuzuWorkflowQuery
    ? buildWorkflowQueryComparison(workflowResult, kuzuWorkflowQuery)
    : null;
  const kuzuComparison = kuzuSubgraph
    ? buildWorkflowSubgraphComparison(subgraph, kuzuSubgraph)
    : null;
  const kuzuDiagnostics = buildWorkflowBackendDiagnostics({
    workflowQuery: kuzuWorkflowQuery
      ? buildWorkflowQueryBackendReport(kuzuWorkflowQuery)
      : null,
    workflowSubgraph: kuzuSubgraph
      ? buildWorkflowSubgraphBackendReport(kuzuSubgraph)
      : null,
    queryComparison: kuzuQueryComparison,
    subgraphComparison: kuzuComparison,
  });
  const projection = buildKuzuWorkflowProjectionStats(opts.workspacePath);
  const candidatePaths = uniquePaths([
    ...collectWorkflowQueryCandidatePaths(workflowResult),
    ...collectSubgraphCandidatePaths(subgraph),
    ...taskMemory.entries.flatMap((entry) => entry.files),
    ...taskMemory.findings.flatMap((finding) =>
      finding.filePath ? [finding.filePath] : [],
    ),
    ...(kuzuWorkflowQuery
      ? collectWorkflowQueryCandidatePaths(kuzuWorkflowQuery)
      : []),
    ...(kuzuSubgraph ? collectSubgraphCandidatePaths(kuzuSubgraph) : []),
  ]);

  return Object.freeze({
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.workspacePath,
    queryText: opts.queryText,
    mode,
    retrieval: Object.freeze({
      primaryIntent: strategy.classification.primaryIntent,
      secondaryIntents: strategy.classification.secondaryIntents,
      requiresExactEvidence: strategy.classification.requiresExactEvidence,
      signals: strategy.classification.signals,
      stageOrder: strategy.stagePlan.stageOrder,
      promptBlocks: strategy.promptBlocks,
      stopTarget: strategy.stagePlan.stopTarget,
    }),
    workflow: Object.freeze({
      nodeHitCount: workflowResult.nodes.length,
      mapHitCount: workflowResult.maps.length,
      traceHitCount: workflowResult.traces.length,
      entryNodeId,
      topNodes: Object.freeze(
        workflowResult.nodes.map((entry) =>
          Object.freeze({
            id: entry.node.id,
            label: entry.node.label,
            nodeType: entry.node.nodeType,
            ...(entry.node.filePath ? { filePath: entry.node.filePath } : {}),
            score: entry.score,
          }),
        ),
      ),
      topMaps: Object.freeze(
        workflowResult.maps.map((entry) =>
          Object.freeze({
            id: entry.map.id,
            title: entry.map.title,
            ...(entry.map.entryNodeId
              ? { entryNodeId: entry.map.entryNodeId }
              : {}),
            score: entry.score,
          }),
        ),
      ),
      topTraces: Object.freeze(
        workflowResult.traces.map((entry) =>
          Object.freeze({
            id: entry.trace.id,
            title: entry.trace.title,
            ...(entry.trace.entryNodeId
              ? { entryNodeId: entry.trace.entryNodeId }
              : {}),
            score: entry.score,
          }),
        ),
      ),
      subgraph: Object.freeze({
        nodeCount: subgraph.nodes.length,
        edgeCount: subgraph.edges.length,
        mapCount: subgraph.maps.length,
        traceCount: subgraph.traces.length,
        candidatePaths: collectSubgraphCandidatePaths(subgraph),
      }),
    }),
    taskMemory: Object.freeze({
      entryHitCount: taskMemory.entries.length,
      findingHitCount: taskMemory.findings.length,
      topEntries: Object.freeze(
        taskMemory.entries.map((entry) =>
          Object.freeze({
            turnId: entry.turnId,
            turnKind: entry.turnKind,
            userIntent: entry.userIntent,
            files: entry.files,
            createdAt: entry.createdAt,
          }),
        ),
      ),
      topFindings: Object.freeze(
        taskMemory.findings.map((finding) =>
          Object.freeze({
            id: finding.id,
            entryTurnId: finding.entryTurnId,
            kind: finding.kind,
            summary: finding.summary,
            ...(finding.filePath ? { filePath: finding.filePath } : {}),
            ...(typeof finding.line === "number" ? { line: finding.line } : {}),
            status: finding.status,
          }),
        ),
      ),
    }),
    projection,
    kuzuWorkflowQuery: kuzuWorkflowQuery
      ? buildWorkflowQueryBackendReport(kuzuWorkflowQuery)
      : null,
    kuzuSubgraph: kuzuSubgraph
      ? buildWorkflowSubgraphBackendReport(kuzuSubgraph)
      : null,
    kuzuComparison,
    kuzuQueryComparison,
    kuzuDiagnostics,
    candidatePaths,
  });
}
