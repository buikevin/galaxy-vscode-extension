/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Python FastAPI adapter that extracts route handlers and local function call chains from `.py` files.
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
  joinFrameworkRoutePath,
  normalizeFrameworkRoutePath,
  sanitizeFrameworkIdentifier,
} from '../framework-helpers';

const PYTHON_CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'return', 'await', 'with', 'print', 'len', 'range', 'dict', 'list', 'set', 'tuple', 'str', 'int', 'float', 'bool',
]);

/**
 * Normalizes arbitrary text into a safe workflow identifier segment.
 *
 * @param value Raw text that may contain unsupported id characters.
 * @returns Identifier-safe string for workflow ids.
 */
/**
 * Infers a workflow node type for a Python backend function.
 *
 * @param relativePath Workspace-relative Python file path.
 * @param functionName Parsed function name.
 * @returns Workflow node type for the function.
 */
function inferPythonFunctionNodeType(relativePath: string, functionName: string): WorkflowBackendFunctionFact['functionNodeType'] {
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
  return 'entrypoint';
}

/**
 * Extracts `APIRouter(prefix=...)` declarations keyed by local router variable name.
 *
 * @param content Full Python source content.
 * @returns Mapping from router variable names to normalized route prefixes.
 */
function extractFastApiRouterPrefixes(content: string): ReadonlyMap<string, string> {
  const prefixes = new Map<string, string>();
  const routerPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*APIRouter\s*\(([\s\S]*?)\)/g;
  for (const match of content.matchAll(routerPattern)) {
    const routerName = match[1];
    const routerArgs = match[2] ?? '';
    if (!routerName) {
      continue;
    }
    const prefixMatch = routerArgs.match(/\bprefix\s*=\s*["']([^"']+)["']/);
    prefixes.set(routerName, normalizeFrameworkRoutePath(prefixMatch?.[1] ?? '/'));
  }
  return prefixes;
}

/**
 * Finds the next top-level definition or decorator boundary after a function body starts.
 *
 * @param lines Source file lines.
 * @param startIndex Index of the function definition line.
 * @returns Exclusive end line index for the function block.
 */
function findPythonFunctionEnd(lines: readonly string[], startIndex: number): number {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      continue;
    }
    if (!/^\s/.test(line) || /^@/.test(line)) {
      return index;
    }
  }
  return lines.length;
}

/**
 * Extracts local function calls from a Python function body.
 *
 * @param body Full function body text.
 * @returns Sorted local function names referenced in the body.
 */
function extractPythonCalledDependencies(body: string): readonly string[] {
  const calls = new Set<string>();
  const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of body.matchAll(callPattern)) {
    const calledName = match[1];
    if (!calledName || PYTHON_CALL_KEYWORDS.has(calledName)) {
      continue;
    }
    calls.add(calledName);
  }
  return Object.freeze([...calls].sort((a, b) => a.localeCompare(b)));
}

/**
 * Creates a workflow node for a Python backend function.
 *
 * @param fact Parsed Python backend function fact.
 * @returns Frozen workflow node record.
 */
function createPythonFunctionNode(fact: WorkflowBackendFunctionFact): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: fact.functionNodeId,
    nodeType: fact.functionNodeType,
    label: fact.functionName,
    filePath: fact.relativePath,
    symbolName: fact.functionName,
    description: `${fact.functionNodeType.replace(/_/g, ' ')} ${fact.functionName}`,
    descriptionSource: 'python_fastapi',
    confidence: 0.82,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'python_backend_function',
    }),
    sourceHash: fact.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates an API endpoint node from a FastAPI route declaration.
 *
 * @param relativePath Workspace-relative Python file path.
 * @param sourceHash Stable source hash for the file.
 * @param route Route-bearing method fact.
 * @returns Frozen workflow node record for the endpoint.
 */
function createFastApiEndpointNode(relativePath: string, sourceHash: string, route: WorkflowMethodRouteFact): WorkflowNodeRecord {
  return createFrameworkEndpointNode({
    id: `workflow:fastapi-route:${route.httpMethod}:${route.routePath}`,
    label: `${route.httpMethod} ${route.routePath}`,
    relativePath,
    sourceHash,
    symbolName: route.methodName,
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    description: `FastAPI endpoint ${route.httpMethod} ${route.routePath}`,
    descriptionSource: 'python_fastapi',
    provenanceKind: 'fastapi_route_mapping',
    confidence: 0.9,
  });
}

/**
 * Parses Python backend functions and FastAPI route handlers from a file.
 *
 * @param relativePath Workspace-relative Python file path.
 * @param content Full Python source content.
 * @param sourceHash Stable source hash for invalidation.
 * @returns Parsed function and route facts extracted from the file.
 */
function parsePythonFastApiFacts(relativePath: string, content: string, sourceHash: string): Readonly<{
  functions: readonly WorkflowBackendFunctionFact[];
  routes: readonly WorkflowMethodRouteFact[];
}> {
  const lines = content.split(/\r?\n/);
  const routerPrefixes = extractFastApiRouterPrefixes(content);
  const functions: WorkflowBackendFunctionFact[] = [];
  const routes: WorkflowMethodRouteFact[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const functionMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!functionMatch?.[1]) {
      continue;
    }

    const functionName = functionMatch[1];
    const endIndex = findPythonFunctionEnd(lines, index);
    const body = lines.slice(index + 1, endIndex).join('\n');
    const calledDependencies = extractPythonCalledDependencies(body).filter((dependency) => dependency !== functionName);
    const precedingDecorators: string[] = [];

    for (let decoratorIndex = index - 1; decoratorIndex >= 0; decoratorIndex -= 1) {
      const decoratorLine = lines[decoratorIndex] ?? '';
      if (!decoratorLine.trim()) {
        continue;
      }
      if (/^\s*@/.test(decoratorLine)) {
        precedingDecorators.unshift(decoratorLine.trim());
        continue;
      }
      break;
    }

    functions.push(Object.freeze({
      relativePath,
      sourceHash,
      functionName,
      functionNodeId: `workflow:python:${relativePath}:${sanitizeFrameworkIdentifier(functionName)}`,
      functionNodeType: precedingDecorators.length > 0 ? 'controller' : inferPythonFunctionNodeType(relativePath, functionName),
      calledDependencies,
    }));

    precedingDecorators.forEach((decoratorLine) => {
      const routeMatch = decoratorLine.match(/^@([A-Za-z_][A-Za-z0-9_]*)\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/i);
      if (!routeMatch) {
        return;
      }
      const routerName = routeMatch[1];
      const httpMethod = routeMatch[2];
      const routePath = routeMatch[3];
      if (!routerName || !httpMethod || !routePath) {
        return;
      }
      routes.push(Object.freeze({
        methodName: functionName,
        httpMethod: httpMethod.toUpperCase(),
        routePath: joinFrameworkRoutePath(routerPrefixes.get(routerName), routePath),
        calledDependencies,
      }));
    });

    index = endIndex - 1;
  }

  return Object.freeze({
    functions: Object.freeze(functions),
    routes: Object.freeze(routes),
  });
}

/**
 * Extracts FastAPI routes and local Python backend call chains from `.py` files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from Python FastAPI files.
 */
async function extractPythonFastApiWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const pythonFiles = scanWorkspaceSourceFilesBySuffixes(workspacePath, ['.py']);
  if (pythonFiles.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();
  const functionFacts: WorkflowBackendFunctionFact[] = [];
  const routesByFile = new Map<string, readonly WorkflowMethodRouteFact[]>();

  pythonFiles.forEach((relativePath) => {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    const sourceHash = createSourceHash(relativePath, content);
    const parsed = parsePythonFastApiFacts(relativePath, content, sourceHash);
    functionFacts.push(...parsed.functions);
    routesByFile.set(relativePath, parsed.routes);
  });

  const functionNodeIdByName = new Map<string, string>();
  functionFacts.forEach((fact) => {
    nodes.set(fact.functionNodeId, createPythonFunctionNode(fact));
    functionNodeIdByName.set(fact.functionName, fact.functionNodeId);
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
      const endpointNode = createFastApiEndpointNode(relativePath, sourceHash, route);
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
          provenanceKind: 'fastapi_handler_binding',
          confidence: 0.9,
        }),
      );
      route.calledDependencies.forEach((dependency) => {
        const targetNodeId = functionNodeIdByName.get(dependency);
        if (!targetNodeId || targetNodeId === handlerNodeId) {
          return;
        }
        edges.set(
          `calls:${handlerNodeId}:${targetNodeId}:${dependency}`,
          createFrameworkEdge({
            fromNodeId: handlerNodeId,
            toNodeId: targetNodeId,
            edgeType: 'calls',
            label: `${route.methodName}:${dependency}`,
            relativePath,
            sourceHash,
            provenanceKind: 'python_local_function_call',
            confidence: 0.74,
          }),
        );
      });
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for Python FastAPI route and local call extraction.
 */
export const pythonFastApiWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'python-fastapi',
  label: 'Python / FastAPI',
  extract: extractPythonFastApiWorkflowGraph,
});
