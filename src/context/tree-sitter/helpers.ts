/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Shared helper functions for Tree-sitter based extraction.
 */

import Parser from 'web-tree-sitter';
import type { SyntaxSymbolKind, SyntaxSymbolRecord } from '../entities/syntax-index';
import type { ParsedImportEntry, TreeSitterCodeUnit } from '../entities/tree-sitter';

/**
 * Returns the exact source text covered by one syntax node.
 */
export function getNodeText(node: Parser.SyntaxNode | null, content: string): string {
  if (!node) {
    return '';
  }
  return content.slice(node.startIndex, node.endIndex);
}

/**
 * Converts a Tree-sitter node position to a one-based source line number.
 */
export function getLineNumber(node: Parser.SyntaxNode): number {
  return node.startPosition.row + 1;
}

/**
 * Creates one normalized syntax symbol record for syntax indexing.
 */
export function createSymbolRecord(
  name: string,
  kind: SyntaxSymbolKind,
  exported: boolean,
  line: number,
  signature: string,
): SyntaxSymbolRecord {
  return Object.freeze({
    name,
    kind,
    exported,
    line,
    signature: signature.trim().replace(/\s+/g, ' ').slice(0, 240),
  });
}

/**
 * Creates one code chunk unit for semantic retrieval.
 */
export function createCodeUnit(
  node: Parser.SyntaxNode,
  content: string,
  name: string,
  kind: SyntaxSymbolKind,
  exported: boolean,
): TreeSitterCodeUnit {
  return Object.freeze({
    name,
    kind,
    exported,
    signature: getNodeText(node, content).trim().replace(/\s+/g, ' ').slice(0, 240),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  });
}

/**
 * Adds one import specifier while preventing empty and duplicate entries.
 */
export function pushImport(entries: ParsedImportEntry[], specifier: string, line: number): void {
  const normalized = specifier.trim();
  if (!normalized) {
    return;
  }
  if (entries.some((entry) => entry.specifier === normalized)) {
    return;
  }
  entries.push(Object.freeze({ specifier: normalized, line }));
}
