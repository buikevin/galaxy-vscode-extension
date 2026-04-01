/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow graph entities and shared type definitions with field-level documentation.
 */

/**
 * Structured provenance metadata describing how a workflow entity was derived.
 */
export type WorkflowProvenance = Readonly<Record<string, unknown>>;

/**
 * Artifact kinds stored for workflow-oriented retrieval.
 */
export type WorkflowArtifactKind = 'workflow_map' | 'workflow_trace';

/**
 * Normalized workflow artifact persisted for semantic retrieval.
 */
export type WorkflowArtifactRecord = Readonly<{
  /** Stable artifact id. */
  id: string;
  /** Artifact category used for storage and reranking. */
  kind: WorkflowArtifactKind;
  /** Owning workspace id. */
  workspaceId: string;
  /** Entry node id when the artifact is anchored to a specific flow node. */
  entryNodeId?: string;
  /** Human-readable artifact title. */
  title: string;
  /** Main artifact content used for retrieval. */
  content: string;
  /** Optional lexical hint text for retrieval. */
  queryHint?: string;
  /** Confidence score of the generated artifact. */
  confidence: number;
  /** Source hash used for invalidation and re-embedding. */
  sourceHash: string;
  /** Last update timestamp in milliseconds. */
  updatedAt: number;
}>;

/**
 * Persisted workflow graph node record.
 */
export type WorkflowNodeRecord = Readonly<{
  /** Stable node id. */
  id: string;
  /** Optional owning workspace id. */
  workspaceId?: string;
  /** Workflow node classification such as screen, service, or api_endpoint. */
  nodeType: string;
  /** Display label for the node. */
  label: string;
  /** Backing file path when the node comes from source code. */
  filePath?: string;
  /** Associated symbol name when the node maps to a code symbol. */
  symbolName?: string;
  /** HTTP method for route-like nodes. */
  routeMethod?: string;
  /** Route path for endpoint-like nodes. */
  routePath?: string;
  /** 1-based start line in the source file. */
  startLine?: number;
  /** 1-based end line in the source file. */
  endLine?: number;
  /** Short description for retrieval and summaries. */
  description?: string;
  /** Origin of the description text. */
  descriptionSource?: string;
  /** Confidence score for the node extraction. */
  confidence?: number;
  /** Provenance metadata for the node. */
  provenance?: WorkflowProvenance;
  /** Source hash for invalidation. */
  sourceHash?: string;
  /** Creation timestamp in milliseconds. */
  createdAt: number;
  /** Update timestamp in milliseconds. */
  updatedAt?: number;
}>;

/**
 * Persisted workflow graph edge record.
 */
export type WorkflowEdgeRecord = Readonly<{
  /** Stable edge id. */
  id: string;
  /** Optional owning workspace id. */
  workspaceId?: string;
  /** Source node id. */
  fromNodeId: string;
  /** Target node id. */
  toNodeId: string;
  /** Workflow edge type such as calls, routes_to, or publishes. */
  edgeType: string;
  /** Optional display label. */
  label?: string;
  /** Confidence score for the edge extraction. */
  confidence?: number;
  /** Provenance metadata for the edge. */
  provenance?: WorkflowProvenance;
  /** File path that supports this edge. */
  supportingFilePath?: string;
  /** Symbol name that supports this edge. */
  supportingSymbolName?: string;
  /** 1-based supporting line number. */
  supportingLine?: number;
  /** Source hash for invalidation. */
  sourceHash?: string;
  /** Creation timestamp in milliseconds. */
  createdAt: number;
  /** Update timestamp in milliseconds. */
  updatedAt?: number;
}>;

/**
 * Persisted workflow summary map record.
 */
export type WorkflowMapRecord = Readonly<{
  /** Stable workflow map id. */
  id: string;
  /** Optional owning workspace id. */
  workspaceId?: string;
  /** Flow category such as request_flow or async_flow. */
  mapType: string;
  /** Entry node id anchoring the map. */
  entryNodeId?: string;
  /** Human-readable map title. */
  title: string;
  /** Short map summary. */
  summary: string;
  /** Confidence score for the map. */
  confidence?: number;
  /** Source hash used to detect stale artifacts. */
  sourceHash?: string;
  /** Generation timestamp in milliseconds. */
  generatedAt: number;
  /** Update timestamp in milliseconds. */
  updatedAt?: number;
}>;

/**
 * Mapping between workflow maps and their backing nodes or edges.
 */
export type WorkflowMapSourceRecord = Readonly<{
  /** Owning workflow map id. */
  workflowMapId: string;
  /** Source category such as node or edge. */
  sourceKind: string;
  /** Referenced source id. */
  sourceRef: string;
  /** Source hash that ties the source set to the artifact. */
  sourceHash?: string;
}>;

/**
 * Persisted workflow trace narrative record.
 */
export type WorkflowTraceSummaryRecord = Readonly<{
  /** Stable trace id. */
  id: string;
  /** Optional owning workspace id. */
  workspaceId?: string;
  /** Trace category such as request_flow or async_flow. */
  traceKind: string;
  /** Entry node id anchoring the trace. */
  entryNodeId?: string;
  /** Human-readable trace title. */
  title: string;
  /** Optional query hint text to improve retrieval. */
  queryHint?: string;
  /** Full trace narrative. */
  narrative: string;
  /** Confidence score for the trace. */
  confidence?: number;
  /** Source hash used to detect stale traces. */
  sourceHash?: string;
  /** Generation timestamp in milliseconds. */
  generatedAt: number;
  /** Update timestamp in milliseconds. */
  updatedAt?: number;
}>;

/**
 * In-memory workflow graph snapshot used for persistence and retrieval.
 */
export type WorkflowGraphSnapshot = Readonly<{
  /** Extracted workflow nodes. */
  nodes: readonly WorkflowNodeRecord[];
  /** Extracted workflow edges. */
  edges: readonly WorkflowEdgeRecord[];
  /** Optional derived workflow summary maps. */
  maps?: readonly WorkflowMapRecord[];
  /** Optional links between maps and their sources. */
  mapSources?: readonly WorkflowMapSourceRecord[];
  /** Optional derived workflow trace narratives. */
  traceSummaries?: readonly WorkflowTraceSummaryRecord[];
}>;

/**
 * Read-only workflow node shape returned to retrieval callers.
 */
export type WorkflowNodeSummary = Readonly<{
  /** Stable node id. */
  id: string;
  /** Workflow node classification. */
  nodeType: string;
  /** Display label. */
  label: string;
  /** Backing file path when available. */
  filePath?: string;
  /** Associated symbol name when available. */
  symbolName?: string;
  /** HTTP method for route-like nodes. */
  routeMethod?: string;
  /** Route path for route-like nodes. */
  routePath?: string;
  /** 1-based start line. */
  startLine?: number;
  /** 1-based end line. */
  endLine?: number;
  /** Short description for retrieval. */
  description?: string;
  /** Source of the description text. */
  descriptionSource?: string;
  /** Confidence score. */
  confidence: number;
  /** Provenance metadata. */
  provenance?: WorkflowProvenance;
  /** Source hash for invalidation. */
  sourceHash?: string;
  /** Creation timestamp. */
  createdAt: number;
  /** Update timestamp. */
  updatedAt: number;
}>;

/**
 * Read-only workflow edge shape returned to retrieval callers.
 */
export type WorkflowEdgeSummary = Readonly<{
  /** Stable edge id. */
  id: string;
  /** Source node id. */
  fromNodeId: string;
  /** Target node id. */
  toNodeId: string;
  /** Workflow edge type. */
  edgeType: string;
  /** Optional display label. */
  label?: string;
  /** Confidence score. */
  confidence: number;
  /** Provenance metadata. */
  provenance?: WorkflowProvenance;
  /** Supporting file path. */
  supportingFilePath?: string;
  /** Supporting symbol name. */
  supportingSymbolName?: string;
  /** Supporting line number. */
  supportingLine?: number;
  /** Source hash for invalidation. */
  sourceHash?: string;
  /** Creation timestamp. */
  createdAt: number;
  /** Update timestamp. */
  updatedAt: number;
}>;

/**
 * Read-only workflow map summary returned to retrieval callers.
 */
export type WorkflowMapSummary = Readonly<{
  /** Stable map id. */
  id: string;
  /** Map category. */
  mapType: string;
  /** Entry node id when available. */
  entryNodeId?: string;
  /** Display title. */
  title: string;
  /** Summary text. */
  summary: string;
  /** Confidence score. */
  confidence: number;
  /** Source hash for invalidation. */
  sourceHash?: string;
  /** Generation timestamp. */
  generatedAt: number;
  /** Update timestamp. */
  updatedAt: number;
}>;

/**
 * Read-only workflow trace summary returned to retrieval callers.
 */
export type WorkflowTraceSummary = Readonly<{
  /** Stable trace id. */
  id: string;
  /** Trace category. */
  traceKind: string;
  /** Entry node id when available. */
  entryNodeId?: string;
  /** Display title. */
  title: string;
  /** Optional query hint. */
  queryHint?: string;
  /** Narrative text. */
  narrative: string;
  /** Confidence score. */
  confidence: number;
  /** Source hash for invalidation. */
  sourceHash?: string;
  /** Generation timestamp. */
  generatedAt: number;
  /** Update timestamp. */
  updatedAt: number;
}>;

/**
 * Ranked workflow retrieval result returned by lexical and semantic lookup.
 */
export type WorkflowGraphQueryResult = Readonly<{
  /** Ranked matching nodes. */
  nodes: readonly Readonly<{ node: WorkflowNodeSummary; score: number }>[];
  /** Ranked matching workflow maps. */
  maps: readonly Readonly<{ map: WorkflowMapSummary; score: number }>[];
  /** Ranked matching workflow traces. */
  traces: readonly Readonly<{ trace: WorkflowTraceSummary; score: number }>[];
}>;

/**
 * Expanded workflow subgraph returned for a chosen entry node.
 */
export type WorkflowSubgraphResult = Readonly<{
  /** Selected entry node when found. */
  entryNode?: WorkflowNodeSummary;
  /** Expanded node set. */
  nodes: readonly WorkflowNodeSummary[];
  /** Expanded edge set. */
  edges: readonly WorkflowEdgeSummary[];
  /** Workflow maps tied to the entry node. */
  maps: readonly WorkflowMapSummary[];
  /** Workflow traces tied to the entry node. */
  traces: readonly WorkflowTraceSummary[];
}>;
