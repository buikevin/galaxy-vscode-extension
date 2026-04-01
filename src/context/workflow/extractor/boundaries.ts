/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Route, queue, and scheduler seed extraction for workflow graphs.
 */

import * as ts from 'typescript';
import type { ParsedFile, SymbolUnit } from '../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../entities/graph';
import { HTTP_METHODS, QUEUE_CONSUME_METHODS, SCHEDULE_METHODS } from '../entities/constants';
import { getLineNumber, maybeGetStringLiteralValue } from './files';
import {
  addNode,
  createEdge,
  createGraphNodeFromUnit,
  createJobNode,
  createQueueNode,
  createRouteNode,
  createSyntheticHandlerUnit,
  getPropertyAccessName,
  resolveImportedTargetId,
  walkNode,
} from './nodes';

/**
 * Extracts boundary entrypoints such as routes, queue consumers, and scheduled jobs.
 */
export function extractRouteAndBoundarySeeds(
  parsedFile: ParsedFile,
  nodes: Map<string, WorkflowNodeRecord>,
  edges: Map<string, WorkflowEdgeRecord>,
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): readonly SymbolUnit[] {
  const syntheticUnits: SymbolUnit[] = [];

  walkNode(parsedFile.sourceFile, (current) => {
    if (!ts.isCallExpression(current)) {
      return;
    }

    const calleeName = getPropertyAccessName(current.expression);
    if (calleeName && HTTP_METHODS.has(calleeName)) {
      const routePath = maybeGetStringLiteralValue(current.arguments[0]);
      if (!routePath || !ts.isPropertyAccessExpression(current.expression)) {
        return;
      }
      const receiverText = current.expression.expression.getText(parsedFile.sourceFile).toLowerCase();
      if (!/(router|app|server|fastify|route)/.test(receiverText)) {
        return;
      }

      const method = calleeName.toUpperCase();
      const routeNode = createRouteNode({
        relativePath: parsedFile.relativePath,
        method,
        routePath,
        sourceFile: parsedFile.sourceFile,
        node: current,
        sourceHash: parsedFile.sourceHash,
      });
      addNode(nodes, routeNode);

      const handlerArg = current.arguments[1];
      if (!handlerArg) {
        return;
      }
      if (ts.isIdentifier(handlerArg)) {
        const localTargetId = parsedFile.localSymbolIds.get(handlerArg.text);
        const importedTargetId = resolveImportedTargetId(parsedFile.importBindings.get(handlerArg.text), undefined, exportedSymbolsByFile);
        const targetId = localTargetId ?? importedTargetId;
        if (targetId) {
          const edge = createEdge({
            fromNodeId: routeNode.id,
            toNodeId: targetId,
            edgeType: 'routes_to',
            label: handlerArg.text,
            filePath: parsedFile.relativePath,
            symbolName: handlerArg.text,
            line: getLineNumber(parsedFile.sourceFile, current),
            sourceHash: parsedFile.sourceHash,
            confidence: 0.9,
            provenanceKind: 'route_handler_binding',
          });
          edges.set(edge.id, edge);
        }
        return;
      }

      if (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg)) {
        const inlineUnit = createSyntheticHandlerUnit({
          parsedFile,
          callableNode: handlerArg.body,
          nodeType: /webhook/i.test(routePath) ? 'webhook_handler' : 'controller',
          label: `${method} ${routePath} handler`,
          description: `Inline handler for ${method} ${routePath}`,
        });
        syntheticUnits.push(inlineUnit);
        addNode(nodes, createGraphNodeFromUnit(inlineUnit));
        const edge = createEdge({
          fromNodeId: routeNode.id,
          toNodeId: inlineUnit.id,
          edgeType: 'routes_to',
          label: inlineUnit.label,
          filePath: parsedFile.relativePath,
          symbolName: inlineUnit.symbolName,
          line: getLineNumber(parsedFile.sourceFile, current),
          sourceHash: parsedFile.sourceHash,
          confidence: 0.86,
          provenanceKind: 'inline_route_handler',
        });
        edges.set(edge.id, edge);
      }
      return;
    }

    if (!calleeName || !QUEUE_CONSUME_METHODS.has(calleeName) || current.arguments.length < 2) {
      if (!calleeName || !SCHEDULE_METHODS.has(calleeName) || current.arguments.length < 2) {
        return;
      }

      const scheduleLabel = maybeGetStringLiteralValue(current.arguments[0]) ?? 'scheduled-task';
      const jobNode = createJobNode(scheduleLabel, parsedFile.sourceHash);
      addNode(nodes, jobNode);
      const handlerArg = current.arguments[1];
      if (!handlerArg) {
        return;
      }
      if (ts.isIdentifier(handlerArg)) {
        const localTargetId = parsedFile.localSymbolIds.get(handlerArg.text);
        const importedTargetId = resolveImportedTargetId(parsedFile.importBindings.get(handlerArg.text), undefined, exportedSymbolsByFile);
        const targetId = localTargetId ?? importedTargetId;
        if (targetId) {
          const edge = createEdge({
            fromNodeId: jobNode.id,
            toNodeId: targetId,
            edgeType: 'triggers',
            label: handlerArg.text,
            filePath: parsedFile.relativePath,
            symbolName: handlerArg.text,
            line: getLineNumber(parsedFile.sourceFile, current),
            sourceHash: parsedFile.sourceHash,
            confidence: 0.8,
            provenanceKind: 'scheduler_handler_binding',
          });
          edges.set(edge.id, edge);
        }
      } else if (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg)) {
        const inlineUnit = createSyntheticHandlerUnit({
          parsedFile,
          callableNode: handlerArg.body,
          nodeType: 'worker',
          label: `job ${scheduleLabel} handler`,
          description: `Inline scheduled handler for ${scheduleLabel}`,
        });
        syntheticUnits.push(inlineUnit);
        addNode(nodes, createGraphNodeFromUnit(inlineUnit));
        const edge = createEdge({
          fromNodeId: jobNode.id,
          toNodeId: inlineUnit.id,
          edgeType: 'triggers',
          label: inlineUnit.label,
          filePath: parsedFile.relativePath,
          symbolName: inlineUnit.symbolName,
          line: getLineNumber(parsedFile.sourceFile, current),
          sourceHash: parsedFile.sourceHash,
          confidence: 0.78,
          provenanceKind: 'inline_scheduler_handler',
        });
        edges.set(edge.id, edge);
      }
      return;
    }

    const topicName = maybeGetStringLiteralValue(current.arguments[0]);
    if (!topicName) {
      return;
    }
    const queueNode = createQueueNode(topicName, parsedFile.sourceHash);
    addNode(nodes, queueNode);

    const handlerArg = current.arguments[1];
    if (!handlerArg) {
      return;
    }
    if (ts.isIdentifier(handlerArg)) {
      const localTargetId = parsedFile.localSymbolIds.get(handlerArg.text);
      const importedTargetId = resolveImportedTargetId(parsedFile.importBindings.get(handlerArg.text), undefined, exportedSymbolsByFile);
      const targetId = localTargetId ?? importedTargetId;
      if (targetId) {
        const edge = createEdge({
          fromNodeId: queueNode.id,
          toNodeId: targetId,
          edgeType: 'consumes',
          label: handlerArg.text,
          filePath: parsedFile.relativePath,
          symbolName: handlerArg.text,
          line: getLineNumber(parsedFile.sourceFile, current),
          sourceHash: parsedFile.sourceHash,
          confidence: 0.78,
          provenanceKind: 'queue_consumer_binding',
        });
        edges.set(edge.id, edge);
      }
      return;
    }

    if (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg)) {
      const inlineUnit = createSyntheticHandlerUnit({
        parsedFile,
        callableNode: handlerArg.body,
        nodeType: 'message_handler',
        label: `${topicName} consumer`,
        description: `Inline consumer for ${topicName}`,
      });
      syntheticUnits.push(inlineUnit);
      addNode(nodes, createGraphNodeFromUnit(inlineUnit));
      const edge = createEdge({
        fromNodeId: queueNode.id,
        toNodeId: inlineUnit.id,
        edgeType: 'consumes',
        label: inlineUnit.label,
        filePath: parsedFile.relativePath,
        symbolName: inlineUnit.symbolName,
        line: getLineNumber(parsedFile.sourceFile, current),
        sourceHash: parsedFile.sourceHash,
        confidence: 0.75,
        provenanceKind: 'inline_queue_consumer',
      });
      edges.set(edge.id, edge);
    }
  });

  return Object.freeze(syntheticUnits);
}
