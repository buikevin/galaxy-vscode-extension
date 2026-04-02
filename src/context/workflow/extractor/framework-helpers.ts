/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Shared workflow extractor helpers reused by multiple framework adapters.
 */

import type { WorkflowEndpointNodeOptions, WorkflowFrameworkEdgeOptions } from '../entities/adapters';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../entities/graph';

/**
 * Normalizes arbitrary text into a safe workflow identifier segment.
 *
 * @param value Raw text that may contain unsupported id characters.
 * @returns Identifier-safe string for workflow ids.
 */
export function sanitizeFrameworkIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]+/g, '_');
}

/**
 * Normalizes a route fragment to an absolute-style path.
 *
 * @param routePath Raw route fragment extracted from framework metadata.
 * @returns Normalized absolute-style route path.
 */
export function normalizeFrameworkRoutePath(routePath: string | null | undefined): string {
  const trimmed = (routePath ?? '').trim();
  if (!trimmed) {
    return '/';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Merges an optional base route prefix with a child route fragment.
 *
 * @param basePath Optional controller- or router-level route prefix.
 * @param routePath Optional method-level route fragment.
 * @returns Combined normalized route path.
 */
export function joinFrameworkRoutePath(basePath: string | undefined, routePath: string | undefined): string {
  const base = normalizeFrameworkRoutePath(basePath).replace(/\/+$/, '');
  const child = normalizeFrameworkRoutePath(routePath);
  if (base === '/' && child === '/') {
    return '/';
  }
  if (base === '/') {
    return child;
  }
  if (child === '/') {
    return base;
  }
  return `${base}${child}`;
}

/**
 * Creates a framework-derived API endpoint node with shared metadata shape.
 *
 * @param opts Shared endpoint-node creation options.
 * @returns Frozen workflow node record for the endpoint.
 */
export function createFrameworkEndpointNode(opts: WorkflowEndpointNodeOptions): WorkflowNodeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: opts.id,
    nodeType: 'api_endpoint',
    label: opts.label,
    filePath: opts.relativePath,
    symbolName: opts.symbolName,
    routeMethod: opts.httpMethod,
    routePath: opts.routePath,
    description: opts.description,
    descriptionSource: opts.descriptionSource,
    confidence: opts.confidence,
    provenance: Object.freeze({
      source: 'framework_heuristic',
      kind: opts.provenanceKind,
    }),
    sourceHash: opts.sourceHash,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Creates a framework-derived workflow edge with shared provenance shape.
 *
 * @param opts Shared edge creation options.
 * @returns Frozen workflow edge record.
 */
export function createFrameworkEdge(opts: WorkflowFrameworkEdgeOptions): WorkflowEdgeRecord {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:edge:${sanitizeFrameworkIdentifier(`${opts.fromNodeId}:${opts.edgeType}:${opts.toNodeId}:${opts.label}`)}`,
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
