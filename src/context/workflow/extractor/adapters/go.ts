/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Go workflow extractor adapter that identifies HTTP route handlers and local function call chains from backend source files.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import type { WorkflowBackendFunctionFact, WorkflowMethodRouteFact } from '../../entities/adapters';
import { createSourceHash, scanWorkspaceSourceFilesBySuffixes } from '../files';
import {
  createFrameworkEdge,
  createFrameworkEndpointNode,
  normalizeFrameworkRoutePath,
  sanitizeFrameworkIdentifier,
} from '../framework-helpers';

const GO_CALL_KEYWORDS = new Set([
  'if', 'for', 'switch', 'return', 'make', 'new', 'append', 'len', 'cap', 'panic', 'recover', 'close', 'go', 'defer',
]);

/**
 * Infers a workflow node type for a Go backend function.
 *
 * @param relativePath Workspace-relative Go file path.
 * @param functionName Parsed function name.
 * @returns Workflow node type for the function.
 */
function inferGoFunctionNodeType(relativePath: string, functionName: string): WorkflowBackendFunctionFact['functionNodeType'] {
  const lowerPath = relativePath.toLowerCase();
  const lowerName = functionName.toLowerCase();
  if (lowerPath.includes('repo') || lowerPath.includes('repository') || /repo|repository/.test(lowerName)) {
    return 'repository';
  }
  if (lowerPath.includes('service') || /service/.test(lowerName)) {
    return 'backend_service';
  }
  if (lowerPath.includes('worker') || /worker|job|task/.test(lowerName)) {
    return 'worker';
  }
  if (lowerPath.includes('handler') || lowerPath.includes('route') || /handler/.test(lowerName)) {
    return 'controller';
  }
  return 'entrypoint';
}

/**
 * Finds the next top-level Go declaration after a function starts.
 *
 * @param lines Source file lines.
 * @param startIndex Index of the function declaration line.
 * @returns Exclusive end line index for the function block.
 */
function findGoFunctionEnd(lines: readonly string[], startIndex: number): number {
  let depth = 0;
  let seenOpeningBrace = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        seenOpeningBrace = true;
      } else if (ch === '}') {
        depth -= 1;
        if (seenOpeningBrace && depth <= 0) {
          return index + 1;
        }
      }
    }
  }
  return lines.length;
}

/**
 * Extracts local function calls from a Go function body.
 *
 * @param body Full Go function body text.
 * @returns Sorted local function names referenced in the body.
 */
function extractGoCalledDependencies(body: string): readonly string[] {
  const calls = new Set<string>();
  const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of body.matchAll(callPattern)) {
    const calledName = match[1];
    if (!calledName || GO_CALL_KEYWORDS.has(calledName)) {
      continue;
    }
    calls.add(calledName);
  }
  return Object.freeze([...calls].sort((a, b) => a.localeCompare(b)));
}

/**
 * Parses top-level Go functions from a source file.
 *
 * @param relativePath Workspace-relative Go file path.
 * @param content Full Go source content.
 * @param sourceHash Stable source hash for invalidation.
 * @returns Frozen function facts extracted from the file.
 */
function parseGoFunctionFacts(
  relativePath: string,
  content: string,
  sourceHash: string,
): readonly WorkflowBackendFunctionFact[] {
  const lines = content.split(/\r?\n/);
  const functions: WorkflowBackendFunctionFact[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const functionMatch = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    const functionName = functionMatch?.[1];
    if (!functionName) {
      continue;
    }

    const endIndex = findGoFunctionEnd(lines, index);
    const body = lines.slice(index + 1, endIndex).join('\n');
    functions.push(Object.freeze({
      relativePath,
      sourceHash,
      functionName,
      functionNodeId: `workflow:go:${relativePath}:${sanitizeFrameworkIdentifier(functionName)}`,
      functionNodeType: inferGoFunctionNodeType(relativePath, functionName),
      calledDependencies: extractGoCalledDependencies(body).filter((dependency) => dependency !== functionName),
    }));
    index = endIndex - 1;
  }

  return Object.freeze(functions);
}

/**
 * Extracts HTTP route registrations from a Go source file.
 *
 * @param content Full Go source content.
 * @returns Frozen route facts extracted from the file.
 */
function extractGoRouteFacts(content: string): readonly WorkflowMethodRouteFact[] {
  const routePattern =
    /\b(?:http|router|mux)\.HandleFunc\(\s*"([^"]+)"\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)|\b(?:router|mux)\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
  const routes: WorkflowMethodRouteFact[] = [];

  for (const match of content.matchAll(routePattern)) {
    const handleFuncPath = match[1];
    const handleFuncHandler = match[2];
    const routerMethod = match[3];
    const routerPath = match[4];
    const routerHandler = match[5];

    if (handleFuncPath && handleFuncHandler) {
      routes.push(Object.freeze({
        methodName: handleFuncHandler,
        httpMethod: 'GET',
        routePath: normalizeFrameworkRoutePath(handleFuncPath),
        calledDependencies: Object.freeze([]),
      }));
      continue;
    }

    if (routerMethod && routerPath && routerHandler) {
      routes.push(Object.freeze({
        methodName: routerHandler,
        httpMethod: routerMethod.toUpperCase(),
        routePath: normalizeFrameworkRoutePath(routerPath),
        calledDependencies: Object.freeze([]),
      }));
    }
  }

  return Object.freeze(routes);
}

/**
 * Creates a workflow node for a Go backend function.
 *
 * @param fact Parsed Go backend function fact.
 * @returns Frozen workflow node record.
 */
function createGoFunctionNode(fact: WorkflowBackendFunctionFact): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: fact.functionNodeId,
    nodeType: fact.functionNodeType,
    label: fact.functionName,
    filePath: fact.relativePath,
    symbolName: fact.functionName,
    description: `${fact.functionNodeType.replace(/_/g, ' ')} ${fact.functionName}`,
    descriptionSource: 'go_backend',
    confidence: 0.82,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'go_backend_function',
    }),
    sourceHash: fact.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates an API endpoint node from a Go route declaration.
 *
 * @param relativePath Workspace-relative Go file path.
 * @param sourceHash Stable source hash for the file.
 * @param route Route-bearing method fact.
 * @returns Frozen workflow node record for the endpoint.
 */
function createGoEndpointNode(relativePath: string, sourceHash: string, route: WorkflowMethodRouteFact): WorkflowNodeRecord {
  return createFrameworkEndpointNode({
    id: `workflow:go-route:${route.httpMethod}:${route.routePath}`,
    label: `${route.httpMethod} ${route.routePath}`,
    relativePath,
    sourceHash,
    symbolName: route.methodName,
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    description: `Go endpoint ${route.httpMethod} ${route.routePath}`,
    descriptionSource: 'go_backend',
    provenanceKind: 'go_route_registration',
    confidence: 0.88,
  });
}

/**
 * Extracts Go backend workflow nodes and route/function edges from `.go` files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from Go source files.
 */
async function extractGoWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const goFiles = scanWorkspaceSourceFilesBySuffixes(workspacePath, ['.go']);
  if (goFiles.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();
  const functionFacts: WorkflowBackendFunctionFact[] = [];
  const routesByFile = new Map<string, readonly WorkflowMethodRouteFact[]>();

  goFiles.forEach((relativePath) => {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    const sourceHash = createSourceHash(relativePath, content);
    functionFacts.push(...parseGoFunctionFacts(relativePath, content, sourceHash));
    routesByFile.set(relativePath, extractGoRouteFacts(content));
  });

  const functionNodeIdByName = new Map<string, string>();
  functionFacts.forEach((fact) => {
    nodes.set(fact.functionNodeId, createGoFunctionNode(fact));
    functionNodeIdByName.set(fact.functionName, fact.functionNodeId);
  });

  functionFacts.forEach((fact) => {
    fact.calledDependencies.forEach((dependency) => {
      const targetNodeId = functionNodeIdByName.get(dependency);
      if (!targetNodeId || targetNodeId === fact.functionNodeId) {
        return;
      }
      edges.set(
        `calls:${fact.functionNodeId}:${targetNodeId}:${dependency}`,
        createFrameworkEdge({
          fromNodeId: fact.functionNodeId,
          toNodeId: targetNodeId,
          edgeType: 'calls',
          label: `${fact.functionName}:${dependency}`,
          relativePath: fact.relativePath,
          sourceHash: fact.sourceHash,
          provenanceKind: 'go_local_function_call',
          confidence: 0.74,
        }),
      );
    });
  });

  routesByFile.forEach((routes, relativePath) => {
    const sourceHash = functionFacts.find((fact) => fact.relativePath === relativePath)?.sourceHash;
    if (!sourceHash) {
      return;
    }
    routes.forEach((route) => {
      const handlerNodeId = functionNodeIdByName.get(route.methodName);
      if (!handlerNodeId) {
        return;
      }
      const endpointNode = createGoEndpointNode(relativePath, sourceHash, route);
      nodes.set(endpointNode.id, endpointNode);
      edges.set(
        `routes:${endpointNode.id}:${handlerNodeId}`,
        createFrameworkEdge({
          fromNodeId: endpointNode.id,
          toNodeId: handlerNodeId,
          edgeType: 'routes_to',
          label: route.methodName,
          relativePath,
          sourceHash,
          provenanceKind: 'go_handler_binding',
          confidence: 0.86,
        }),
      );
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for Go HTTP route and local function extraction.
 */
export const goWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'go',
  label: 'Go',
  extract: extractGoWorkflowGraph,
});
