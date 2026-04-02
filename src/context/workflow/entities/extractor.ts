/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow extractor-specific entities with field-level documentation.
 */

import * as ts from 'typescript';
import type { WorkflowEdgeRecord, WorkflowGraphSnapshot, WorkflowNodeRecord } from './graph';

/**
 * Parsed tsconfig options used when resolving imports.
 */
export type TypeScriptProjectConfig = Readonly<{
  /** Effective compiler options for module resolution. */
  options: ts.CompilerOptions;
}>;

/**
 * A normalized import binding pointing from a local name to a target file and exported name.
 */
export type ImportBinding = Readonly<{
  /** Locally referenced identifier. */
  localName: string;
  /** Imported binding name or '*' / 'default'. */
  importedName: string;
  /** Workspace-relative target file path. */
  targetFile: string;
}>;

/**
 * Internal executable symbol unit used while building workflow graphs.
 */
export type SymbolUnit = Readonly<{
  /** Stable unit id. */
  id: string;
  /** Workspace-relative file path. */
  relativePath: string;
  /** Local symbol name when available. */
  localName?: string;
  /** Whether the symbol is exported. */
  exported: boolean;
  /** Workflow-oriented node classification. */
  nodeType: string;
  /** Display label for the symbol unit. */
  label: string;
  /** Public symbol name when available. */
  symbolName?: string;
  /** 1-based start line. */
  startLine: number;
  /** 1-based end line. */
  endLine: number;
  /** Short description for retrieval. */
  description?: string;
  /** Source of the description text. */
  descriptionSource?: string;
  /** Extraction confidence score. */
  confidence: number;
  /** Source hash for invalidation. */
  sourceHash: string;
  /** Creation timestamp. */
  createdAt: number;
  /** Update timestamp. */
  updatedAt: number;
  /** Executable AST bodies used for deeper traversal. */
  callableNodes: readonly ts.Node[];
}>;

/**
 * Parsed source file prepared for workflow extraction.
 */
export type ParsedFile = Readonly<{
  /** Workspace-relative file path. */
  relativePath: string;
  /** Absolute source file path. */
  absolutePath: string;
  /** Parsed TypeScript source file. */
  sourceFile: ts.SourceFile;
  /** File modification time in milliseconds. */
  mtimeMs: number;
  /** Stable source hash. */
  sourceHash: string;
  /** Extracted top-level units. */
  units: readonly SymbolUnit[];
  /** Map of local symbol names to workflow unit ids. */
  localSymbolIds: ReadonlyMap<string, string>;
  /** Import bindings resolved from this file. */
  importBindings: ReadonlyMap<string, ImportBinding>;
}>;

/**
 * Scheduling options for background workflow graph refresh.
 */
export type WorkflowRefreshScheduleOptions = Readonly<{
  /** Debounce delay in milliseconds. */
  delayMs?: number;
  /** Optional human-readable scheduling reason. */
  reason?: string;
  /** File paths that triggered the refresh request. */
  filePaths?: readonly string[];
  /** Forces refresh even if file paths are not considered workflow-relevant. */
  force?: boolean;
}>;

/**
 * Mutable in-memory scheduler state for a workspace refresh loop.
 */
export type WorkflowRefreshState = {
  /** Pending debounce timer if one is active. */
  timer: ReturnType<typeof setTimeout> | null;
  /** In-flight refresh promise if one is active. */
  inFlight: Promise<WorkflowGraphSnapshot | null> | null;
  /** Indicates another refresh should run after the current one completes. */
  rerunRequested: boolean;
};

/**
 * Shared graph contribution returned by a workflow extractor adapter before artifact synthesis.
 */
export type WorkflowGraphContribution = Readonly<{
  /** Nodes discovered by the adapter for the current workspace. */
  nodes: readonly WorkflowNodeRecord[];
  /** Edges discovered by the adapter for the current workspace. */
  edges: readonly WorkflowEdgeRecord[];
}>;

/**
 * Contract implemented by language or framework-specific workflow extraction adapters.
 */
export type WorkflowExtractorAdapter = Readonly<{
  /** Stable adapter identifier for telemetry and debugging. */
  id: string;
  /** Human-readable adapter label. */
  label: string;
  /** Extracts workflow graph contributions for a workspace. */
  extract: (workspacePath: string) => Promise<WorkflowGraphContribution>;
}>;

/**
 * Shared parsed TypeScript workflow context reused by multiple adapters before graph synthesis.
 */
export type TypeScriptWorkflowExtractionContext = Readonly<{
  /** Parsed files participating in extraction. */
  parsedFiles: readonly ParsedFile[];
  /** Seed nodes built directly from parsed symbol units. */
  baseNodes: ReadonlyMap<string, WorkflowNodeRecord>;
  /** Exported symbol lookup used for cross-file edge resolution. */
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>;
}>;

/**
 * Shared symbol-resolution lookup reused while traversing executable units.
 */
export type WorkflowSymbolResolutionContext = Readonly<{
  /** Exported symbol lookup used for cross-file edge resolution. */
  exportedSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>;
}>;

/**
 * Mutable graph collections updated while extracting executable edges.
 */
export type WorkflowExecutionGraphState = Readonly<{
  /** Mutable workflow nodes indexed by id. */
  nodes: Map<string, WorkflowNodeRecord>;
  /** Mutable workflow edges indexed by id. */
  edges: Map<string, WorkflowEdgeRecord>;
}>;

/**
 * Input used to build a workflow graph snapshot for a workspace.
 */
export type WorkflowGraphSnapshotBuildOptions = Readonly<{
  /** Absolute workspace path whose source files should be extracted. */
  workspacePath: string;
}>;
