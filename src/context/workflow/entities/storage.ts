/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow storage row entities used by SQLite row mappers.
 */

/**
 * Raw SQLite row shape for a persisted workflow node.
 */
export type WorkflowNodeRow = Readonly<{
  /** Stable node id. */
  id: string;
  /** Stored node classification column. */
  node_type: string;
  /** Stored node label column. */
  label: string;
  /** Backing file path column. */
  file_path: string | null;
  /** Associated symbol column. */
  symbol_name: string | null;
  /** Route method column for route-like nodes. */
  route_method: string | null;
  /** Route path column for route-like nodes. */
  route_path: string | null;
  /** Stored start line column. */
  start_line: number | null;
  /** Stored end line column. */
  end_line: number | null;
  /** Stored description column. */
  description: string | null;
  /** Stored description source column. */
  description_source: string | null;
  /** Stored confidence column. */
  confidence: number;
  /** Serialized provenance JSON column. */
  provenance_json: string | null;
  /** Stored source hash column. */
  source_hash: string | null;
  /** Stored creation timestamp column. */
  created_at: number;
  /** Stored update timestamp column. */
  updated_at: number;
}>;

/**
 * Raw SQLite row shape for a persisted workflow edge.
 */
export type WorkflowEdgeRow = Readonly<{
  /** Stable edge id. */
  id: string;
  /** Source node id column. */
  from_node_id: string;
  /** Target node id column. */
  to_node_id: string;
  /** Stored edge type column. */
  edge_type: string;
  /** Optional label column. */
  label: string | null;
  /** Stored confidence column. */
  confidence: number;
  /** Serialized provenance JSON column. */
  provenance_json: string | null;
  /** Supporting file path column. */
  supporting_file_path: string | null;
  /** Supporting symbol name column. */
  supporting_symbol_name: string | null;
  /** Supporting line column. */
  supporting_line: number | null;
  /** Stored source hash column. */
  source_hash: string | null;
  /** Stored creation timestamp column. */
  created_at: number;
  /** Stored update timestamp column. */
  updated_at: number;
}>;

/**
 * Raw SQLite row shape for a persisted workflow map summary.
 */
export type WorkflowMapRow = Readonly<{
  /** Stable workflow map id. */
  id: string;
  /** Stored map type column. */
  map_type: string;
  /** Entry node id column. */
  entry_node_id: string | null;
  /** Stored title column. */
  title: string;
  /** Stored summary column. */
  summary: string;
  /** Stored confidence column. */
  confidence: number;
  /** Stored source hash column. */
  source_hash: string | null;
  /** Stored generation timestamp column. */
  generated_at: number;
  /** Stored update timestamp column. */
  updated_at: number;
}>;

/**
 * Raw SQLite row shape for a persisted workflow trace summary.
 */
export type WorkflowTraceRow = Readonly<{
  /** Stable workflow trace id. */
  id: string;
  /** Stored trace kind column. */
  trace_kind: string;
  /** Entry node id column. */
  entry_node_id: string | null;
  /** Stored title column. */
  title: string;
  /** Optional query hint column. */
  query_hint: string | null;
  /** Stored narrative column. */
  narrative: string;
  /** Stored confidence column. */
  confidence: number;
  /** Stored source hash column. */
  source_hash: string | null;
  /** Stored generation timestamp column. */
  generated_at: number;
  /** Stored update timestamp column. */
  updated_at: number;
}>;
