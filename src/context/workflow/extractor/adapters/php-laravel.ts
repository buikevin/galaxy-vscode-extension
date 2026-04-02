/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Laravel workflow extractor adapter that links Route definitions to controller methods and local service or repository calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import type {
  WorkflowBackendClassFact,
  WorkflowMethodCallFact,
  WorkflowMethodRouteFact,
} from '../../entities/adapters';
import { createSourceHash, scanWorkspaceSourceFilesBySuffixes } from '../files';
import {
  createFrameworkEdge,
  createFrameworkEndpointNode,
  normalizeFrameworkRoutePath,
  sanitizeFrameworkIdentifier,
} from '../framework-helpers';

type PhpLaravelClassFact = WorkflowBackendClassFact;

/**
 * Infers the workflow node type for a Laravel PHP class using naming and directory heuristics.
 *
 * @param relativePath Workspace-relative PHP file path.
 * @param className Parsed PHP class name.
 * @returns Workflow node type for the class.
 */
function inferPhpClassNodeType(relativePath: string, className: string): PhpLaravelClassFact['classNodeType'] {
  const lowerPath = relativePath.toLowerCase();
  if (lowerPath.includes('controller') || /Controller$/.test(className)) {
    return 'controller';
  }
  if (lowerPath.includes('repository') || /Repository$/.test(className)) {
    return 'repository';
  }
  return 'backend_service';
}

/**
 * Extracts typed Laravel properties and promoted constructor dependencies.
 *
 * @param content Full PHP source content.
 * @returns Mapping from instance property names to declared class names.
 */
function extractPhpInjectedTypes(content: string): ReadonlyMap<string, string> {
  const injectedTypes = new Map<string, string>();
  const propertyPattern = /(?:private|protected|public)\s+(?:readonly\s+)?\\?([A-Z][A-Za-z0-9_\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of content.matchAll(propertyPattern)) {
    const typeName = match[1]?.split('\\').pop();
    const propertyName = match[2];
    if (typeName && propertyName) {
      injectedTypes.set(propertyName, typeName);
    }
  }
  return injectedTypes;
}

/**
 * Finds the closing brace index matching a given opening brace index.
 *
 * @param content Full PHP source content.
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
 * Extracts `$this->dependency->method()` calls from a PHP method body.
 *
 * @param body PHP method body text.
 * @param injectedTypes Known property-to-class mappings.
 * @returns Sorted dependency property names referenced by the method.
 */
function extractPhpCalledDependencies(body: string, injectedTypes: ReadonlyMap<string, string>): readonly string[] {
  const calls = new Set<string>();
  injectedTypes.forEach((_typeName, propertyName) => {
    const pattern = new RegExp(`\\$this->${propertyName}->[A-Za-z_][A-Za-z0-9_]*\\s*\\(`, 'g');
    if (pattern.test(body)) {
      calls.add(propertyName);
    }
  });
  return Object.freeze([...calls.values()].sort((a, b) => a.localeCompare(b)));
}

/**
 * Parses a Laravel PHP class file into a reusable backend class fact.
 *
 * @param relativePath Workspace-relative PHP file path.
 * @param content Full PHP source content.
 * @param sourceHash Stable source hash for invalidation.
 * @returns Parsed Laravel class fact, or `null` when no class is found.
 */
function parsePhpLaravelClassFact(relativePath: string, content: string, sourceHash: string): PhpLaravelClassFact | null {
  const classMatch = content.match(/class\s+([A-Z][A-Za-z0-9_]*)/);
  const className = classMatch?.[1];
  if (!className) {
    return null;
  }

  const injectedTypes = extractPhpInjectedTypes(content);
  const classNodeId = `workflow:php:${relativePath}:${sanitizeFrameworkIdentifier(className)}`;
  const methodCalls: WorkflowMethodCallFact[] = [];
  const methodPattern = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/g;

  for (const match of content.matchAll(methodPattern)) {
    const methodName = match[1];
    const signatureIndex = match.index ?? -1;
    const openBraceIndex = content.indexOf('{', signatureIndex);
    const closeBraceIndex = openBraceIndex >= 0 ? findMatchingBrace(content, openBraceIndex) : -1;
    const methodBody = openBraceIndex >= 0 && closeBraceIndex > openBraceIndex ? content.slice(openBraceIndex + 1, closeBraceIndex) : '';
    if (!methodName) {
      continue;
    }
    methodCalls.push(Object.freeze({
      methodName,
      calledDependencies: extractPhpCalledDependencies(methodBody, injectedTypes),
    }));
  }

  return Object.freeze({
    relativePath,
    sourceHash,
    className,
    classNodeId,
    classNodeType: inferPhpClassNodeType(relativePath, className),
    injectedTypes,
    methodRoutes: Object.freeze([]),
    methodCalls: Object.freeze(methodCalls),
  });
}

/**
 * Extracts Laravel route declarations from a PHP route file.
 *
 * @param content Full PHP route file content.
 * @returns Frozen route facts paired with target controller names.
 */
function extractLaravelRouteFacts(
  content: string,
): ReadonlyArray<WorkflowMethodRouteFact & Readonly<{ controllerClass: string }>> {
  const routes: Array<WorkflowMethodRouteFact & Readonly<{ controllerClass: string }>> = [];
  const arraySyntaxPattern =
    /Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]+)['"]\s*,\s*\[\s*([A-Z][A-Za-z0-9_\\]*)::class\s*,\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]\s*\)/g;
  const stringSyntaxPattern =
    /Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]+)['"]\s*,\s*['"]([A-Z][A-Za-z0-9_\\]*)@([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g;

  for (const match of content.matchAll(arraySyntaxPattern)) {
    const httpMethod = match[1];
    const routePath = match[2];
    const controllerClass = match[3]?.split('\\').pop();
    const methodName = match[4];
    if (!httpMethod || !routePath || !controllerClass || !methodName) {
      continue;
    }
    routes.push(Object.freeze({
      controllerClass,
      methodName,
      httpMethod: httpMethod.toUpperCase(),
      routePath: normalizeFrameworkRoutePath(routePath),
      calledDependencies: Object.freeze([]),
    }));
  }

  for (const match of content.matchAll(stringSyntaxPattern)) {
    const httpMethod = match[1];
    const routePath = match[2];
    const controllerClass = match[3]?.split('\\').pop();
    const methodName = match[4];
    if (!httpMethod || !routePath || !controllerClass || !methodName) {
      continue;
    }
    routes.push(Object.freeze({
      controllerClass,
      methodName,
      httpMethod: httpMethod.toUpperCase(),
      routePath: normalizeFrameworkRoutePath(routePath),
      calledDependencies: Object.freeze([]),
    }));
  }

  return Object.freeze(routes);
}

/**
 * Creates a workflow node for a Laravel class.
 *
 * @param fact Parsed Laravel class fact.
 * @returns Frozen workflow node record.
 */
function createPhpClassNode(fact: PhpLaravelClassFact): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: fact.classNodeId,
    nodeType: fact.classNodeType,
    label: fact.className,
    filePath: fact.relativePath,
    symbolName: fact.className,
    description: `${fact.classNodeType.replace(/_/g, ' ')} ${fact.className}`,
    descriptionSource: 'php_laravel',
    confidence: 0.84,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'laravel_php_class',
    }),
    sourceHash: fact.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates an API endpoint node from a Laravel route declaration.
 *
 * @param relativePath Workspace-relative route file path.
 * @param sourceHash Stable source hash for the route file.
 * @param route Route fact extracted from the file.
 * @returns Frozen workflow node record for the endpoint.
 */
function createLaravelEndpointNode(
  relativePath: string,
  sourceHash: string,
  route: WorkflowMethodRouteFact,
): WorkflowNodeRecord {
  return createFrameworkEndpointNode({
    id: `workflow:php-route:${route.httpMethod}:${route.routePath}`,
    label: `${route.httpMethod} ${route.routePath}`,
    relativePath,
    sourceHash,
    symbolName: route.methodName,
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    description: `Laravel endpoint ${route.httpMethod} ${route.routePath}`,
    descriptionSource: 'php_laravel',
    provenanceKind: 'laravel_route',
    confidence: 0.9,
  });
}

/**
 * Extracts Laravel route-to-controller and controller-to-service graphs from `.php` files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from Laravel source files.
 */
async function extractPhpLaravelWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const phpFiles = scanWorkspaceSourceFilesBySuffixes(workspacePath, ['.php']);
  if (phpFiles.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();
  const classFacts: PhpLaravelClassFact[] = [];
  const routeFiles = new Map<
    string,
    {
      sourceHash: string;
      routes: ReadonlyArray<WorkflowMethodRouteFact & Readonly<{ controllerClass: string }>>;
    }
  >();

  phpFiles.forEach((relativePath) => {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    const sourceHash = createSourceHash(relativePath, content);
    const classFact = parsePhpLaravelClassFact(relativePath, content, sourceHash);
    if (classFact) {
      classFacts.push(classFact);
    }
    if (relativePath.startsWith('routes/')) {
      routeFiles.set(relativePath, Object.freeze({
        sourceHash,
        routes: extractLaravelRouteFacts(content),
      }));
    }
  });

  const classNodeIdByName = new Map<string, string>();
  const classFactByName = new Map<string, PhpLaravelClassFact>();
  classFacts.forEach((fact) => {
    nodes.set(fact.classNodeId, createPhpClassNode(fact));
    classNodeIdByName.set(fact.className, fact.classNodeId);
    classFactByName.set(fact.className, fact);
  });

  classFacts.forEach((fact) => {
    fact.methodCalls.forEach((methodCall) => {
      methodCall.calledDependencies.forEach((dependency) => {
        const targetClassName = fact.injectedTypes.get(dependency);
        const targetNodeId = targetClassName ? classNodeIdByName.get(targetClassName) : null;
        if (!targetNodeId || targetNodeId === fact.classNodeId) {
          return;
        }
        edges.set(
          `calls:${fact.classNodeId}:${targetNodeId}:${methodCall.methodName}:${dependency}`,
          createFrameworkEdge({
            fromNodeId: fact.classNodeId,
            toNodeId: targetNodeId,
            edgeType: 'calls',
            label: `${methodCall.methodName}:${dependency}`,
            relativePath: fact.relativePath,
            sourceHash: fact.sourceHash,
            provenanceKind: 'laravel_property_call',
            confidence: 0.76,
          }),
        );
      });
    });
  });

  routeFiles.forEach(({ sourceHash, routes }, relativePath) => {
    routes.forEach((route) => {
      const controllerNodeId = classNodeIdByName.get(route.controllerClass);
      if (!controllerNodeId) {
        return;
      }

      const endpointNode = createLaravelEndpointNode(relativePath, sourceHash, route);
      nodes.set(endpointNode.id, endpointNode);
      edges.set(
        `routes:${endpointNode.id}:${controllerNodeId}`,
        createFrameworkEdge({
          fromNodeId: endpointNode.id,
          toNodeId: controllerNodeId,
          edgeType: 'routes_to',
          label: `${route.controllerClass}@${route.methodName}`,
          relativePath,
          sourceHash,
          provenanceKind: 'laravel_controller_binding',
          confidence: 0.9,
        }),
      );

      const controllerFact = classFactByName.get(route.controllerClass);
      const targetMethod = controllerFact?.methodCalls.find((methodCall) => methodCall.methodName === route.methodName);
      targetMethod?.calledDependencies.forEach((dependency) => {
        const targetClassName = controllerFact?.injectedTypes.get(dependency);
        const targetNodeId = targetClassName ? classNodeIdByName.get(targetClassName) : null;
        if (!targetNodeId) {
          return;
        }
        edges.set(
          `route-calls:${endpointNode.id}:${targetNodeId}:${dependency}`,
          createFrameworkEdge({
            fromNodeId: endpointNode.id,
            toNodeId: targetNodeId,
            edgeType: 'calls',
            label: `${route.methodName}:${dependency}`,
            relativePath,
            sourceHash,
            provenanceKind: 'laravel_route_method_call',
            confidence: 0.8,
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
 * Framework adapter for Laravel routes, controllers, and service call extraction.
 */
export const phpLaravelWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'php-laravel',
  label: 'PHP / Laravel',
  extract: extractPhpLaravelWorkflowGraph,
});
