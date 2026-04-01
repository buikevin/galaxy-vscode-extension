/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Shared lexical and path helpers for semantic indexing.
 */

import path from 'node:path';
import type { SemanticChunkKind, SemanticChunkRecord } from '../entities/semantic-index';
import type { SyntaxContextRecordSummary, SyntaxSymbolRecord } from '../entities/syntax-index';
import {
  IGNORED_SEGMENTS,
  MAX_TERMS_PER_CHUNK,
  PREFERRED_DIR_NAMES,
  SEMANTIC_INDEX_VERSION,
  STOP_WORDS,
  MAX_EXCERPT_CHARS,
} from './constants';

/**
 * Creates an empty semantic index store object for a workspace.
 */
export function createEmptyStore(workspacePath: string): import('../entities/semantic-index').SemanticIndexStore {
  return Object.freeze({
    version: SEMANTIC_INDEX_VERSION,
    workspacePath,
    updatedAt: 0,
    chunks: Object.freeze({}),
  });
}

/**
 * Normalizes a relative path to forward-slash form.
 */
export function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/**
 * Resolves and validates a file path relative to the workspace.
 */
export function resolveWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
  const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspacePath, filePath);
  const relativePath = path.relative(workspacePath, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return null;
  }
  return normalized;
}

/**
 * Sorts directory names so preferred locations are scanned first.
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
 * Normalizes whitespace to one-line retrieval-friendly text.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Tokenizes text for lexical vector scoring.
 */
export function tokenize(text: string): readonly string[] {
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ')
    .toLowerCase();
  return Object.freeze(
    normalized
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
  );
}

/**
 * Tokenizes a file path for lexical path matching.
 */
export function buildPathTokens(relativePath: string): readonly string[] {
  return Object.freeze(
    relativePath
      .toLowerCase()
      .split('/')
      .flatMap((segment) => segment.split(/[^a-z0-9_]+/))
      .filter((token) => token.length >= 2),
  );
}

/**
 * Builds a bounded lexical term vector from text.
 */
export function buildTermVector(text: string): Readonly<{ terms: Readonly<Record<string, number>>; magnitude: number }> {
  const counts = new Map<string, number>();
  tokenize(text).forEach((token) => {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  });

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TERMS_PER_CHUNK);
  const terms: Record<string, number> = {};
  let magnitude = 0;
  ranked.forEach(([token, count]) => {
    terms[token] = count;
    magnitude += count * count;
  });

  return Object.freeze({
    terms: Object.freeze(terms),
    magnitude: Math.sqrt(magnitude) || 1,
  });
}

/**
 * Computes cosine similarity between two lexical vectors.
 */
export function cosineSimilarity(
  queryTerms: Readonly<Record<string, number>>,
  queryMagnitude: number,
  chunkTerms: Readonly<Record<string, number>>,
  chunkMagnitude: number,
): number {
  let dot = 0;
  for (const [token, weight] of Object.entries(queryTerms)) {
    const chunkWeight = chunkTerms[token];
    if (typeof chunkWeight === 'number') {
      dot += weight * chunkWeight;
    }
  }
  if (dot === 0 || queryMagnitude === 0 || chunkMagnitude === 0) {
    return 0;
  }
  return dot / (queryMagnitude * chunkMagnitude);
}

/**
 * Creates a stable chunk identifier.
 */
export function makeChunkId(filePath: string, kind: SemanticChunkKind, title: string, startLine?: number): string {
  return `${filePath}#${kind}:${title}:${startLine ?? 0}`;
}

/**
 * Builds the Chroma collection name for semantic chunks.
 */
export function buildSemanticCollectionName(workspaceId: string): string {
  return `galaxy-semantic-chunks-v1-${workspaceId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
}

/**
 * Creates one semantic chunk from normalized inputs.
 */
export function createChunk(opts: {
  filePath: string;
  title: string;
  kind: SemanticChunkKind;
  excerpt: string;
  mtimeMs: number;
  symbol?: SyntaxSymbolRecord;
  startLine?: number;
  endLine?: number;
  description?: string;
  descriptionSource?: 'comment' | 'signature' | 'module_overview' | 'section_title';
}): SemanticChunkRecord {
  const vector = buildTermVector(`${opts.title}\n${opts.description ?? ''}\n${opts.excerpt}`);
  return Object.freeze({
    id: makeChunkId(opts.filePath, opts.kind, opts.title, opts.startLine),
    filePath: opts.filePath,
    title: opts.title,
    kind: opts.kind,
    ...(opts.symbol ? { symbolName: opts.symbol.name, symbolKind: opts.symbol.kind, exported: opts.symbol.exported } : {}),
    ...(typeof opts.startLine === 'number' ? { startLine: opts.startLine } : {}),
    ...(typeof opts.endLine === 'number' ? { endLine: opts.endLine } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.descriptionSource ? { descriptionSource: opts.descriptionSource } : {}),
    excerpt: opts.excerpt,
    terms: vector.terms,
    magnitude: vector.magnitude,
    mtimeMs: opts.mtimeMs,
    indexedAt: Date.now(),
  });
}

/**
 * Groups chunks by file path for reuse checks.
 */
export function groupChunksByFile(
  chunks: Readonly<Record<string, SemanticChunkRecord>>,
): ReadonlyMap<string, readonly SemanticChunkRecord[]> {
  const grouped = new Map<string, SemanticChunkRecord[]>();
  Object.values(chunks).forEach((chunk) => {
    const current = grouped.get(chunk.filePath) ?? [];
    current.push(chunk);
    grouped.set(chunk.filePath, current);
  });
  return grouped as ReadonlyMap<string, readonly SemanticChunkRecord[]>;
}

/**
 * Checks whether existing chunks can be reused for a file snapshot.
 */
export function canReuseFileChunks(
  existingChunks: readonly SemanticChunkRecord[] | undefined,
  mtimeMs: number,
): existingChunks is readonly SemanticChunkRecord[] {
  if (!existingChunks || existingChunks.length === 0) {
    return false;
  }
  return existingChunks.every((chunk) => chunk.mtimeMs === mtimeMs);
}

/**
 * Builds a fallback description for a syntax symbol.
 */
export function buildSymbolDescription(symbol: SyntaxSymbolRecord, commentText: string | null): Readonly<{
  description: string;
  source: 'comment' | 'signature';
}> {
  if (commentText) {
    return Object.freeze({ description: commentText, source: 'comment' });
  }

  const exportedPrefix = symbol.exported ? 'Exported ' : '';
  const description =
    symbol.kind === 'class'
      ? `${exportedPrefix}class ${symbol.name}.`
      : symbol.kind === 'interface'
        ? `${exportedPrefix}interface ${symbol.name}.`
        : symbol.kind === 'enum'
          ? `${exportedPrefix}enum ${symbol.name}.`
          : symbol.kind === 'type'
            ? `${exportedPrefix}type ${symbol.name}.`
            : symbol.kind === 'const'
              ? `${exportedPrefix}constant ${symbol.name}.`
              : `${exportedPrefix}${symbol.kind} ${symbol.name}.`;
  return Object.freeze({ description, source: 'signature' });
}

/**
 * Builds a retrieval-friendly module overview for one source file.
 */
export function buildModuleOverview(relativePath: string, record: SyntaxContextRecordSummary | undefined, raw: string): Readonly<{
  description: string;
  excerpt: string;
}> {
  const lines = raw.split(/\r?\n/);
  const summaryLines: string[] = [`Module: ${relativePath}`];
  const symbolKinds = new Set((record?.symbols ?? []).map((symbol) => symbol.kind));
  const exportedSymbols = (record?.symbols ?? []).filter((symbol) => symbol.exported).map((symbol) => symbol.name);
  const topSymbols = (record?.symbols ?? []).slice(0, 5).map((symbol) => `${symbol.kind} ${symbol.name}`);
  const imports = record?.imports.slice(0, 6) ?? [];

  if (imports.length > 0) {
    summaryLines.push(`Imports: ${imports.join(', ')}`);
  }
  if (exportedSymbols.length > 0) {
    summaryLines.push(`Exports: ${exportedSymbols.join(', ')}`);
  } else if ((record?.exports.length ?? 0) > 0) {
    summaryLines.push(`Exports: ${record!.exports.slice(0, 6).join(', ')}`);
  }
  if (topSymbols.length > 0) {
    summaryLines.push(`Top symbols: ${topSymbols.join('; ')}`);
  }

  const descriptionParts = [
    imports.length > 0 ? `Depends on ${imports.slice(0, 3).join(', ')}.` : '',
    exportedSymbols.length > 0 ? `Exports ${exportedSymbols.slice(0, 3).join(', ')}.` : '',
    symbolKinds.size > 0 ? `Contains ${[...symbolKinds].slice(0, 3).join(', ')} symbols.` : '',
  ].filter(Boolean);
  const description = descriptionParts.join(' ') || `Module overview for ${relativePath}.`;
  const excerpt = normalizeWhitespace([...summaryLines, '', ...lines.slice(0, 24)].join('\n')).slice(0, MAX_EXCERPT_CHARS);

  return Object.freeze({ description, excerpt });
}
