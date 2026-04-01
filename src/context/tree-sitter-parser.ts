/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Public Tree-sitter parser facade for syntax indexing and semantic chunk extraction.
 */

import type { SyntaxFileRecord } from './entities/syntax-index';
import type { TreeSitterCodeUnit } from './entities/tree-sitter';
import { extractTreeSitterCodeUnitsFromRoot } from './tree-sitter/code-unit-extractors';
import { getTreeSitterLanguageId, withParsedTree } from './tree-sitter/runtime';
import { extractSyntaxData } from './tree-sitter/syntax-extractors';

/**
 * Extracts semantic code units for one supported non-TypeScript source file.
 */
export async function extractTreeSitterCodeUnits(opts: {
  relativePath: string;
  content: string;
}): Promise<readonly TreeSitterCodeUnit[]> {
  const languageId = getTreeSitterLanguageId(opts.relativePath);
  if (!languageId) {
    return Object.freeze([]);
  }

  return (
    (await withParsedTree(languageId, opts.content, (rootNode) =>
      extractTreeSitterCodeUnitsFromRoot(languageId, opts.content, rootNode),
    )) ?? Object.freeze([])
  );
}

/**
 * Parses one supported source file into a syntax index record.
 */
export async function parseTreeSitterSourceFile(opts: {
  relativePath: string;
  content: string;
  mtimeMs: number;
}): Promise<SyntaxFileRecord | null> {
  const languageId = getTreeSitterLanguageId(opts.relativePath);
  if (!languageId) {
    return null;
  }

  const parsed = await withParsedTree(languageId, opts.content, (rootNode) =>
    extractSyntaxData(languageId, opts.content, rootNode),
  );
  if (!parsed) {
    return null;
  }

  return Object.freeze({
    relativePath: opts.relativePath,
    language: parsed.language,
    mtimeMs: opts.mtimeMs,
    imports: parsed.imports,
    resolvedImports: parsed.resolvedImports,
    resolvedImportRecords: parsed.resolvedImportRecords,
    exports: parsed.exports,
    symbols: parsed.symbols,
    indexedAt: Date.now(),
  });
}
