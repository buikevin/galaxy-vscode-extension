/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Rust web workflow extractor adapter that identifies route handlers and local backend call chains across axum, actix-web, and warp-style source files.
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

const RUST_CALL_KEYWORDS = new Set([
  'if',
  'else',
  'match',
  'loop',
  'while',
  'for',
  'return',
  'Some',
  'None',
  'Ok',
  'Err',
  'Self',
  'new',
  'await',
]);

/**
 * Infers a workflow node type for a Rust backend function.
 *
 * @param relativePath Workspace-relative Rust file path.
 * @param functionName Parsed function name.
 * @returns Workflow node type for the function.
 */
function inferRustFunctionNodeType(
  relativePath: string,
  functionName: string,
): WorkflowBackendFunctionFact['functionNodeType'] {
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
 * Finds the closing brace index matching a given opening brace index.
 *
 * @param content Full Rust source content.
 * @param openIndex Index of the opening brace.
 * @returns Matching closing brace index, or `-1` when not found.
 */
function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const ch = content[index];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Extracts local Rust function calls from a function body.
 *
 * @param body Full Rust function body text.
 * @returns Sorted local function names referenced in the body.
 */
function extractRustCalledDependencies(body: string): readonly string[] {
  const calls = new Set<string>();
  const callPattern = /\b([a-zA-Z_][A-Za-z0-9_]*)\s*(?:!\s*)?\(/g;
  for (const match of body.matchAll(callPattern)) {
    const calledName = match[1];
    if (!calledName || RUST_CALL_KEYWORDS.has(calledName)) {
      continue;
    }
    calls.add(calledName);
  }
  return Object.freeze([...calls].sort((a, b) => a.localeCompare(b)));
}

/**
 * Parses top-level Rust functions from a source file.
 *
 * @param relativePath Workspace-relative Rust file path.
 * @param content Full Rust source content.
 * @param sourceHash Stable source hash for invalidation.
 * @returns Frozen function facts extracted from the file.
 */
function parseRustFunctionFacts(
  relativePath: string,
  content: string,
  sourceHash: string,
): readonly WorkflowBackendFunctionFact[] {
  const functions: WorkflowBackendFunctionFact[] = [];
  const functionPattern =
    /(?:#\[[^\]]+\]\s*)*(?:pub\s+)?async\s+fn\s+([a-zA-Z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:->\s*[^{]+)?\s*\{|(?:#\[[^\]]+\]\s*)*(?:pub\s+)?fn\s+([a-zA-Z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:->\s*[^{]+)?\s*\{/g;

  for (const match of content.matchAll(functionPattern)) {
    const functionName = match[1] ?? match[2];
    const signatureIndex = match.index ?? -1;
    const openBraceIndex = content.indexOf('{', signatureIndex);
    const closeBraceIndex = openBraceIndex >= 0 ? findMatchingBrace(content, openBraceIndex) : -1;
    const body = openBraceIndex >= 0 && closeBraceIndex > openBraceIndex ? content.slice(openBraceIndex + 1, closeBraceIndex) : '';
    if (!functionName) {
      continue;
    }
    functions.push(Object.freeze({
      relativePath,
      sourceHash,
      functionName,
      functionNodeId: `workflow:rust:${relativePath}:${sanitizeFrameworkIdentifier(functionName)}`,
      functionNodeType: inferRustFunctionNodeType(relativePath, functionName),
      calledDependencies: extractRustCalledDependencies(body).filter((dependency) => dependency !== functionName),
    }));
  }

  return Object.freeze(functions);
}

/**
 * Extracts route facts from Rust web source using common axum, actix-web, warp, and attribute patterns.
 *
 * @param content Full Rust source content.
 * @returns Frozen route facts extracted from the file.
 */
function extractRustRouteFacts(content: string): readonly WorkflowMethodRouteFact[] {
  const routes: WorkflowMethodRouteFact[] = [];
  const attributePattern = /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][A-Za-z0-9_]*)/g;
  const axumPattern = /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\(\s*([a-zA-Z_][A-Za-z0-9_]*)\s*\)\s*\)/g;
  const actixPattern = /\.route\(\s*"([^"]+)"\s*,\s*web::(get|post|put|patch|delete)\(\)\.to\(\s*([a-zA-Z_][A-Za-z0-9_]*)\s*\)\s*\)/g;
  const warpPattern = /warp::path!\([^)]*\)\s*\.and\(warp::(get|post|put|patch|delete)\(\)\)\s*\.and_then\(\s*([a-zA-Z_][A-Za-z0-9_]*)\s*\)/g;

  for (const match of content.matchAll(attributePattern)) {
    const httpMethod = match[1];
    const routePath = match[2];
    const methodName = match[3];
    if (!httpMethod || !routePath || !methodName) {
      continue;
    }
    routes.push(Object.freeze({
      methodName,
      httpMethod: httpMethod.toUpperCase(),
      routePath: normalizeFrameworkRoutePath(routePath),
      calledDependencies: Object.freeze([]),
    }));
  }

  for (const match of content.matchAll(axumPattern)) {
    const routePath = match[1];
    const httpMethod = match[2];
    const methodName = match[3];
    if (!httpMethod || !routePath || !methodName) {
      continue;
    }
    routes.push(Object.freeze({
      methodName,
      httpMethod: httpMethod.toUpperCase(),
      routePath: normalizeFrameworkRoutePath(routePath),
      calledDependencies: Object.freeze([]),
    }));
  }

  for (const match of content.matchAll(actixPattern)) {
    const routePath = match[1];
    const httpMethod = match[2];
    const methodName = match[3];
    if (!httpMethod || !routePath || !methodName) {
      continue;
    }
    routes.push(Object.freeze({
      methodName,
      httpMethod: httpMethod.toUpperCase(),
      routePath: normalizeFrameworkRoutePath(routePath),
      calledDependencies: Object.freeze([]),
    }));
  }

  for (const match of content.matchAll(warpPattern)) {
    const httpMethod = match[1];
    const methodName = match[2];
    if (!httpMethod || !methodName) {
      continue;
    }
    routes.push(Object.freeze({
      methodName,
      httpMethod: httpMethod.toUpperCase(),
      routePath: '/warp',
      calledDependencies: Object.freeze([]),
    }));
  }

  return Object.freeze(routes);
}

/**
 * Creates a workflow node for a Rust backend function.
 *
 * @param fact Parsed Rust backend function fact.
 * @returns Frozen workflow node record.
 */
function createRustFunctionNode(fact: WorkflowBackendFunctionFact): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: fact.functionNodeId,
    nodeType: fact.functionNodeType,
    label: fact.functionName,
    filePath: fact.relativePath,
    symbolName: fact.functionName,
    description: `${fact.functionNodeType.replace(/_/g, ' ')} ${fact.functionName}`,
    descriptionSource: 'rust_web',
    confidence: 0.82,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'rust_backend_function',
    }),
    sourceHash: fact.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates an API endpoint node from a Rust route declaration.
 *
 * @param relativePath Workspace-relative Rust file path.
 * @param sourceHash Stable source hash for the file.
 * @param route Route-bearing method fact.
 * @returns Frozen workflow node record for the endpoint.
 */
function createRustEndpointNode(relativePath: string, sourceHash: string, route: WorkflowMethodRouteFact): WorkflowNodeRecord {
  return createFrameworkEndpointNode({
    id: `workflow:rust-route:${route.httpMethod}:${route.routePath}`,
    label: `${route.httpMethod} ${route.routePath}`,
    relativePath,
    sourceHash,
    symbolName: route.methodName,
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    description: `Rust endpoint ${route.httpMethod} ${route.routePath}`,
    descriptionSource: 'rust_web',
    provenanceKind: 'rust_route_registration',
    confidence: 0.88,
  });
}

/**
 * Extracts Rust backend route and local call graphs from `.rs` files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from Rust web source files.
 */
async function extractRustWebWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const rustFiles = scanWorkspaceSourceFilesBySuffixes(workspacePath, ['.rs']);
  if (rustFiles.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();
  const functions: WorkflowBackendFunctionFact[] = [];
  const routesByFile = new Map<string, { sourceHash: string; routes: readonly WorkflowMethodRouteFact[] }>();

  rustFiles.forEach((relativePath) => {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    const sourceHash = createSourceHash(relativePath, content);
    functions.push(...parseRustFunctionFacts(relativePath, content, sourceHash));
    const routes = extractRustRouteFacts(content);
    if (routes.length > 0) {
      routesByFile.set(relativePath, Object.freeze({
        sourceHash,
        routes,
      }));
    }
  });

  const functionNodeIdByName = new Map<string, string>();
  functions.forEach((fact) => {
    nodes.set(fact.functionNodeId, createRustFunctionNode(fact));
    functionNodeIdByName.set(fact.functionName, fact.functionNodeId);
  });

  functions.forEach((fact) => {
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
          label: dependency,
          relativePath: fact.relativePath,
          sourceHash: fact.sourceHash,
          provenanceKind: 'rust_function_call',
          confidence: 0.73,
        }),
      );
    });
  });

  routesByFile.forEach(({ sourceHash, routes }, relativePath) => {
    routes.forEach((route) => {
      const handlerNodeId = functionNodeIdByName.get(route.methodName);
      if (!handlerNodeId) {
        return;
      }
      const endpointNode = createRustEndpointNode(relativePath, sourceHash, route);
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
          provenanceKind: 'rust_route_binding',
          confidence: 0.9,
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
 * Framework adapter for Rust web route, handler, and service extraction.
 */
export const rustWebWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'rust-web',
  label: 'Rust Web',
  extract: extractRustWebWorkflowGraph,
});
