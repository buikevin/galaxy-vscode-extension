/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Shared path and text helpers for syntax-aware indexing.
 */

import path from 'node:path';
import type {
  ManualReadPlanStep,
  SyntaxContextRecordSummary,
  SyntaxFileRecord,
  SyntaxIndexStore,
  SyntaxSymbolCandidate,
} from '../entities/syntax-index';
import { estimateTokens } from '../compaction';
import { IGNORED_SEGMENTS, MAX_EXPORTS_PER_FILE, MAX_FOCUS_SYMBOLS, MAX_IMPORTS_PER_FILE, MAX_RELATED_CONTEXT_FILES, MAX_SYMBOLS_PER_FILE, MAX_SYMBOL_CANDIDATES, MAX_CONTEXT_FILES, MAX_PRIMARY_CONTEXT_FILES, PREFERRED_DIR_NAMES, SUPPORTED_SOURCE_SUFFIXES, SYNTAX_INDEX_VERSION } from './constants';

/**
 * Creates an empty syntax-index store snapshot.
 */
export function createEmptyStore(workspacePath: string): SyntaxIndexStore {
  return Object.freeze({
    version: SYNTAX_INDEX_VERSION,
    workspacePath,
    updatedAt: 0,
    files: Object.freeze({}),
  });
}

/**
 * Normalizes path separators to forward slashes.
 */
export function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/**
 * Resolves a path relative to the workspace and rejects ignored segments.
 */
export function resolveWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
  const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspacePath, filePath);
  const relativePath = path.relative(workspacePath, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split('/');
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return null;
  }
  return normalized;
}

/**
 * Checks whether a file path is supported by the syntax index.
 */
export function isSupportedSourceFile(relativePath: string): boolean {
  return SUPPORTED_SOURCE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/**
 * Sorts directory names so preferred source directories are scanned first.
 */
export function compareDirNames(a: string, b: string): number {
  const preferredA = PREFERRED_DIR_NAMES.indexOf(a);
  const preferredB = PREFERRED_DIR_NAMES.indexOf(b);
  if (preferredA >= 0 || preferredB >= 0) {
    if (preferredA < 0) {
      return 1;
    }
    if (preferredB < 0) {
      return -1;
    }
    return preferredA - preferredB;
  }
  return a.localeCompare(b);
}

/**
 * Adds a symbol name to a list only once.
 */
export function addUniqueSymbolName(target: string[], value: string): void {
  if (value && !target.includes(value)) {
    target.push(value);
  }
}

/**
 * Extracts likely identifier tokens from a user query.
 */
export function extractQueryIdentifiers(text: string): readonly string[] {
  const matches = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? [];
  return Object.freeze([...new Set(matches)].slice(0, 24));
}

/**
 * Renders one syntax file summary for the prompt block.
 */
export function formatRecord(opts: {
  record: SyntaxFileRecord;
  referencePaths: readonly string[];
  focusSymbols: readonly string[];
}): readonly string[] {
  const { record, referencePaths, focusSymbols } = opts;
  const lines: string[] = [`File: ${record.relativePath}`];
  if (record.exports.length > 0) {
    lines.push(`Exports: ${record.exports.join(', ')}`);
  }
  if (record.imports.length > 0) {
    lines.push(`Imports: ${record.imports.join(', ')}`);
  }
  if (record.resolvedImports.length > 0) {
    lines.push(`Related: ${record.resolvedImports.join(', ')}`);
    lines.push(`Definitions: ${record.resolvedImports.slice(0, MAX_RELATED_CONTEXT_FILES).join(', ')}`);
  }
  if (referencePaths.length > 0) {
    lines.push(`Referenced by: ${referencePaths.slice(0, MAX_RELATED_CONTEXT_FILES).join(', ')}`);
  }
  if (record.symbols.length > 0) {
    lines.push('Skeleton:');
    record.symbols.slice(0, MAX_SYMBOLS_PER_FILE).forEach((symbol) => {
      const highlighted = focusSymbols.includes(symbol.name) ? ' [focus]' : '';
      lines.push(`- ${symbol.signature}${highlighted}`);
    });
  }
  return Object.freeze(lines);
}

/**
 * Builds the final empty syntax context payload.
 */
export function createEmptySyntaxContext(): import('../entities/syntax-index').SyntaxIndexContext {
  return Object.freeze({
    content: '',
    tokens: 0,
    entryCount: 0,
    records: Object.freeze([]),
    primaryPaths: Object.freeze([]),
    definitionPaths: Object.freeze([]),
    referencePaths: Object.freeze([]),
    priorityPaths: Object.freeze([]),
    focusSymbols: Object.freeze([]),
    primarySymbolCandidates: Object.freeze([]),
    definitionSymbolCandidates: Object.freeze([]),
    referenceSymbolCandidates: Object.freeze([]),
    manualReadPlan: Object.freeze([]),
  });
}
