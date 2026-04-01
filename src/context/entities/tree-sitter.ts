/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for Tree-sitter syntax extraction.
 */

import type { SyntaxResolvedImportRecord, SyntaxSymbolKind, SyntaxSymbolRecord } from './syntax-index';

/** Supported Tree-sitter language identifiers used by the parser layer. */
export type TreeSitterLanguageId = 'python' | 'go' | 'rust' | 'java';

export type TreeSitterCodeUnit = Readonly<{
  /** Extracted symbol or code-unit name. */
  name: string;
  /** Normalized kind of the extracted symbol. */
  kind: SyntaxSymbolKind;
  /** Whether the code unit is exported/publicly reachable. */
  exported: boolean;
  /** Readable signature string used in retrieval. */
  signature: string;
  /** One-based start line of the code unit. */
  startLine: number;
  /** One-based end line of the code unit. */
  endLine: number;
  /** Zero-based start byte/index in the source text. */
  startIndex: number;
  /** Zero-based end byte/index in the source text. */
  endIndex: number;
}>;

export type ParsedImportEntry = Readonly<{
  /** Raw import specifier text as written in source. */
  specifier: string;
  /** One-based line where the import appears. */
  line: number;
}>;

export type ParsedSyntaxData = Readonly<{
  /** Normalized language label for the parsed file. */
  language: string;
  /** Raw import specifiers collected from the file. */
  imports: readonly string[];
  /** Resolved workspace-relative import targets. */
  resolvedImports: readonly string[];
  /** Resolved import records with line and binding details. */
  resolvedImportRecords: readonly SyntaxResolvedImportRecord[];
  /** Exported names collected from the file. */
  exports: readonly string[];
  /** Symbol records extracted from the file. */
  symbols: readonly SyntaxSymbolRecord[];
}>;
