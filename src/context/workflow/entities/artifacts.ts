/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Shared workflow artifact entity shapes used by artifact-building helpers.
 */

import type { WorkflowEdgeRecord, WorkflowMapRecord, WorkflowMapSourceRecord, WorkflowNodeRecord, WorkflowTraceSummaryRecord } from './graph';

/**
 * Compact workflow subgraph built around a promoted entry node before artifact synthesis.
 */
export type WorkflowSnapshotSubgraph = Readonly<{
  /** Entry node that anchors the artifact. */
  entryNode: WorkflowNodeRecord;
  /** Reachable nodes retained in the artifact subgraph. */
  nodes: readonly WorkflowNodeRecord[];
  /** Reachable edges retained in the artifact subgraph. */
  edges: readonly WorkflowEdgeRecord[];
}>;

/**
 * Shared input required to synthesize workflow artifacts from a graph snapshot.
 */
export type WorkflowArtifactBuildInput = Readonly<{
  /** Full node set available in the current workflow snapshot. */
  nodes: readonly WorkflowNodeRecord[];
  /** Full edge set available in the current workflow snapshot. */
  edges: readonly WorkflowEdgeRecord[];
}>;

/**
 * Aggregated workflow artifacts emitted from a graph snapshot.
 */
export type WorkflowArtifactBuildResult = Readonly<{
  /** Workflow maps promoted from selected entry nodes. */
  maps: readonly WorkflowMapRecord[];
  /** Source references linking workflow maps back to node and edge ids. */
  mapSources: readonly WorkflowMapSourceRecord[];
  /** Narrative traces paired with workflow maps. */
  traceSummaries: readonly WorkflowTraceSummaryRecord[];
}>;
