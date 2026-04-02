/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Flutter workflow extractor adapter that identifies widget composition and named route navigation from `.dart` files.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import type { WorkflowFrameworkEdgeOptions, WorkflowWidgetFact } from '../../entities/adapters';
import { createSourceHash, scanWorkspaceSourceFilesBySuffixes } from '../files';

const FLUTTER_BUILTIN_WIDGETS = new Set([
  'Widget', 'BuildContext', 'Scaffold', 'Text', 'Column', 'Row', 'Container', 'Padding', 'Center', 'Expanded',
  'SizedBox', 'Icon', 'ListView', 'AppBar', 'MaterialApp', 'CupertinoApp', 'SafeArea', 'Align', 'Stack',
  'Positioned', 'Card', 'GestureDetector', 'InkWell', 'FutureBuilder', 'StreamBuilder', 'Theme', 'Navigator',
  'MaterialPageRoute', 'DefaultTabController', 'TabBar', 'TabBarView', 'Flexible', 'Spacer',
]);

/**
 * Normalizes arbitrary text into a safe workflow identifier segment.
 *
 * @param value Raw text that may contain unsupported id characters.
 * @returns Identifier-safe string for workflow ids.
 */
function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]+/g, '_');
}

/**
 * Infers whether a Flutter widget should be treated as a screen or a reusable component.
 *
 * @param relativePath Workspace-relative Dart file path.
 * @param widgetName Parsed widget class name.
 * @returns `screen` for route-facing widgets, otherwise `component`.
 */
function inferFlutterWidgetNodeType(relativePath: string, widgetName: string): WorkflowWidgetFact['widgetNodeType'] {
  const lowerPath = relativePath.toLowerCase();
  if (/screens?|pages?|views?/.test(lowerPath) || /(Page|Screen|View)$/.test(widgetName)) {
    return 'screen';
  }
  return 'component';
}

/**
 * Finds the closing brace for a Dart class body.
 *
 * @param content Full Dart source content.
 * @param openIndex Index of the opening class brace.
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
 * Extracts local child widget constructor calls from a Dart widget class body.
 *
 * @param classBody Full Dart class body text.
 * @returns Sorted widget names rendered by the class.
 */
function extractRenderedFlutterWidgets(classBody: string): readonly string[] {
  const widgets = new Set<string>();
  const widgetPattern = /\b([A-Z][A-Za-z0-9_]*)\s*\(/g;
  for (const match of classBody.matchAll(widgetPattern)) {
    const widgetName = match[1];
    if (!widgetName || FLUTTER_BUILTIN_WIDGETS.has(widgetName)) {
      continue;
    }
    widgets.add(widgetName);
  }
  return Object.freeze([...widgets.values()].sort((a, b) => a.localeCompare(b)));
}

/**
 * Extracts named route navigations from a Dart widget class body.
 *
 * @param classBody Full Dart class body text.
 * @returns Sorted named routes referenced by the class.
 */
function extractFlutterNavigatedRoutes(classBody: string): readonly string[] {
  const routes = new Set<string>();
  const routePattern = /\bNavigator\.(?:pushNamed|pushReplacementNamed|popAndPushNamed)\s*\([^,]+,\s*["'`]([^"'`]+)["'`]/g;
  for (const match of classBody.matchAll(routePattern)) {
    const routeName = match[1];
    if (routeName) {
      routes.add(routeName);
    }
  }
  return Object.freeze([...routes.values()].sort((a, b) => a.localeCompare(b)));
}

/**
 * Parses Flutter widget classes from a Dart source file.
 *
 * @param relativePath Workspace-relative Dart file path.
 * @param content Full Dart source content.
 * @param sourceHash Stable source hash for invalidation.
 * @returns Frozen widget facts extracted from the file.
 */
function parseFlutterWidgetFacts(relativePath: string, content: string, sourceHash: string): readonly WorkflowWidgetFact[] {
  const facts: WorkflowWidgetFact[] = [];
  const classPattern = /class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:StatefulWidget|StatelessWidget)/g;

  for (const match of content.matchAll(classPattern)) {
    const widgetName = match[1];
    const classStart = match.index ?? -1;
    const openBraceIndex = content.indexOf('{', classStart);
    const closeBraceIndex = openBraceIndex >= 0 ? findMatchingBrace(content, openBraceIndex) : -1;
    const classBody = openBraceIndex >= 0 && closeBraceIndex > openBraceIndex ? content.slice(openBraceIndex + 1, closeBraceIndex) : '';
    if (!widgetName) {
      continue;
    }

    facts.push(Object.freeze({
      relativePath,
      sourceHash,
      widgetName,
      widgetNodeId: `workflow:flutter:${relativePath}:${sanitizeIdentifier(widgetName)}`,
      widgetNodeType: inferFlutterWidgetNodeType(relativePath, widgetName),
      renderedWidgets: extractRenderedFlutterWidgets(classBody).filter((childName) => childName !== widgetName),
      navigatedRoutes: extractFlutterNavigatedRoutes(classBody),
    }));
  }

  return Object.freeze(facts);
}

/**
 * Creates a workflow node for a Flutter widget.
 *
 * @param fact Parsed Flutter widget fact.
 * @returns Frozen workflow node record.
 */
function createFlutterWidgetNode(fact: WorkflowWidgetFact): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: fact.widgetNodeId,
    nodeType: fact.widgetNodeType,
    label: fact.widgetName,
    filePath: fact.relativePath,
    symbolName: fact.widgetName,
    description: `${fact.widgetNodeType} ${fact.widgetName}`,
    descriptionSource: 'flutter_dart',
    confidence: 0.84,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'flutter_widget',
    }),
    sourceHash: fact.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a workflow node for a named Flutter route.
 *
 * @param routePath Named route string referenced by Navigator.
 * @param fact Parsed Flutter widget fact that owns the navigation.
 * @returns Frozen workflow node record.
 */
function createFlutterRouteNode(routePath: string, fact: WorkflowWidgetFact): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:flutter-route:${sanitizeIdentifier(routePath)}`,
    nodeType: 'screen',
    label: routePath,
    filePath: fact.relativePath,
    routePath,
    description: `Flutter named route ${routePath}`,
    descriptionSource: 'flutter_dart',
    confidence: 0.78,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'flutter_named_route',
    }),
    sourceHash: fact.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a workflow edge record for Flutter widget relations.
 *
 * @param opts Edge creation options shared across framework adapters.
 * @returns Frozen workflow edge record.
 */
function createFlutterEdge(opts: WorkflowFrameworkEdgeOptions): WorkflowEdgeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:edge:${sanitizeIdentifier(`${opts.fromNodeId}:${opts.edgeType}:${opts.toNodeId}:${opts.label}`)}`,
    fromNodeId: opts.fromNodeId,
    toNodeId: opts.toNodeId,
    edgeType: opts.edgeType,
    label: opts.label,
    confidence: opts.confidence,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: opts.provenanceKind,
    }),
    supportingFilePath: opts.relativePath,
    sourceHash: opts.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Extracts Flutter widget composition and named-route navigation graphs from `.dart` files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from Flutter Dart files.
 */
async function extractFlutterDartWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const dartFiles = scanWorkspaceSourceFilesBySuffixes(workspacePath, ['.dart']);
  if (dartFiles.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const facts = dartFiles.flatMap((relativePath) => {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    return parseFlutterWidgetFacts(relativePath, content, createSourceHash(relativePath, content));
  });

  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();
  const widgetNodeIdByName = new Map<string, string>();

  facts.forEach((fact) => {
    const node = createFlutterWidgetNode(fact);
    nodes.set(node.id, node);
    widgetNodeIdByName.set(fact.widgetName, node.id);
  });

  facts.forEach((fact) => {
    fact.renderedWidgets.forEach((widgetName) => {
      const targetNodeId = widgetNodeIdByName.get(widgetName);
      if (!targetNodeId || targetNodeId === fact.widgetNodeId) {
        return;
      }
      edges.set(
        `renders:${fact.widgetNodeId}:${targetNodeId}:${widgetName}`,
        createFlutterEdge({
          fromNodeId: fact.widgetNodeId,
          toNodeId: targetNodeId,
          edgeType: 'renders',
          label: widgetName,
          relativePath: fact.relativePath,
          sourceHash: fact.sourceHash,
          provenanceKind: 'flutter_widget_composition',
          confidence: 0.8,
        }),
      );
    });

    fact.navigatedRoutes.forEach((routePath) => {
      const routeNode = createFlutterRouteNode(routePath, fact);
      nodes.set(routeNode.id, routeNode);
      edges.set(
        `nav:${fact.widgetNodeId}:${routeNode.id}:${routePath}`,
        createFlutterEdge({
          fromNodeId: fact.widgetNodeId,
          toNodeId: routeNode.id,
          edgeType: 'navigates_to',
          label: routePath,
          relativePath: fact.relativePath,
          sourceHash: fact.sourceHash,
          provenanceKind: 'flutter_named_navigation',
          confidence: 0.78,
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
 * Framework adapter for Flutter widget composition and named navigation extraction.
 */
export const flutterDartWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'flutter-dart',
  label: 'Flutter / Dart',
  extract: extractFlutterDartWorkflowGraph,
});
