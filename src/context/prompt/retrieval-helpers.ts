/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Prompt retrieval helper functions for path affinity, flow detection, and workflow context blocks.
 */

import type { WorkflowNodeSummary } from "../workflow/entities/graph";
import { queryWorkflowGraphHybrid } from "../workflow/query/index";
import { getWorkflowSubgraph } from "../workflow/query/index";
import { flushWorkflowTouchQueue } from "../workflow/extractor/touch-queue";
import type { SyntaxContextRecordSummary } from "../entities/syntax-index";
import {
  isFlowQuery,
  shouldEnableWorkflowRereadGuard,
} from "../retrieval-core";

export { isFlowQuery, shouldEnableWorkflowRereadGuard };

/**
 * Workflow retrieval block used by prompt-builder.
 */
export type WorkflowRetrievalBlock = Readonly<{
  flowQuery: boolean;
  content: string;
  overviewContent: string;
  matchedNodesContent: string;
  graphPathContent: string;
  workflowSummariesContent: string;
  traceNarrativesContent: string;
  candidatePaths: readonly string[];
  pathScores: Readonly<Record<string, number>>;
  entryCount: number;
}>;

function joinWorkflowSectionContents(sections: readonly string[]): string {
  return sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join("\n\n")
    .trim();
}

/**
 * Extracts likely file paths mentioned in a user query.
 */
export function extractMentionedPaths(text: string): readonly string[] {
  const matches = text.match(/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g) ?? [];
  return Object.freeze(matches);
}

/**
 * Extracts stable identifiers from a user query for lexical retrieval.
 */
export function extractQueryIdentifiers(text: string): readonly string[] {
  const matches = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? [];
  return Object.freeze(
    [...new Set(matches.map((item) => item.toLowerCase()))].slice(0, 24),
  );
}

/**
 * Splits a path into normalized search tokens.
 */
export function buildPathTokens(relativePath: string): readonly string[] {
  const normalized = relativePath.toLowerCase();
  const segments = normalized
    .split("/")
    .flatMap((segment) => segment.split(/[^a-z0-9_]+/));
  return Object.freeze([
    ...new Set(segments.filter((segment) => segment.length >= 2)),
  ]);
}

/**
 * Computes how strongly a path matches a set of candidate paths.
 */
export function scorePathAffinity(
  relativePath: string,
  candidates: readonly string[],
): number {
  if (candidates.length === 0) {
    return 0;
  }

  const lowerPath = relativePath.toLowerCase();
  const basename = lowerPath.split("/").at(-1) ?? lowerPath;
  let score = 0;

  candidates.forEach((candidate) => {
    const normalized = candidate.toLowerCase();
    if (lowerPath === normalized) {
      score += 12;
      return;
    }
    if (basename === normalized.split("/").at(-1)) {
      score += 8;
      return;
    }
    if (lowerPath.includes(normalized) || normalized.includes(lowerPath)) {
      score += 5;
      return;
    }

    const candidateTokens = buildPathTokens(normalized);
    const tokenHits = candidateTokens.filter((token) =>
      lowerPath.includes(token),
    ).length;
    if (tokenHits > 0) {
      score += Math.min(tokenHits, 2) * 2;
    }
  });

  return score;
}

/**
 * Scores query identifier hits against a syntax summary record.
 */
export function scoreQueryIdentifierHits(opts: {
  record: SyntaxContextRecordSummary;
  queryIdentifiers: readonly string[];
}): Readonly<{
  score: number;
  reasons: readonly string[];
}> {
  const reasons: string[] = [];
  let score = 0;
  const lowerPath = opts.record.relativePath.toLowerCase();
  const basename = lowerPath.split("/").at(-1) ?? lowerPath;

  const addReason = (reason: string, points: number): void => {
    score += points;
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  opts.queryIdentifiers.forEach((identifier) => {
    if (
      basename === identifier ||
      basename.startsWith(`${identifier}.`) ||
      basename.includes(`${identifier}.`)
    ) {
      addReason(`query basename hit ${identifier}`, 6);
      return;
    }

    if (
      lowerPath.includes(`/${identifier}/`) ||
      lowerPath.endsWith(`/${identifier}`)
    ) {
      addReason(`query segment hit ${identifier}`, 5);
      return;
    }

    if (lowerPath.includes(identifier)) {
      addReason(`query path hit ${identifier}`, 3);
    }

    if (
      opts.record.symbols.some(
        (symbol) => symbol.name.toLowerCase() === identifier,
      ) ||
      opts.record.exports.some((item) => item.toLowerCase() === identifier)
    ) {
      addReason(`query exact symbol ${identifier}`, 5);
      return;
    }

    if (
      opts.record.symbols.some((symbol) =>
        symbol.name.toLowerCase().includes(identifier),
      ) ||
      opts.record.exports.some((item) =>
        item.toLowerCase().includes(identifier),
      ) ||
      opts.record.imports.some((item) =>
        item.toLowerCase().includes(identifier),
      )
    ) {
      addReason(`query symbol hit ${identifier}`, 2);
    }
  });

  return Object.freeze({
    score,
    reasons: Object.freeze(reasons),
  });
}

/**
 * Deduplicates paths while preserving order.
 */
export function uniquePaths(
  paths: readonly string[],
  maxItems?: number,
): readonly string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  paths.forEach((candidate) => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    next.push(trimmed);
  });
  return Object.freeze(
    typeof maxItems === "number" ? next.slice(0, maxItems) : next,
  );
}

/**
 * Takes the most recent unique paths from a list.
 */
export function takeRecentPaths(
  paths: readonly string[],
  maxItems: number,
): readonly string[] {
  return uniquePaths(paths.slice(-maxItems));
}

/**
 * Selects project key files that best match the current query.
 */
export function selectProjectHintPaths(
  queryText: string,
  projectKeyFiles: readonly string[],
): readonly string[] {
  const identifiers = extractQueryIdentifiers(queryText);
  if (projectKeyFiles.length === 0) {
    return Object.freeze([]);
  }

  if (identifiers.length === 0) {
    return takeRecentPaths(projectKeyFiles, 2);
  }

  const matched = projectKeyFiles.filter((filePath) => {
    const lowered = filePath.toLowerCase();
    return identifiers.some((identifier) => lowered.includes(identifier));
  });

  if (matched.length > 0) {
    return takeRecentPaths(matched, 3);
  }

  return takeRecentPaths(projectKeyFiles, 1);
}

/**
 * Formats a workflow node label for prompt display.
 */
export function formatWorkflowNodeLabel(node: WorkflowNodeSummary): string {
  return `[${node.nodeType}] ${node.label}`;
}

/**
 * Adds bounded workflow path score to a candidate file.
 */
export function addWorkflowPathScore(
  scores: Map<string, number>,
  filePath: string | undefined,
  amount: number,
): void {
  if (!filePath || amount <= 0) {
    return;
  }
  scores.set(filePath, Math.min(24, (scores.get(filePath) ?? 0) + amount));
}

/**
 * Builds the workflow retrieval prompt block.
 *
 * Phase 5: this no longer gates on `isFlowQuery`. The workflow graph is kept warm by the
 * touch queue (Phase 2) and bootstrap (Phase 3); we always query it and return an empty
 * block when there are no hits. Heavy `refreshWorkflowGraph` was replaced by a cheap
 * `flushWorkflowTouchQueue` so cold or stale queues still get primed without re-walking
 * the entire workspace. `isFlowQuery` is still consulted for `flowQuery` so block
 * ordering / `classifyRetrievalIntent` can prioritize flow-style questions.
 */
export async function buildWorkflowRetrievalBlock(opts: {
  workspacePath: string;
  queryText: string;
  workingTurnFiles: readonly string[];
  mentionedPaths: readonly string[];
}): Promise<WorkflowRetrievalBlock> {
  const flowQuery = isFlowQuery(opts.queryText);

  let queryResult = await queryWorkflowGraphHybrid(
    opts.workspacePath,
    opts.queryText,
    4,
  );
  const hasInitialHits =
    queryResult.nodes.length > 0 ||
    queryResult.maps.length > 0 ||
    queryResult.traces.length > 0;
  if (!hasInitialHits) {
    // Cheap fallback: drain whatever the touch queue already has so a recent read can
    // contribute its nodes/edges before we give up. Avoids the heavy full re-extract.
    await flushWorkflowTouchQueue(opts.workspacePath);
    queryResult = await queryWorkflowGraphHybrid(
      opts.workspacePath,
      opts.queryText,
      4,
    );
  }

  const hasHits =
    queryResult.nodes.length > 0 ||
    queryResult.maps.length > 0 ||
    queryResult.traces.length > 0;
  if (!hasHits) {
    return Object.freeze({
      flowQuery,
      content: "",
      overviewContent: "",
      matchedNodesContent: "",
      graphPathContent: "",
      workflowSummariesContent: "",
      traceNarrativesContent: "",
      candidatePaths: Object.freeze([]),
      pathScores: Object.freeze({}),
      entryCount: 0,
    });
  }

  const entryNodeId =
    queryResult.maps[0]?.map.entryNodeId ??
    queryResult.traces[0]?.trace.entryNodeId ??
    queryResult.nodes[0]?.node.id;
  const subgraph = entryNodeId
    ? getWorkflowSubgraph(opts.workspacePath, {
        entryNodeId,
        maxHops: 3,
        maxNodes: 12,
      })
    : null;
  const nodeLookup = new Map(
    (subgraph?.nodes ?? []).map((node) => [node.id, node] as const),
  );
  const workflowPathScores = new Map<string, number>();
  const candidatePaths = uniquePaths(
    [
      ...(subgraph?.nodes.flatMap((node) =>
        node.filePath ? [node.filePath] : [],
      ) ?? []),
      ...(subgraph?.edges.flatMap((edge) =>
        edge.supportingFilePath ? [edge.supportingFilePath] : [],
      ) ?? []),
      ...queryResult.nodes.flatMap((entry) =>
        entry.node.filePath ? [entry.node.filePath] : [],
      ),
    ],
    10,
  );

  queryResult.nodes.forEach((entry, index) => {
    addWorkflowPathScore(
      workflowPathScores,
      entry.node.filePath,
      Math.max(
        4,
        Math.min(12, Math.round(entry.score * 0.6) + (index === 0 ? 2 : 0)),
      ),
    );
  });
  if (subgraph?.entryNode) {
    addWorkflowPathScore(
      workflowPathScores,
      subgraph.entryNode.filePath,
      Math.max(8, Math.round(subgraph.entryNode.confidence * 10)),
    );
  }
  (subgraph?.nodes ?? []).forEach((node) => {
    addWorkflowPathScore(
      workflowPathScores,
      node.filePath,
      Math.max(2, Math.round(node.confidence * 5)),
    );
  });
  (subgraph?.edges ?? []).forEach((edge) => {
    addWorkflowPathScore(
      workflowPathScores,
      edge.supportingFilePath,
      Math.max(2, Math.round(edge.confidence * 4)),
    );
  });

  const overviewLines: string[] = ["[WORKFLOW GRAPH RETRIEVAL]"];
  if (subgraph?.entryNode) {
    overviewLines.push(
      `Entry: ${formatWorkflowNodeLabel(subgraph.entryNode)} (confidence ${subgraph.entryNode.confidence.toFixed(2)})`,
    );
  } else if (queryResult.nodes[0]) {
    overviewLines.push(
      `Entry: ${formatWorkflowNodeLabel(queryResult.nodes[0].node)} (score ${queryResult.nodes[0].score.toFixed(2)})`,
    );
  }
  if (candidatePaths.length > 0) {
    overviewLines.push(`Relevant files: ${candidatePaths.join(", ")}`);
  }
  const matchedNodesLines: string[] = [];
  if (queryResult.nodes.length > 0) {
    matchedNodesLines.push("[MATCHED NODES]");
    queryResult.nodes.slice(0, 4).forEach((entry) => {
      const location = entry.node.filePath
        ? `${entry.node.filePath}${typeof entry.node.startLine === "number" ? `:${entry.node.startLine}` : ""}`
        : "";
      matchedNodesLines.push(
        `- ${formatWorkflowNodeLabel(entry.node)}${location ? ` @ ${location}` : ""}`,
      );
    });
  }
  const workflowSummariesLines: string[] = [];
  if (queryResult.maps.length > 0) {
    workflowSummariesLines.push("[WORKFLOW SUMMARIES]");
    queryResult.maps.slice(0, 2).forEach((entry) => {
      workflowSummariesLines.push(`- ${entry.map.title}: ${entry.map.summary}`);
    });
  }
  const traceNarrativesLines: string[] = [];
  if (queryResult.traces.length > 0) {
    traceNarrativesLines.push("[TRACE NARRATIVES]");
    queryResult.traces.slice(0, 2).forEach((entry) => {
      traceNarrativesLines.push(
        `- ${entry.trace.title}: ${entry.trace.narrative}`,
      );
    });
  }
  const graphEdges = subgraph?.edges.slice(0, 8) ?? [];
  const graphPathLines: string[] = [];
  if (graphEdges.length > 0) {
    graphPathLines.push("[GRAPH PATH]");
    graphEdges.forEach((edge, index) => {
      const fromNode = nodeLookup.get(edge.fromNodeId);
      const toNode = nodeLookup.get(edge.toNodeId);
      graphPathLines.push(
        `${index + 1}. ${fromNode ? formatWorkflowNodeLabel(fromNode) : edge.fromNodeId} --${edge.edgeType}--> ${toNode ? formatWorkflowNodeLabel(toNode) : edge.toNodeId}`,
      );
    });
  }
  const supportingNodes =
    subgraph?.nodes
      .filter((node) => node.id !== subgraph.entryNode?.id)
      .slice(0, 6) ?? [];
  if (supportingNodes.length > 0) {
    overviewLines.push("[SUPPORTING NODES]");
    supportingNodes.forEach((node) => {
      const location = node.filePath
        ? `${node.filePath}${typeof node.startLine === "number" ? `:${node.startLine}` : ""}`
        : "";
      overviewLines.push(
        `- ${formatWorkflowNodeLabel(node)}${location ? ` @ ${location}` : ""}`,
      );
    });
  }
  overviewLines.push("Use this graph as the default system-flow context.");
  overviewLines.push(
    "Do not reread raw files just to reconstruct the flow unless exact implementation lines are needed or graph evidence is ambiguous.",
  );

  const overviewContent = overviewLines.join("\n").trim();
  const matchedNodesContent = matchedNodesLines.join("\n").trim();
  const graphPathContent = graphPathLines.join("\n").trim();
  const workflowSummariesContent = workflowSummariesLines.join("\n").trim();
  const traceNarrativesContent = traceNarrativesLines.join("\n").trim();
  const content = joinWorkflowSectionContents([
    overviewContent,
    matchedNodesContent,
    graphPathContent,
    workflowSummariesContent,
    traceNarrativesContent,
  ]);

  return Object.freeze({
    flowQuery,
    content,
    overviewContent,
    matchedNodesContent,
    graphPathContent,
    workflowSummariesContent,
    traceNarrativesContent,
    candidatePaths,
    pathScores: Object.freeze(Object.fromEntries(workflowPathScores)),
    entryCount:
      (subgraph?.nodes.length ?? queryResult.nodes.length) +
      (subgraph?.edges.length ?? 0) +
      queryResult.maps.length +
      queryResult.traces.length,
  });
}
