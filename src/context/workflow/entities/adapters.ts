/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Shared adapter-level workflow entities used across framework-specific extractors.
 */

/**
 * Shared route fact captured from a framework handler method before node synthesis.
 */
export type WorkflowMethodRouteFact = Readonly<{
  /** Method or handler name that owns the route mapping. */
  methodName: string;
  /** Normalized HTTP verb such as GET or POST. */
  httpMethod: string;
  /** Normalized route path bound to the handler method. */
  routePath: string;
  /** Referenced injected fields or properties called from this route handler. */
  calledDependencies: readonly string[];
}>;

/**
 * Shared intra-class call fact captured before graph edge synthesis.
 */
export type WorkflowMethodCallFact = Readonly<{
  /** Method name where the dependency call happens. */
  methodName: string;
  /** Referenced injected fields or properties called from the method body. */
  calledDependencies: readonly string[];
}>;

/**
 * Shared class-level workflow fact for annotation- or convention-driven backend frameworks.
 */
export type WorkflowBackendClassFact = Readonly<{
  /** Workspace-relative source file path for the class. */
  relativePath: string;
  /** Stable source hash used for invalidation. */
  sourceHash: string;
  /** Class name extracted from the source file. */
  className: string;
  /** Workflow node id representing the class itself. */
  classNodeId: string;
  /** Graph node type inferred for the class. */
  classNodeType: 'controller' | 'backend_service' | 'repository';
  /** Optional base route prefix declared at class level. */
  routeBase?: string;
  /** Mapping from injected property/field names to their declared class types. */
  injectedTypes: ReadonlyMap<string, string>;
  /** Route-bearing methods declared on the class. */
  methodRoutes: readonly WorkflowMethodRouteFact[];
  /** Non-route method calls captured from the class body. */
  methodCalls: readonly WorkflowMethodCallFact[];
}>;

/**
 * Shared metadata captured for a Vue single-file component before graph synthesis.
 */
export type WorkflowVueSfcFact = Readonly<{
  /** Workspace-relative Vue file path. */
  relativePath: string;
  /** Component name inferred from the SFC. */
  componentName: string;
  /** Stable source hash used for invalidation. */
  sourceHash: string;
  /** Imported default component bindings available in the SFC. */
  imports: ReadonlyMap<string, string>;
  /** Full source content used when scanning the template. */
  content: string;
}>;

/**
 * Shared options used when creating framework-derived workflow edges.
 */
export type WorkflowFrameworkEdgeOptions = Readonly<{
  /** Source node id for the edge. */
  fromNodeId: string;
  /** Target node id for the edge. */
  toNodeId: string;
  /** Edge kind emitted into the workflow graph. */
  edgeType: string;
  /** Human-readable edge label. */
  label: string;
  /** Supporting workspace-relative source file path. */
  relativePath: string;
  /** Stable source hash associated with the supporting file. */
  sourceHash: string;
  /** Framework-specific provenance kind recorded for debugging. */
  provenanceKind: string;
  /** Confidence score attached to the edge. */
  confidence: number;
}>;

/**
 * Shared options used when creating framework-derived API endpoint nodes.
 */
export type WorkflowEndpointNodeOptions = Readonly<{
  /** Stable node id for the endpoint. */
  id: string;
  /** Human-readable endpoint label, usually METHOD + path. */
  label: string;
  /** Workspace-relative file path supporting the endpoint. */
  relativePath: string;
  /** Stable source hash associated with the supporting file. */
  sourceHash: string;
  /** Handler or method symbol associated with the endpoint. */
  symbolName: string;
  /** Uppercase HTTP verb attached to the endpoint. */
  httpMethod: string;
  /** Normalized absolute route path. */
  routePath: string;
  /** Description text recorded on the node. */
  description: string;
  /** Description source identifier for retrieval diagnostics. */
  descriptionSource: string;
  /** Framework-specific provenance kind recorded for debugging. */
  provenanceKind: string;
  /** Confidence score attached to the endpoint node. */
  confidence: number;
}>;

/**
 * Shared function-level backend fact used by non-class-oriented adapters.
 */
export type WorkflowBackendFunctionFact = Readonly<{
  /** Workspace-relative source file path that owns the function. */
  relativePath: string;
  /** Stable source hash used for invalidation. */
  sourceHash: string;
  /** Parsed function name. */
  functionName: string;
  /** Workflow node id representing the function itself. */
  functionNodeId: string;
  /** Graph node type inferred for the function. */
  functionNodeType: 'controller' | 'backend_service' | 'repository' | 'worker' | 'entrypoint';
  /** Local function dependencies called from the function body. */
  calledDependencies: readonly string[];
}>;

/**
 * Shared widget-level fact used by Flutter and other UI framework adapters.
 */
export type WorkflowWidgetFact = Readonly<{
  /** Workspace-relative source file path that owns the widget. */
  relativePath: string;
  /** Stable source hash used for invalidation. */
  sourceHash: string;
  /** Parsed widget class name. */
  widgetName: string;
  /** Workflow node id representing the widget itself. */
  widgetNodeId: string;
  /** Graph node type inferred for the widget. */
  widgetNodeType: 'screen' | 'component';
  /** Referenced child widget names rendered by this widget. */
  renderedWidgets: readonly string[];
  /** Referenced named routes navigated to by this widget. */
  navigatedRoutes: readonly string[];
}>;
