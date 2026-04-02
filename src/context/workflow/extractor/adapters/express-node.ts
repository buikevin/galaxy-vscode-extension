/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Express and plain Node router adapter that extracts route registrations and binds them to local or imported handlers.
 */

import type { ParsedFile, WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import type { WorkflowMethodRouteFact } from '../../entities/adapters';
import { buildTypeScriptWorkflowExtractionContext } from '../generic-facts';
import { createFrameworkEdge, createFrameworkEndpointNode, normalizeFrameworkRoutePath } from '../framework-helpers';

/**
 * Extracts Express-style route registrations from a parsed TypeScript or JavaScript file.
 *
 * @param parsedFile Parsed TypeScript workflow file.
 * @returns Frozen route registration facts discovered in the file.
 */
function extractExpressRouteFacts(parsedFile: ParsedFile): readonly WorkflowMethodRouteFact[] {
  const sourceText = parsedFile.sourceFile.getFullText();
  const routePattern =
    /\b(?:app|router)\.(get|post|put|patch|delete|options|head)\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const routes: WorkflowMethodRouteFact[] = [];

  for (const match of sourceText.matchAll(routePattern)) {
    const httpMethod = match[1];
    const routePath = match[2];
    const handlerName = match[3];
    if (!httpMethod || !routePath || !handlerName) {
      continue;
    }
    routes.push(Object.freeze({
      methodName: handlerName,
      httpMethod: httpMethod.toUpperCase(),
        routePath: normalizeFrameworkRoutePath(routePath),
      calledDependencies: Object.freeze([]),
    }));
  }

  return Object.freeze(routes);
}

/**
 * Resolves a route handler reference to a workflow node id in the local file or imported targets.
 *
 * @param parsedFile Parsed workflow file containing the route registration.
 * @param handlerName Local handler identifier extracted from the route registration.
 * @param exportedSymbolsByFile Exported symbol lookup keyed by workspace-relative file path.
 * @returns Target workflow node id when the handler can be resolved.
 */
function resolveExpressHandlerNodeId(
  parsedFile: ParsedFile,
  handlerName: string,
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | null {
  const localNodeId = parsedFile.localSymbolIds.get(handlerName);
  if (localNodeId) {
    return localNodeId;
  }

  const importBinding = parsedFile.importBindings.get(handlerName);
  if (!importBinding) {
    return null;
  }

  const exportedSymbols = exportedSymbolsByFile.get(importBinding.targetFile);
  if (!exportedSymbols) {
    return null;
  }

  if (importBinding.importedName !== 'default') {
    return exportedSymbols.get(importBinding.importedName) ?? null;
  }

  return exportedSymbols.values().next().value ?? null;
}

/**
 * Creates an API endpoint node from an Express route registration.
 *
 * @param parsedFile Parsed workflow file that owns the route registration.
 * @param route Route registration fact.
 * @returns Frozen workflow node record for the endpoint.
 */
function createExpressEndpointNode(parsedFile: ParsedFile, route: WorkflowMethodRouteFact): WorkflowNodeRecord {
  return createFrameworkEndpointNode({
    id: `workflow:express-route:${route.httpMethod}:${route.routePath}`,
    label: `${route.httpMethod} ${route.routePath}`,
    relativePath: parsedFile.relativePath,
    sourceHash: parsedFile.sourceHash,
    symbolName: route.methodName,
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    description: `Express endpoint ${route.httpMethod} ${route.routePath}`,
    descriptionSource: 'express_node',
    provenanceKind: 'express_route_registration',
    confidence: 0.88,
  });
}

/**
 * Extracts Express and plain Node router workflow nodes and route-binding edges.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from Express-style route files.
 */
async function extractExpressNodeWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const context = buildTypeScriptWorkflowExtractionContext(workspacePath);
  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();

  context.parsedFiles.forEach((parsedFile) => {
    extractExpressRouteFacts(parsedFile).forEach((route) => {
      const handlerNodeId = resolveExpressHandlerNodeId(parsedFile, route.methodName, context.exportedSymbolsByFile);
      if (!handlerNodeId) {
        return;
      }

      const endpointNode = createExpressEndpointNode(parsedFile, route);
      nodes.set(endpointNode.id, endpointNode);

      const routeEdge = createFrameworkEdge({
        fromNodeId: endpointNode.id,
        toNodeId: handlerNodeId,
        edgeType: 'routes_to',
        label: route.methodName,
        relativePath: parsedFile.relativePath,
        sourceHash: parsedFile.sourceHash,
        provenanceKind: 'express_handler_binding',
        confidence: 0.86,
      });
      edges.set(routeEdge.id, routeEdge);
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for Express and plain Node router extraction.
 */
export const expressNodeWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'express-node',
  label: 'Express / Node Router',
  extract: extractExpressNodeWorkflowGraph,
});
