/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-21
 * @modify date 2026-04-21
 * @desc View-model types for graph explorer and diagram export workflows.
 */

import type { WorkflowMapSummary, WorkflowTraceSummary } from "../entities";

/**
 * Supported scopes for graph-to-view composition.
 */
export type WorkflowViewScopeKind = "entry_node" | "route" | "file";

/**
 * High-level group buckets used by explorer and diagram views.
 */
export type WorkflowViewGroupKind =
  | "frontend"
  | "backend"
  | "data"
  | "async"
  | "external"
  | "module"
  | "unknown";

/**
 * Read-only node shape used by graph explorer and export renderers.
 */
export type WorkflowViewGraphNode = Readonly<{
  /** Stable node id from the workflow graph. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Original workflow node type. */
  nodeType: string;
  /** Group bucket key used for subgraphs and swimlanes. */
  groupKey: string;
  /** Relative node importance within the selected view. */
  importanceScore: number;
  /** Backing file path when available. */
  filePath?: string;
  /** Associated symbol name when available. */
  symbolName?: string;
  /** Route path for endpoint-like nodes. */
  routePath?: string;
  /** HTTP method for route-like nodes. */
  routeMethod?: string;
  /** 1-based start line in the source file when available. */
  startLine?: number;
  /** 1-based end line in the source file when available. */
  endLine?: number;
  /** Short descriptive text. */
  description?: string;
  /** Whether this is the main selected entry node. */
  isEntry: boolean;
  /** Whether the node represents an external dependency. */
  isExternal: boolean;
}>;

/**
 * Read-only edge shape used by graph explorer and export renderers.
 */
export type WorkflowViewGraphEdge = Readonly<{
  /** Stable edge id from the workflow graph. */
  id: string;
  /** Source node id. */
  fromNodeId: string;
  /** Target node id. */
  toNodeId: string;
  /** Original workflow edge type. */
  edgeType: string;
  /** Human-readable edge label when available. */
  label?: string;
  /** Relative edge importance within the selected view. */
  importanceScore: number;
  /** Supporting file path when available. */
  supportingFilePath?: string;
  /** Supporting symbol name when available. */
  supportingSymbolName?: string;
  /** Supporting line when available. */
  supportingLine?: number;
}>;

/**
 * Group metadata used to organize nodes into higher-level layers or modules.
 */
export type WorkflowViewGraphGroup = Readonly<{
  /** Stable group key. */
  groupKey: string;
  /** Human-readable group title. */
  title: string;
  /** Group kind used for layout and color semantics. */
  kind: WorkflowViewGroupKind;
  /** UI color token suggestion. */
  colorToken: string;
  /** Node ids assigned to this group. */
  nodeIds: readonly string[];
}>;

/**
 * Composition options shared by entry, route, and file view builders.
 */
export type WorkflowViewGraphComposeOptions = Readonly<{
  /** Maximum traversal depth when expanding the graph. */
  maxHops?: number;
  /** Maximum nodes retained in the view. */
  maxNodes?: number;
  /** Whether incoming edges are allowed during subgraph expansion. */
  includeIncoming?: boolean;
  /** Optional node-type filter after expansion. */
  nodeTypes?: readonly string[];
  /** Optional edge-type filter after expansion. */
  edgeTypes?: readonly string[];
  /** Whether external dependency nodes remain in the view. Defaults to true. */
  includeExternal?: boolean;
}>;

/**
 * Stable graph view model shared by explorer, Mermaid export, and future Draw.io export.
 */
export type WorkflowViewGraphModel = Readonly<{
  /** Scope kind that produced this graph view. */
  scopeKind: WorkflowViewScopeKind;
  /** Raw scope value such as node id, route path, or file path. */
  scopeValue: string;
  /** Main entry node id when resolved. */
  entryNodeId?: string;
  /** Human-readable title for the view. */
  graphTitle: string;
  /** Summary text for prompts and side panels. */
  graphSummary: string;
  /** Dominant flow kind inferred from maps, traces, or node mix. */
  dominantFlowKind: string;
  /** Key focus paths or flow narratives for the view. */
  focusPaths: readonly string[];
  /** Ordered nodes for rendering. */
  nodes: readonly WorkflowViewGraphNode[];
  /** Ordered edges for rendering. */
  edges: readonly WorkflowViewGraphEdge[];
  /** Group metadata for rendering and export. */
  groups: readonly WorkflowViewGraphGroup[];
  /** Workflow maps tied to the selected focus. */
  maps: readonly WorkflowMapSummary[];
  /** Workflow traces tied to the selected focus. */
  traces: readonly WorkflowTraceSummary[];
}>;
