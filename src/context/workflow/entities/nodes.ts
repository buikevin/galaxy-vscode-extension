/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Shared workflow node-construction option shapes used by static extractor helpers.
 */

import type * as ts from 'typescript';
import type { ParsedFile } from './extractor';

/**
 * Shared options for creating a route node from a TypeScript AST registration.
 */
export type WorkflowRouteNodeOptions = Readonly<{
  /** Workspace-relative file path that owns the route registration. */
  relativePath: string;
  /** Uppercase HTTP method inferred for the route. */
  method: string;
  /** Normalized absolute route path. */
  routePath: string;
  /** Parsed TypeScript source file containing the registration node. */
  sourceFile: ts.SourceFile;
  /** AST node used to derive source line numbers. */
  node: ts.Node;
  /** Stable source hash associated with the file. */
  sourceHash: string;
}>;

/**
 * Shared options for creating a synthetic database-query node.
 */
export type WorkflowDbQueryNodeOptions = Readonly<{
  /** Receiver expression text such as `prisma.user`. */
  receiverText: string;
  /** Query method name such as `findMany` or `save`. */
  methodName: string;
  /** Optional literal query text associated with the call. */
  queryText?: string | null;
  /** Stable source hash associated with the supporting file. */
  sourceHash: string;
}>;

/**
 * Shared options for creating a synthetic inline handler unit.
 */
export type WorkflowSyntheticHandlerUnitOptions = Readonly<{
  /** Parsed file that owns the inline callback body. */
  parsedFile: ParsedFile;
  /** AST node for the inline callable body. */
  callableNode: ts.Node;
  /** Workflow node type inferred for the inline handler. */
  nodeType: string;
  /** Display label for the synthetic unit. */
  label: string;
  /** Description recorded for retrieval/debugging. */
  description: string;
}>;

/**
 * Shared options for creating a workflow edge from AST traversal.
 */
export type WorkflowEdgeOptions = Readonly<{
  /** Source node id for the edge. */
  fromNodeId: string;
  /** Target node id for the edge. */
  toNodeId: string;
  /** Edge type emitted into the workflow graph. */
  edgeType: string;
  /** Optional human-readable label for the edge. */
  label?: string | undefined;
  /** Workspace-relative supporting file path. */
  filePath: string;
  /** Optional supporting symbol name associated with the edge. */
  symbolName?: string | undefined;
  /** 1-based supporting line number in the source file. */
  line: number;
  /** Stable source hash associated with the supporting file. */
  sourceHash: string;
  /** Confidence score attached to the edge. */
  confidence: number;
  /** Provenance kind recorded for diagnostics. */
  provenanceKind: string;
}>;
