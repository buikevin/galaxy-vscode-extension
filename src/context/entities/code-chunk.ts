/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for extracted code chunk units.
 */

import type { SyntaxSymbolKind } from './syntax-index';

/**
 * Describes one AST-backed unit that can be chunked and embedded independently.
 */
export type CodeChunkUnit = Readonly<{
  /**
   * Stable symbol name used in semantic and workflow retrieval.
   */
  name: string;
  /**
   * High-level symbol category inferred from syntax analysis.
   */
  kind: SyntaxSymbolKind;
  /**
   * Indicates whether the symbol is exported from the module.
   */
  exported: boolean;
  /**
   * Human-readable signature shown in retrieval context.
   */
  signature: string;
  /**
   * One-based starting line of the symbol range.
   */
  startLine: number;
  /**
   * One-based ending line of the symbol range.
   */
  endLine: number;
  /**
   * Zero-based starting character offset in the source file.
   */
  startIndex: number;
  /**
   * Zero-based ending character offset in the source file.
   */
  endIndex: number;
}>;
