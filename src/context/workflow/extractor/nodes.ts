/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow node and edge construction helpers for static graph extraction.
 */

import * as ts from 'typescript';
import type { ImportBinding, ParsedFile, SymbolUnit } from '../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../entities/graph';
import { DB_QUERY_METHODS, HTTP_METHODS } from '../entities/constants';
import { getLineNumber, getNodeEndLine, maybeGetStringLiteralValue, sanitizeIdentifier } from './files';

/**
 * Adds a node to the working graph, preferring the higher-confidence version.
 */
export function addNode(target: Map<string, WorkflowNodeRecord>, node: WorkflowNodeRecord): void {
  const existing = target.get(node.id);
  if (!existing || (existing.confidence ?? 0) <= (node.confidence ?? 0)) {
    target.set(node.id, node);
  }
}

/**
 * Converts a parsed symbol unit into a persisted workflow graph node.
 */
export function createGraphNodeFromUnit(unit: SymbolUnit): WorkflowNodeRecord {
  return Object.freeze({
    id: unit.id,
    nodeType: unit.nodeType,
    label: unit.label,
    filePath: unit.relativePath,
    ...(unit.symbolName ? { symbolName: unit.symbolName } : {}),
    startLine: unit.startLine,
    endLine: unit.endLine,
    ...(unit.description ? { description: unit.description } : {}),
    ...(unit.descriptionSource ? { descriptionSource: unit.descriptionSource } : {}),
    confidence: unit.confidence,
    provenance: Object.freeze({
      source: 'typescript_ast',
      kind: 'symbol_unit',
    }),
    sourceHash: unit.sourceHash,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  });
}

/**
 * Creates a workflow node for an HTTP route registration.
 */
export function createRouteNode(opts: {
  relativePath: string;
  method: string;
  routePath: string;
  sourceFile: ts.SourceFile;
  node: ts.Node;
  sourceHash: string;
}): WorkflowNodeRecord {
  const label = `${opts.method} ${opts.routePath}`;
  const createdAt = Date.now();
  const nodeType = /webhook/i.test(opts.routePath) ? 'webhook_handler' : 'api_endpoint';
  return Object.freeze({
    id: `workflow:route:${opts.method}:${opts.routePath}`,
    nodeType,
    label,
    filePath: opts.relativePath,
    routeMethod: opts.method,
    routePath: opts.routePath,
    startLine: getLineNumber(opts.sourceFile, opts.node),
    endLine: getNodeEndLine(opts.sourceFile, opts.node),
    description: `${nodeType.replace(/_/g, ' ')} ${label}`,
    descriptionSource: 'heuristic',
    confidence: 0.94,
    provenance: Object.freeze({
      source: 'typescript_ast',
      kind: 'route_registration',
    }),
    sourceHash: opts.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a queue/topic workflow node.
 */
export function createQueueNode(topic: string, sourceHash: string): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:queue:${topic}`,
    nodeType: 'queue_topic',
    label: topic,
    description: `Queue/topic ${topic}`,
    descriptionSource: 'heuristic',
    confidence: 0.74,
    provenance: Object.freeze({
      source: 'typescript_ast',
      kind: 'queue_boundary',
    }),
    sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a scheduled job workflow node.
 */
export function createJobNode(label: string, sourceHash: string): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:job:${sanitizeIdentifier(label)}`,
    nodeType: 'job',
    label,
    description: `Scheduled job ${label}`,
    descriptionSource: 'heuristic',
    confidence: 0.72,
    provenance: Object.freeze({
      source: 'typescript_ast',
      kind: 'scheduler_boundary',
    }),
    sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Heuristically checks whether a call receiver looks like a database handle.
 */
export function isLikelyDbReceiver(receiverText: string): boolean {
  return /(prisma|db|database|knex|sequelize|typeorm|mongoose|mongo|sql|pool|connection|entitymanager|model)/i.test(receiverText);
}

/**
 * Creates a synthetic database-query workflow node.
 */
export function createDbQueryNode(opts: {
  receiverText: string;
  methodName: string;
  queryText?: string | null;
  sourceHash: string;
}): WorkflowNodeRecord {
  const rawLabel = opts.queryText
    ? `${opts.receiverText}.${opts.methodName} ${opts.queryText.replace(/\s+/g, ' ').trim().slice(0, 80)}`
    : `${opts.receiverText}.${opts.methodName}`;
  const label = rawLabel.trim();
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:db:${sanitizeIdentifier(label.toLowerCase())}`,
    nodeType: 'db_query',
    label,
    description: `Database query via ${opts.receiverText}.${opts.methodName}`,
    descriptionSource: 'heuristic',
    confidence: 0.82,
    provenance: Object.freeze({
      source: 'typescript_ast',
      kind: 'db_query_call',
    }),
    sourceHash: opts.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a synthetic inline handler unit for route, queue, or scheduler callbacks.
 */
export function createSyntheticHandlerUnit(opts: {
  parsedFile: ParsedFile;
  callableNode: ts.Node;
  nodeType: string;
  label: string;
  description: string;
}): SymbolUnit {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:inline:${opts.parsedFile.relativePath}:${opts.callableNode.getStart(opts.parsedFile.sourceFile)}`,
    relativePath: opts.parsedFile.relativePath,
    nodeType: opts.nodeType,
    label: opts.label,
    symbolName: opts.label,
    startLine: getLineNumber(opts.parsedFile.sourceFile, opts.callableNode),
    endLine: getNodeEndLine(opts.parsedFile.sourceFile, opts.callableNode),
    description: opts.description,
    descriptionSource: 'heuristic',
    confidence: 0.78,
    sourceHash: opts.parsedFile.sourceHash,
    createdAt,
    updatedAt: createdAt,
    callableNodes: [opts.callableNode],
    exported: false,
  });
}

/**
 * Extracts a property-access name from an expression when present.
 */
export function getPropertyAccessName(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

/**
 * Extracts a simple identifier text from an expression when possible.
 */
export function getIdentifierText(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }
  return null;
}

/**
 * Infers the HTTP method from a fetch() call options object.
 */
export function getHttpMethodFromFetch(callExpression: ts.CallExpression): string {
  const optionsArg = callExpression.arguments[1];
  if (!optionsArg || !ts.isObjectLiteralExpression(optionsArg)) {
    return 'GET';
  }
  for (const property of optionsArg.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const key = property.name.getText().replace(/['"`]/g, '').toLowerCase();
    if (key === 'method') {
      const methodValue = maybeGetStringLiteralValue(property.initializer);
      return methodValue?.toUpperCase() ?? 'GET';
    }
  }
  return 'GET';
}

/**
 * Creates a workflow edge with provenance and support metadata.
 */
export function createEdge(opts: {
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  label?: string | undefined;
  filePath: string;
  symbolName?: string | undefined;
  line: number;
  sourceHash: string;
  confidence: number;
  provenanceKind: string;
}): WorkflowEdgeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:edge:${sanitizeIdentifier(`${opts.fromNodeId}:${opts.edgeType}:${opts.toNodeId}:${opts.line}`)}`,
    fromNodeId: opts.fromNodeId,
    toNodeId: opts.toNodeId,
    edgeType: opts.edgeType,
    ...(opts.label ? { label: opts.label } : {}),
    confidence: opts.confidence,
    provenance: Object.freeze({
      source: 'typescript_ast',
      kind: opts.provenanceKind,
    }),
    supportingFilePath: opts.filePath,
    ...(opts.symbolName ? { supportingSymbolName: opts.symbolName } : {}),
    supportingLine: opts.line,
    sourceHash: opts.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Resolves an imported symbol to a workflow node id in another file.
 */
export function resolveImportedTargetId(
  binding: ImportBinding | undefined,
  propertyName: string | undefined,
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | null {
  if (!binding) {
    return null;
  }
  const targetSymbols = exportedSymbolsByFile.get(binding.targetFile);
  if (!targetSymbols) {
    return null;
  }
  if (binding.importedName === '*' && propertyName) {
    return targetSymbols.get(propertyName) ?? null;
  }
  if (binding.importedName === 'default') {
    return propertyName ? targetSymbols.get(propertyName) ?? null : null;
  }
  return targetSymbols.get(binding.importedName) ?? null;
}

/**
 * Walks a syntax subtree depth-first.
 */
export function walkNode(node: ts.Node, visit: (current: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walkNode(child, visit));
}

/**
 * Resolves a call target expression to a known workflow node id when possible.
 */
export function resolveSymbolTargetId(
  parsedFile: ParsedFile,
  expression: ts.Expression,
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | null {
  if (ts.isIdentifier(expression)) {
    return parsedFile.localSymbolIds.get(expression.text)
      ?? resolveImportedTargetId(parsedFile.importBindings.get(expression.text), undefined, exportedSymbolsByFile);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const propertyName = expression.name.text;
    if (ts.isIdentifier(expression.expression)) {
      const importedTarget = resolveImportedTargetId(parsedFile.importBindings.get(expression.expression.text), propertyName, exportedSymbolsByFile);
      if (importedTarget) {
        return importedTarget;
      }
    }
  }
  return null;
}

/**
 * Checks whether a property-style call looks like a DB query method.
 */
export function isDbQueryMethod(propertyName: string | null): boolean {
  return Boolean(propertyName && DB_QUERY_METHODS.has(propertyName));
}

/**
 * Checks whether a property-style call looks like an HTTP method.
 */
export function isHttpMethod(propertyName: string | null): boolean {
  return Boolean(propertyName && HTTP_METHODS.has(propertyName));
}
