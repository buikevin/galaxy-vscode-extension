/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions used by syntax-aware indexing and retrieval.
 */

/**
 * Supported syntax symbol kinds emitted by the syntax index.
 */
export type SyntaxSymbolKind =
  | 'function'
  | 'component'
  | 'hook'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'variable';

/**
 * One symbol extracted from a source file.
 */
export type SyntaxSymbolRecord = Readonly<{
  /** Symbol name in source code. */
  name: string;
  /** Normalized symbol kind. */
  kind: SyntaxSymbolKind;
  /** Whether the symbol is exported from its file. */
  exported: boolean;
  /** 1-based source line where the symbol starts. */
  line: number;
  /** Human-readable signature text for the symbol. */
  signature: string;
}>;

/**
 * One imported binding entry extracted from a TypeScript/JavaScript file.
 */
export type SyntaxImportBindingRecord = Readonly<{
  /** Local binding name used in the importing file. */
  localName: string;
  /** Export name imported from the target module. */
  importedName: string;
  /** 1-based import line number. */
  line: number;
  /** Whether the binding is type-only. */
  typeOnly: boolean;
}>;

/**
 * One import record resolved to another file in the workspace.
 */
export type SyntaxResolvedImportRecord = Readonly<{
  /** Import specifier text as written in code. */
  specifier: string;
  /** Resolved workspace-relative target path. */
  relativePath: string;
  /** 1-based import line number. */
  line: number;
  /** Imported bindings resolved for the specifier. */
  bindings: readonly SyntaxImportBindingRecord[];
}>;

/**
 * Candidate symbol surfaced for prompt guidance.
 */
export type SyntaxSymbolCandidate = Readonly<{
  /** How this candidate relates to the current query. */
  relation: 'primary' | 'definition' | 'reference';
  /** Candidate symbol name. */
  symbolName: string;
  /** File that contains or references the symbol. */
  filePath: string;
  /** Optional related line number. */
  line?: number;
  /** Short retrieval-friendly description. */
  description: string;
}>;

/**
 * Suggested targeted read step derived from syntax relationships.
 */
export type ManualReadPlanStep = Readonly<{
  /** Tool recommended for the targeted follow-up read. */
  tool: 'read_file' | 'grep';
  /** File path the tool should inspect. */
  targetPath: string;
  /** Optional symbol name to focus on. */
  symbolName?: string;
  /** Optional line hint. */
  line?: number;
  /** Optional grep pattern for symbol lookup. */
  pattern?: string;
  /** Reason the step is recommended. */
  reason: string;
}>;

/**
 * Full indexed record for one source file.
 */
export type SyntaxFileRecord = Readonly<{
  /** Workspace-relative file path. */
  relativePath: string;
  /** Normalized language identifier. */
  language: string;
  /** Source file modification time in milliseconds. */
  mtimeMs: number;
  /** Raw import specifiers from the file. */
  imports: readonly string[];
  /** Resolved imported file paths inside the workspace. */
  resolvedImports: readonly string[];
  /** Rich resolved import metadata. */
  resolvedImportRecords: readonly SyntaxResolvedImportRecord[];
  /** Raw exported symbol names from the file. */
  exports: readonly string[];
  /** Extracted file symbols. */
  symbols: readonly SyntaxSymbolRecord[];
  /** Indexing timestamp in milliseconds. */
  indexedAt: number;
}>;

/**
 * Compact syntax record summary injected into prompt context.
 */
export type SyntaxContextRecordSummary = Readonly<{
  /** Workspace-relative file path. */
  relativePath: string;
  /** Exported names. */
  exports: readonly string[];
  /** Raw import specifiers. */
  imports: readonly string[];
  /** Resolved imported file paths. */
  resolvedImports: readonly string[];
  /** Extracted file symbols. */
  symbols: readonly SyntaxSymbolRecord[];
}>;

/**
 * On-disk syntax index snapshot for one workspace.
 */
export type SyntaxIndexStore = Readonly<{
  /** Storage schema version. */
  version: number;
  /** Absolute workspace path. */
  workspacePath: string;
  /** Last update timestamp. */
  updatedAt: number;
  /** Indexed file map keyed by relative path. */
  files: Readonly<Record<string, SyntaxFileRecord>>;
}>;

/**
 * Final syntax context injected into the prompt builder.
 */
export type SyntaxIndexContext = Readonly<{
  /** Rendered prompt block. */
  content: string;
  /** Token estimate for the prompt block. */
  tokens: number;
  /** Number of syntax records included. */
  entryCount: number;
  /** Compact record summaries for downstream retrieval. */
  records: readonly SyntaxContextRecordSummary[];
  /** Highest-priority primary file paths. */
  primaryPaths: readonly string[];
  /** Related definition file paths. */
  definitionPaths: readonly string[];
  /** Related reference file paths. */
  referencePaths: readonly string[];
  /** Ordered priority file paths derived from all syntax signals. */
  priorityPaths: readonly string[];
  /** Focus symbol names inferred from the query. */
  focusSymbols: readonly string[];
  /** Candidate primary symbols. */
  primarySymbolCandidates: readonly SyntaxSymbolCandidate[];
  /** Candidate definition symbols. */
  definitionSymbolCandidates: readonly SyntaxSymbolCandidate[];
  /** Candidate reference symbols. */
  referenceSymbolCandidates: readonly SyntaxSymbolCandidate[];
  /** Suggested targeted follow-up read plan. */
  manualReadPlan: readonly ManualReadPlanStep[];
}>;
