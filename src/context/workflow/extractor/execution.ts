/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Executable unit traversal and call-edge extraction for workflow graphs.
 */

import * as ts from 'typescript';
import type {
  ParsedFile,
  SymbolUnit,
  WorkflowExecutionGraphState,
  WorkflowSymbolResolutionContext,
} from '../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../entities/graph';
import { DB_QUERY_METHODS, HTTP_METHODS, QUEUE_PUBLISH_METHODS } from '../entities/constants';
import { getLineNumber, maybeGetStringLiteralValue } from './files';
import {
  addNode,
  createDbQueryNode,
  createEdge,
  createQueueNode,
  getHttpMethodFromFetch,
  getPropertyAccessName,
  isLikelyDbReceiver,
  resolveSymbolTargetId,
  walkNode,
} from './nodes';

/**
 * Resolves a JSX tag expression to a known workflow node id when possible.
 */
function resolveJsxTargetId(
  parsedFile: ParsedFile,
  tagName: ts.JsxTagNameExpression,
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | null {
  if (ts.isIdentifier(tagName)) {
    if (!/^[A-Z]/.test(tagName.text)) {
      return null;
    }
    return resolveSymbolTargetId(parsedFile, tagName, exportedSymbolsByFile);
  }

  if (ts.isPropertyAccessExpression(tagName)) {
    return resolveSymbolTargetId(parsedFile, tagName, exportedSymbolsByFile);
  }

  return null;
}

/**
 * Visits executable bodies and extracts React-style JSX composition edges.
 *
 * @param unit Workflow unit whose callable bodies should be traversed.
 * @param parsedFile Parsed source file that owns the unit.
 * @param edges Mutable edge collection that receives discovered composition edges.
 * @param exportedSymbolsByFile Exported symbol lookup used for component resolution.
 */
export function visitJsxCompositionUnit(
  unit: SymbolUnit,
  parsedFile: ParsedFile,
  edges: Map<string, WorkflowEdgeRecord>,
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): void {
  unit.callableNodes.forEach((callableNode) => {
    walkNode(callableNode, (current) => {
      if (ts.isJsxSelfClosingElement(current) || ts.isJsxOpeningElement(current)) {
        const targetId = resolveJsxTargetId(parsedFile, current.tagName, exportedSymbolsByFile);
        if (!targetId || targetId === unit.id) {
          return;
        }
        const line = getLineNumber(parsedFile.sourceFile, current);
        const edge = createEdge({
          fromNodeId: unit.id,
          toNodeId: targetId,
          edgeType: 'renders',
          label: current.tagName.getText(parsedFile.sourceFile),
          filePath: parsedFile.relativePath,
          symbolName: unit.symbolName,
          line,
          sourceHash: parsedFile.sourceHash,
          confidence: 0.74,
          provenanceKind: 'jsx_component_reference',
        });
        edges.set(edge.id, edge);
        return;
      }
    });
  });
}

/**
 * Visits executable bodies and extracts generic call, HTTP, queue, and DB edges.
 *
 * @param unit Workflow unit whose executable bodies should be traversed.
 * @param parsedFile Parsed source file that owns the unit.
 * @param nodes Mutable workflow node collection.
 * @param edges Mutable workflow edge collection.
 * @param exportedSymbolsByFile Exported symbol lookup used for cross-file resolution.
 */
export function visitGenericExecutableUnit(
  unit: SymbolUnit,
  parsedFile: ParsedFile,
  nodes: Map<string, WorkflowNodeRecord>,
  edges: Map<string, WorkflowEdgeRecord>,
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): void {
  unit.callableNodes.forEach((callableNode) => {
    walkNode(callableNode, (current) => {
      if (!ts.isCallExpression(current)) {
        return;
      }

      const line = getLineNumber(parsedFile.sourceFile, current);
      const calleeProperty = getPropertyAccessName(current.expression);

      if (ts.isIdentifier(current.expression) && current.expression.text === 'fetch') {
        const routePath = maybeGetStringLiteralValue(current.arguments[0]);
        if (!routePath) {
          return;
        }
        const method = getHttpMethodFromFetch(current);
        const isInternal = routePath.startsWith('/');
        const createdAt = Date.now();
        const targetNode: WorkflowNodeRecord = isInternal
          ? Object.freeze({
              id: `workflow:route:${method}:${routePath}`,
              nodeType: 'api_endpoint',
              label: `${method} ${routePath}`,
              routeMethod: method,
              routePath,
              description: `HTTP endpoint ${method} ${routePath}`,
              descriptionSource: 'heuristic',
              confidence: 0.66,
              provenance: Object.freeze({
                source: 'typescript_ast',
                kind: 'http_call',
              }),
              sourceHash: parsedFile.sourceHash,
              createdAt,
              updatedAt: createdAt,
            })
          : Object.freeze({
              id: `workflow:http-external:${method}:${routePath}`,
              nodeType: 'external_dependency',
              label: `${method} ${routePath}`,
              description: `External HTTP dependency ${routePath}`,
              descriptionSource: 'heuristic',
              confidence: 0.6,
              provenance: Object.freeze({
                source: 'typescript_ast',
                kind: 'http_call',
              }),
              sourceHash: parsedFile.sourceHash,
              createdAt,
              updatedAt: createdAt,
            });
        addNode(nodes, targetNode);
        const edge = createEdge({
          fromNodeId: unit.id,
          toNodeId: targetNode.id,
          edgeType: 'invokes_http',
          label: `${method} ${routePath}`,
          filePath: parsedFile.relativePath,
          symbolName: unit.symbolName,
          line,
          sourceHash: parsedFile.sourceHash,
          confidence: 0.82,
          provenanceKind: 'fetch_call',
        });
        edges.set(edge.id, edge);
        return;
      }

      if (calleeProperty && HTTP_METHODS.has(calleeProperty)) {
        const routePath = maybeGetStringLiteralValue(current.arguments[0]);
        if (!routePath || !ts.isPropertyAccessExpression(current.expression)) {
          return;
        }
        const method = calleeProperty.toUpperCase();
        const receiverText = current.expression.expression.getText(parsedFile.sourceFile).toLowerCase();
        if (!/(axios|http|client|api|request|fetcher|sdk)/.test(receiverText)) {
          const targetId = resolveSymbolTargetId(parsedFile, current.expression, exportedSymbolsByFile);
          if (targetId) {
            const edge = createEdge({
              fromNodeId: unit.id,
              toNodeId: targetId,
              edgeType: 'calls',
              label: current.expression.getText(parsedFile.sourceFile),
              filePath: parsedFile.relativePath,
              symbolName: unit.symbolName,
              line,
              sourceHash: parsedFile.sourceHash,
              confidence: 0.76,
              provenanceKind: 'property_call_resolution',
            });
            edges.set(edge.id, edge);
          }
          return;
        }

        const createdAt = Date.now();
        const isInternal = routePath.startsWith('/');
        const targetNode: WorkflowNodeRecord = isInternal
          ? Object.freeze({
              id: `workflow:route:${method}:${routePath}`,
              nodeType: 'api_endpoint',
              label: `${method} ${routePath}`,
              routeMethod: method,
              routePath,
              description: `HTTP endpoint ${method} ${routePath}`,
              descriptionSource: 'heuristic',
              confidence: 0.64,
              provenance: Object.freeze({
                source: 'typescript_ast',
                kind: 'http_client_call',
              }),
              sourceHash: parsedFile.sourceHash,
              createdAt,
              updatedAt: createdAt,
            })
          : Object.freeze({
              id: `workflow:http-external:${method}:${routePath}`,
              nodeType: 'external_dependency',
              label: `${method} ${routePath}`,
              description: `External HTTP dependency ${routePath}`,
              descriptionSource: 'heuristic',
              confidence: 0.58,
              provenance: Object.freeze({
                source: 'typescript_ast',
                kind: 'http_client_call',
              }),
              sourceHash: parsedFile.sourceHash,
              createdAt,
              updatedAt: createdAt,
            });
        addNode(nodes, targetNode);
        const edge = createEdge({
          fromNodeId: unit.id,
          toNodeId: targetNode.id,
          edgeType: 'invokes_http',
          label: `${method} ${routePath}`,
          filePath: parsedFile.relativePath,
          symbolName: unit.symbolName,
          line,
          sourceHash: parsedFile.sourceHash,
          confidence: 0.8,
          provenanceKind: 'http_client_call',
        });
        edges.set(edge.id, edge);
        return;
      }

      if (calleeProperty && DB_QUERY_METHODS.has(calleeProperty) && ts.isPropertyAccessExpression(current.expression)) {
        const receiverText = current.expression.expression.getText(parsedFile.sourceFile).trim();
        if (isLikelyDbReceiver(receiverText)) {
          const dbNode = createDbQueryNode({
            receiverText,
            methodName: calleeProperty,
            queryText: maybeGetStringLiteralValue(current.arguments[0]),
            sourceHash: parsedFile.sourceHash,
          });
          addNode(nodes, dbNode);
          const edge = createEdge({
            fromNodeId: unit.id,
            toNodeId: dbNode.id,
            edgeType: 'queries',
            label: dbNode.label,
            filePath: parsedFile.relativePath,
            symbolName: unit.symbolName,
            line,
            sourceHash: parsedFile.sourceHash,
            confidence: 0.84,
            provenanceKind: 'db_query_call',
          });
          edges.set(edge.id, edge);
          return;
        }
      }

      if (calleeProperty && QUEUE_PUBLISH_METHODS.has(calleeProperty)) {
        const topicName = maybeGetStringLiteralValue(current.arguments[0]);
        if (!topicName) {
          return;
        }
        const queueNode = createQueueNode(topicName, parsedFile.sourceHash);
        addNode(nodes, queueNode);
        const edge = createEdge({
          fromNodeId: unit.id,
          toNodeId: queueNode.id,
          edgeType: 'publishes',
          label: topicName,
          filePath: parsedFile.relativePath,
          symbolName: unit.symbolName,
          line,
          sourceHash: parsedFile.sourceHash,
          confidence: 0.76,
          provenanceKind: 'queue_publish',
        });
        edges.set(edge.id, edge);
        return;
      }

      const targetId = resolveSymbolTargetId(parsedFile, current.expression, exportedSymbolsByFile);
      if (!targetId || targetId === unit.id) {
        return;
      }
      const edge = createEdge({
        fromNodeId: unit.id,
        toNodeId: targetId,
        edgeType: 'calls',
        label: current.expression.getText(parsedFile.sourceFile),
        filePath: parsedFile.relativePath,
        symbolName: unit.symbolName,
        line,
        sourceHash: parsedFile.sourceHash,
        confidence: 0.78,
        provenanceKind: 'call_expression',
      });
      edges.set(edge.id, edge);
    });
  });
}

/**
 * Backward-compatible wrapper that applies both generic executable edges and JSX composition edges.
 *
 * @param unit Workflow unit whose executable bodies should be traversed.
 * @param parsedFile Parsed source file that owns the unit.
 * @param graphState Mutable workflow graph state updated during traversal.
 * @param symbolContext Exported symbol lookup used for cross-file resolution.
 */
export function visitExecutableUnit(
  unit: SymbolUnit,
  parsedFile: ParsedFile,
  graphState: WorkflowExecutionGraphState,
  symbolContext: WorkflowSymbolResolutionContext,
): void {
  visitGenericExecutableUnit(unit, parsedFile, graphState.nodes, graphState.edges, symbolContext.exportedSymbolsByFile);
  visitJsxCompositionUnit(unit, parsedFile, graphState.edges, symbolContext.exportedSymbolsByFile);
}
