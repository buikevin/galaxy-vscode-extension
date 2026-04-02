/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Java Spring workflow extractor adapter that identifies controllers, endpoints, services, repositories, and their call chains.
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
  joinFrameworkRoutePath,
  normalizeFrameworkRoutePath,
  sanitizeFrameworkIdentifier,
} from '../framework-helpers';

type JavaClassFact = WorkflowBackendClassFact;

/**
 * Normalizes arbitrary text into a safe workflow id segment.
 *
 * @param value Raw text that may contain unsupported id characters.
 * @returns Identifier-safe string for workflow ids.
 */
/**
 * Reads the first quoted literal from an annotation argument string.
 *
 * @param input Raw annotation argument text.
 * @returns First quoted string literal, if present.
 */
function getFirstQuotedValue(input: string): string | null {
  const match = input.match(/["']([^"']+)["']/);
  return match?.[1] ?? null;
}

/**
 * Infers the graph node type for a Java class using Spring annotations and naming conventions.
 *
 * @param relativePath Workspace-relative source file path.
 * @param content Full Java source content.
 * @param className Parsed Java class name.
 * @returns Workflow node type for the class.
 */
function inferClassNodeType(relativePath: string, content: string, className: string): string {
  if (/@RestController\b|@Controller\b/.test(content)) {
    return 'controller';
  }
  if (/@Repository\b/.test(content) || /Repository$/.test(className) || /repository/.test(relativePath.toLowerCase())) {
    return 'repository';
  }
  if (/@Service\b/.test(content) || /Service$/.test(className) || /service/.test(relativePath.toLowerCase())) {
    return 'backend_service';
  }
  if (/Controller$/.test(className)) {
    return 'controller';
  }
  if (/Repository$/.test(className)) {
    return 'repository';
  }
  if (/Service$/.test(className)) {
    return 'backend_service';
  }
  return 'entrypoint';
}

/**
 * Extracts field-name to class-type mappings used for service and repository call resolution.
 *
 * @param content Full Java source content.
 * @returns Mapping from injected field names to declared class names.
 */
function extractFieldTypes(content: string): ReadonlyMap<string, string> {
  const fieldTypes = new Map<string, string>();
  const fieldPattern = /(?:private|protected|public)\s+(?:final\s+)?([A-Z][A-Za-z0-9_]*)\s+([a-zA-Z_][A-Za-z0-9_]*)\s*(?:=|;)/g;
  for (const match of content.matchAll(fieldPattern)) {
    const typeName = match[1];
    const fieldName = match[2];
    if (typeName && fieldName) {
      fieldTypes.set(fieldName, typeName);
    }
  }
  return fieldTypes;
}

/**
 * Finds the closing brace index matching a given opening brace index.
 *
 * @param content Full Java source content.
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
 * Extracts injected field names that are invoked inside a method body.
 *
 * @param body Method body text.
 * @param fieldTypes Known injected field-type mappings.
 * @returns Sorted field names invoked inside the method body.
 */
function extractCalledDependencies(body: string, fieldTypes: ReadonlyMap<string, string>): readonly string[] {
  const calls = new Set<string>();
  fieldTypes.forEach((_type, fieldName) => {
    const fieldPattern = new RegExp(`\\b${fieldName}\\s*\\.\\s*[a-zA-Z_][A-Za-z0-9_]*\\s*\\(`, 'g');
    if (fieldPattern.test(body)) {
      calls.add(fieldName);
    }
  });
  return Object.freeze([...calls].sort((a, b) => a.localeCompare(b)));
}

/**
 * Extracts a class-level Spring route prefix from `@RequestMapping`.
 *
 * @param content Full Java source content.
 * @returns Normalized class-level route prefix when present.
 */
function extractRouteBase(content: string): string | undefined {
  const requestMappingMatch = content.match(/@RequestMapping\s*\(([\s\S]*?)\)/);
  const routePath = requestMappingMatch ? getFirstQuotedValue(requestMappingMatch[1] ?? '') : null;
  return routePath ? normalizeFrameworkRoutePath(routePath) : undefined;
}

/**
 * Parses a Java class file into an intermediate Spring workflow fact.
 *
 * @param relativePath Workspace-relative Java file path.
 * @param content Full Java source content.
 * @param sourceHash Stable source hash for invalidation.
 * @returns Parsed Spring class fact, or `null` when no class is found.
 */
function parseJavaClassFact(relativePath: string, content: string, sourceHash: string): JavaClassFact | null {
  const classMatch = content.match(/class\s+([A-Z][A-Za-z0-9_]*)/);
  const className = classMatch?.[1];
  if (!className) {
    return null;
  }

  const injectedTypes = extractFieldTypes(content);
  const routeBase = extractRouteBase(content);
  const classNodeId = `workflow:java:${relativePath}:${sanitizeFrameworkIdentifier(className)}`;
  const classNodeType = inferClassNodeType(relativePath, content, className) as JavaClassFact['classNodeType'];
  const methodRoutes: WorkflowMethodRouteFact[] = [];
  const methodCalls: WorkflowMethodCallFact[] = [];

  const routeAnnotationPattern =
    /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(([\s\S]*?)\)\s*(?:public|protected|private)\s+[A-Za-z0-9_<>\[\], ?]+\s+([a-zA-Z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/g;

  for (const match of content.matchAll(routeAnnotationPattern)) {
    const annotation = match[1];
    const annotationArgs = match[2] ?? '';
    const methodName = match[3];
    const signatureIndex = match.index ?? -1;
    const openBraceIndex = content.indexOf('{', signatureIndex);
    const closeBraceIndex = openBraceIndex >= 0 ? findMatchingBrace(content, openBraceIndex) : -1;
    const methodBody = openBraceIndex >= 0 && closeBraceIndex > openBraceIndex ? content.slice(openBraceIndex + 1, closeBraceIndex) : '';
    if (!annotation) {
      continue;
    }
    const methodFromRequest = annotation.replace('Mapping', '').toUpperCase();
    const routeValue = getFirstQuotedValue(annotationArgs) ?? '/';
    if (!methodName) {
      continue;
    }
    methodRoutes.push({
      methodName,
      httpMethod: methodFromRequest,
      routePath: joinFrameworkRoutePath(routeBase, routeValue),
      calledDependencies: extractCalledDependencies(methodBody, injectedTypes),
    });
  }

  const methodPattern = /(?:public|protected|private)\s+[A-Za-z0-9_<>\[\], ?]+\s+([a-zA-Z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/g;
  for (const match of content.matchAll(methodPattern)) {
    const methodName = match[1];
    const signatureIndex = match.index ?? -1;
    const openBraceIndex = content.indexOf('{', signatureIndex);
    const closeBraceIndex = openBraceIndex >= 0 ? findMatchingBrace(content, openBraceIndex) : -1;
    const methodBody = openBraceIndex >= 0 && closeBraceIndex > openBraceIndex ? content.slice(openBraceIndex + 1, closeBraceIndex) : '';
    if (!methodName) {
      continue;
    }
    methodCalls.push({
      methodName,
      calledDependencies: extractCalledDependencies(methodBody, injectedTypes),
    });
  }

  return Object.freeze({
    relativePath,
    className,
    classNodeId,
    classNodeType,
    ...(routeBase ? { routeBase } : {}),
    injectedTypes,
    methodRoutes: Object.freeze(methodRoutes),
    methodCalls: Object.freeze(methodCalls),
    sourceHash,
  });
}

/**
 * Converts a parsed Spring class fact into a workflow node for the class itself.
 *
 * @param fact Parsed Spring class fact.
 * @returns Frozen workflow node record for the class.
 */
function createJavaClassNode(fact: JavaClassFact): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: fact.classNodeId,
    nodeType: fact.classNodeType,
    label: fact.className,
    filePath: fact.relativePath,
    symbolName: fact.className,
    description: `${fact.classNodeType.replace(/_/g, ' ')} ${fact.className}`,
    descriptionSource: 'java_spring',
    confidence: 0.84,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'java_spring_class',
    }),
    sourceHash: fact.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates an API endpoint node from a Spring route-bearing method fact.
 *
 * @param fact Parsed Spring class fact that owns the route.
 * @param route Route-bearing method fact.
 * @returns Frozen workflow node record for the endpoint.
 */
function createEndpointNode(fact: JavaClassFact, route: WorkflowMethodRouteFact): WorkflowNodeRecord {
  return createFrameworkEndpointNode({
    id: `workflow:java-route:${route.httpMethod}:${route.routePath}`,
    label: `${route.httpMethod} ${route.routePath}`,
    relativePath: fact.relativePath,
    sourceHash: fact.sourceHash,
    symbolName: route.methodName,
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    description: `Spring endpoint ${route.httpMethod} ${route.routePath}`,
    descriptionSource: 'java_spring',
    provenanceKind: 'spring_route_mapping',
    confidence: 0.9,
  });
}

/**
 * Extracts Spring-style workflow nodes and edges from Java source files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from Java Spring files.
 */
async function extractJavaSpringWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const javaFiles = scanWorkspaceSourceFilesBySuffixes(workspacePath, ['.java']);
  if (javaFiles.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const facts = javaFiles
    .map((relativePath) => {
      const absolutePath = path.join(workspacePath, relativePath);
      const content = fs.readFileSync(absolutePath, 'utf8');
      return parseJavaClassFact(relativePath, content, createSourceHash(relativePath, content));
    })
    .filter((fact): fact is JavaClassFact => Boolean(fact));

  const nodes = new Map<string, WorkflowNodeRecord>();
  const classNodeIdByName = new Map<string, string>();
  facts.forEach((fact) => {
    const node = createJavaClassNode(fact);
    nodes.set(node.id, node);
    classNodeIdByName.set(fact.className, node.id);
  });

  const edges = new Map<string, WorkflowEdgeRecord>();
  facts.forEach((fact) => {
    fact.methodRoutes.forEach((route) => {
      const endpointNode = createEndpointNode(fact, route);
      nodes.set(endpointNode.id, endpointNode);
      const routeEdge = createFrameworkEdge({
        fromNodeId: endpointNode.id,
        toNodeId: fact.classNodeId,
        edgeType: 'routes_to',
        label: route.methodName,
        relativePath: fact.relativePath,
        sourceHash: fact.sourceHash,
        provenanceKind: 'spring_controller_binding',
        confidence: 0.9,
      });
      edges.set(routeEdge.id, routeEdge);

      route.calledDependencies.forEach((fieldName) => {
        const targetClassName = fact.injectedTypes.get(fieldName);
        const targetNodeId = targetClassName ? classNodeIdByName.get(targetClassName) : null;
        if (!targetNodeId) {
          return;
        }
        const edge = createFrameworkEdge({
          fromNodeId: endpointNode.id,
          toNodeId: targetNodeId,
          edgeType: 'calls',
          label: `${fieldName}.${route.methodName}`,
          relativePath: fact.relativePath,
          sourceHash: fact.sourceHash,
          provenanceKind: 'java_field_call',
          confidence: 0.78,
        });
        edges.set(edge.id, edge);
      });
    });

    fact.methodCalls.forEach((methodCall) => {
      methodCall.calledDependencies.forEach((fieldName) => {
        const targetClassName = fact.injectedTypes.get(fieldName);
        const targetNodeId = targetClassName ? classNodeIdByName.get(targetClassName) : null;
        if (!targetNodeId || targetNodeId === fact.classNodeId) {
          return;
        }
        const edge = createFrameworkEdge({
          fromNodeId: fact.classNodeId,
          toNodeId: targetNodeId,
          edgeType: 'calls',
          label: `${methodCall.methodName}:${fieldName}`,
          relativePath: fact.relativePath,
          sourceHash: fact.sourceHash,
          provenanceKind: 'java_field_call',
          confidence: 0.74,
        });
        edges.set(edge.id, edge);
      });
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for Java Spring controller, service, and repository workflow extraction.
 */
export const javaSpringWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'java-spring',
  label: 'Java Spring',
  extract: extractJavaSpringWorkflowGraph,
});
