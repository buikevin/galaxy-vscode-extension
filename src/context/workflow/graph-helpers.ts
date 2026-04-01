/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Shared workflow graph helper functions, row mappers, and scoring utilities.
 */

import type {
  WorkflowArtifactRecord,
  WorkflowEdgeSummary,
  WorkflowMapSummary,
  WorkflowNodeSummary,
  WorkflowProvenance,
  WorkflowTraceSummary,
} from './entities/graph';
import type {
  WorkflowEdgeRow,
  WorkflowMapRow,
  WorkflowNodeRow,
  WorkflowTraceRow,
} from './entities/storage';

/**
 * Tokenizes a workflow query into stable lowercase lookup terms.
 */
export function tokenizeWorkflowQuery(text: string): readonly string[] {
  return Object.freeze(
    [...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .filter((token) => token.length >= 2),
    )],
  );
}

/**
 * Serializes workflow provenance for SQLite storage.
 */
export function serializeWorkflowProvenance(provenance?: WorkflowProvenance): string | null {
  return provenance ? JSON.stringify(provenance) : null;
}

/**
 * Parses workflow provenance from SQLite storage.
 */
export function parseWorkflowProvenance(raw: string | null): WorkflowProvenance | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.freeze(parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sorts scored workflow results and trims them to the requested limit.
 */
export function sortWorkflowScoredResults<T>(
  values: Iterable<[string, T]>,
  scores: ReadonlyMap<string, number>,
  limit: number,
): readonly Readonly<{ value: T; score: number }>[] {
  return Object.freeze(
    [...values]
      .map(([id, value]) => Object.freeze({ value, score: scores.get(id) ?? 0 }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit),
  );
}

/**
 * Maps a SQLite node row into a workflow node summary.
 */
export function mapWorkflowNodeRow(row: WorkflowNodeRow): WorkflowNodeSummary {
  const provenance = parseWorkflowProvenance(row.provenance_json);
  return Object.freeze({
    id: row.id,
    nodeType: row.node_type,
    label: row.label,
    ...(row.file_path ? { filePath: row.file_path } : {}),
    ...(row.symbol_name ? { symbolName: row.symbol_name } : {}),
    ...(row.route_method ? { routeMethod: row.route_method } : {}),
    ...(row.route_path ? { routePath: row.route_path } : {}),
    ...(typeof row.start_line === 'number' ? { startLine: row.start_line } : {}),
    ...(typeof row.end_line === 'number' ? { endLine: row.end_line } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.description_source ? { descriptionSource: row.description_source } : {}),
    confidence: row.confidence,
    ...(provenance ? { provenance } : {}),
    ...(row.source_hash ? { sourceHash: row.source_hash } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Maps a SQLite edge row into a workflow edge summary.
 */
export function mapWorkflowEdgeRow(row: WorkflowEdgeRow): WorkflowEdgeSummary {
  const provenance = parseWorkflowProvenance(row.provenance_json);
  return Object.freeze({
    id: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    edgeType: row.edge_type,
    ...(row.label ? { label: row.label } : {}),
    confidence: row.confidence,
    ...(provenance ? { provenance } : {}),
    ...(row.supporting_file_path ? { supportingFilePath: row.supporting_file_path } : {}),
    ...(row.supporting_symbol_name ? { supportingSymbolName: row.supporting_symbol_name } : {}),
    ...(typeof row.supporting_line === 'number' ? { supportingLine: row.supporting_line } : {}),
    ...(row.source_hash ? { sourceHash: row.source_hash } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Maps a SQLite workflow map row into a workflow map summary.
 */
export function mapWorkflowMapRow(row: WorkflowMapRow): WorkflowMapSummary {
  return Object.freeze({
    id: row.id,
    mapType: row.map_type,
    ...(row.entry_node_id ? { entryNodeId: row.entry_node_id } : {}),
    title: row.title,
    summary: row.summary,
    confidence: row.confidence,
    ...(row.source_hash ? { sourceHash: row.source_hash } : {}),
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Maps a SQLite trace row into a workflow trace summary.
 */
export function mapWorkflowTraceRow(row: WorkflowTraceRow): WorkflowTraceSummary {
  return Object.freeze({
    id: row.id,
    traceKind: row.trace_kind,
    ...(row.entry_node_id ? { entryNodeId: row.entry_node_id } : {}),
    title: row.title,
    ...(row.query_hint ? { queryHint: row.query_hint } : {}),
    narrative: row.narrative,
    confidence: row.confidence,
    ...(row.source_hash ? { sourceHash: row.source_hash } : {}),
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Builds a workspace-scoped embedding cache key for workflow artifacts.
 */
export function buildWorkflowArtifactEmbeddingId(workspaceId: string, artifactId: string): string {
  return `${workspaceId}:${artifactId}`;
}

/**
 * Builds a stable Chroma collection name for workflow artifacts.
 */
export function buildWorkflowArtifactCollectionName(workspaceId: string): string {
  return `galaxy-workflow-artifacts-v1-${workspaceId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
}

/**
 * Builds an embedding document for workflow artifact retrieval.
 */
export function buildWorkflowArtifactDocument(artifact: WorkflowArtifactRecord): string {
  return [
    `Artifact kind: ${artifact.kind}`,
    `Title: ${artifact.title}`,
    artifact.entryNodeId ? `Entry node: ${artifact.entryNodeId}` : '',
    artifact.queryHint ? `Query hint: ${artifact.queryHint}` : '',
    `Content: ${artifact.content}`,
  ].filter(Boolean).join('\n');
}

/**
 * Parses a stored embedding vector from SQLite.
 */
export function parseStoredWorkflowEmbedding(raw: string): readonly number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? Object.freeze(parsed.filter((item): item is number => typeof item === 'number'))
      : null;
  } catch {
    return null;
  }
}

/**
 * Applies a timeout to a promise used inside workflow retrieval.
 */
export async function withWorkflowTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return await Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * Combines lexical and semantic signals into a single workflow artifact score.
 */
export function combineWorkflowArtifactScore(opts: {
  lexicalScore: number;
  localSemanticScore: number;
  chromaScore: number;
  confidence: number;
}): number {
  const lexicalScore = opts.lexicalScore;
  const localSemanticScore = opts.localSemanticScore >= 0.18 ? opts.localSemanticScore : 0;
  const chromaScore = opts.chromaScore >= 0.18 ? opts.chromaScore : 0;
  const score = lexicalScore + localSemanticScore * 12 + chromaScore * 8;
  if (score <= 0) {
    return 0;
  }
  return score + Math.max(0.4, opts.confidence) * 1.5;
}
