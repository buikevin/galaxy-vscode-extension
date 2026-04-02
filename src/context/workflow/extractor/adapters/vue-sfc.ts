/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Vue single-file component adapter that extracts component and screen composition edges from .vue templates.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import type { WorkflowVueSfcFact } from '../../entities/adapters';
import { createSourceHash, scanWorkspaceSourceFilesBySuffixes } from '../files';

/**
 * Normalizes arbitrary text into a safe workflow identifier segment.
 *
 * @param value Raw text that may contain unsupported id characters.
 * @returns Identifier-safe string for node and edge ids.
 */
function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]+/g, '_');
}

/**
 * Infers the workflow node type for a Vue file from its location and component name.
 *
 * @param relativePath Workspace-relative Vue file path.
 * @param componentName Resolved SFC component name.
 * @returns `screen` for route-facing views, otherwise `component`.
 */
function inferVueNodeType(relativePath: string, componentName: string): string {
  const lowerPath = relativePath.toLowerCase();
  if (/pages?|views?|screens?/.test(lowerPath) || /(Page|View|Screen)$/.test(componentName)) {
    return 'screen';
  }
  return 'component';
}

/**
 * Resolves the display component name for a Vue single-file component.
 *
 * @param relativePath Workspace-relative Vue file path.
 * @param content Full Vue SFC source content.
 * @returns Best-effort component name for graph nodes.
 */
function resolveVueComponentName(relativePath: string, content: string): string {
  const defineOptionsMatch = content.match(/defineOptions\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`]/);
  if (defineOptionsMatch?.[1]) {
    return defineOptionsMatch[1];
  }
  const exportNameMatch = content.match(/export\s+default\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`]/);
  if (exportNameMatch?.[1]) {
    return exportNameMatch[1];
  }
  const baseName = path.basename(relativePath, '.vue');
  return baseName.replace(/[^a-zA-Z0-9]+(.)/g, (_, ch: string) => ch.toUpperCase()).replace(/^[a-z]/, (ch) => ch.toUpperCase());
}

/**
 * Extracts default component imports from a Vue SFC script block.
 *
 * @param content Full Vue SFC source content.
 * @returns Mapping from local component identifiers to their import specifiers.
 */
function extractVueImports(content: string): ReadonlyMap<string, string> {
  const imports = new Map<string, string>();
  const defaultImportPattern = /import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+['"`]([^'"`]+)['"`]/g;
  for (const match of content.matchAll(defaultImportPattern)) {
    const localName = match[1];
    const specifier = match[2];
    if (localName && specifier) {
      imports.set(localName, specifier);
    }
  }
  return imports;
}

/**
 * Resolves an imported Vue component specifier to a workspace-relative `.vue` file.
 *
 * @param relativePath Workspace-relative source file that owns the import.
 * @param specifier Raw import specifier from the file.
 * @returns Workspace-relative Vue file path when the import points to an SFC.
 */
function resolveImportedVueTarget(relativePath: string, specifier: string): string | null {
  if (!specifier.endsWith('.vue')) {
    return null;
  }
  if (specifier.startsWith('@/')) {
    return `src/${specifier.slice(2)}`;
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));
  }
  return null;
}

/**
 * Creates a workflow node for a Vue screen or component.
 *
 * @param relativePath Workspace-relative Vue file path.
 * @param componentName Resolved component name.
 * @param sourceHash Stable hash for the source file.
 * @returns Frozen workflow node record.
 */
function createVueNode(relativePath: string, componentName: string, sourceHash: string): WorkflowNodeRecord {
  const createdAt = Date.now();
  const nodeType = inferVueNodeType(relativePath, componentName);
  return Object.freeze({
    id: `workflow:vue:${relativePath}:${sanitizeIdentifier(componentName)}`,
    nodeType,
    label: componentName,
    filePath: relativePath,
    symbolName: componentName,
    description: `${nodeType.replace(/_/g, ' ')} ${componentName}`,
    descriptionSource: 'vue_sfc',
    confidence: 0.82,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'vue_sfc_component',
    }),
    sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a `renders` edge between two Vue components discovered from template tags.
 *
 * @param fromNodeId Source workflow node id.
 * @param toNodeId Target workflow node id.
 * @param relativePath Supporting workspace-relative Vue file path.
 * @param componentTag Template component tag that produced the edge.
 * @param sourceHash Stable hash for the supporting file.
 * @returns Frozen workflow edge record.
 */
function createVueRenderEdge(
  fromNodeId: string,
  toNodeId: string,
  relativePath: string,
  componentTag: string,
  sourceHash: string,
): WorkflowEdgeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:edge:${sanitizeIdentifier(`${fromNodeId}:renders:${toNodeId}:${componentTag}`)}`,
    fromNodeId,
    toNodeId,
    edgeType: 'renders',
    label: componentTag,
    confidence: 0.76,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: 'vue_template_component_tag',
    }),
    supportingFilePath: relativePath,
    sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Extracts Vue single-file component nodes and template composition edges.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution built from Vue SFC files.
 */
async function extractVueSfcWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const vueFiles = scanWorkspaceSourceFilesBySuffixes(workspacePath, ['.vue']);
  if (vueFiles.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const fileMetadata = new Map<string, WorkflowVueSfcFact>();
  const nodes = new Map<string, WorkflowNodeRecord>();

  vueFiles.forEach((relativePath) => {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    const sourceHash = createSourceHash(relativePath, content);
    const componentName = resolveVueComponentName(relativePath, content);
    const imports = extractVueImports(content);
    fileMetadata.set(relativePath, Object.freeze({
      relativePath,
      componentName,
      sourceHash,
      imports,
      content,
    }));
    const node = createVueNode(relativePath, componentName, sourceHash);
    nodes.set(node.id, node);
  });

  const nodeIdByRelativePath = new Map<string, string>();
  fileMetadata.forEach((meta, relativePath) => {
    nodeIdByRelativePath.set(relativePath, `workflow:vue:${relativePath}:${sanitizeIdentifier(meta.componentName)}`);
  });

  const edges = new Map<string, WorkflowEdgeRecord>();
  const componentTagPattern = /<([A-Z][A-Za-z0-9_]*)\b/g;

  fileMetadata.forEach((meta, relativePath) => {
    const fromNodeId = nodeIdByRelativePath.get(relativePath);
    if (!fromNodeId) {
      return;
    }
    for (const match of meta.content.matchAll(componentTagPattern)) {
      const componentTag = match[1];
      if (!componentTag) {
        continue;
      }
      const specifier = meta.imports.get(componentTag);
      if (!specifier) {
        continue;
      }
      const targetRelativePath = resolveImportedVueTarget(relativePath, specifier);
      if (!targetRelativePath) {
        continue;
      }
      const toNodeId = nodeIdByRelativePath.get(targetRelativePath);
      if (!toNodeId || toNodeId === fromNodeId) {
        continue;
      }
      const edge = createVueRenderEdge(fromNodeId, toNodeId, relativePath, componentTag, meta.sourceHash);
      edges.set(edge.id, edge);
    }
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for Vue single-file component composition extraction.
 */
export const vueSfcWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'vue-sfc',
  label: 'Vue SFC',
  extract: extractVueSfcWorkflowGraph,
});
