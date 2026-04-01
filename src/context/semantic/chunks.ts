/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Chunk building and scoring helpers for semantic indexing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractCodeChunkUnits } from '../code-chunk-extractor';
import type { SemanticChunkRecord } from '../entities/semantic-index';
import type { SyntaxContextRecordSummary, SyntaxSymbolRecord } from '../entities/syntax-index';
import { DOC_SUFFIXES, IGNORED_SEGMENTS, MAX_CHUNKS_PER_FILE, MAX_EXCERPT_CHARS, MAX_FILE_BYTES, MAX_SCAN_DIRS, MAX_SCAN_FILES, SEMANTIC_INDEX_VERSION, SOURCE_SUFFIXES } from './constants';
import {
  buildModuleOverview,
  buildPathTokens,
  canReuseFileChunks,
  compareDirNames,
  cosineSimilarity,
  createChunk,
  groupChunksByFile,
  normalizeWhitespace,
  resolveWorkspaceRelativePath,
  tokenize,
  buildSymbolDescription,
} from './helpers';
import { cosineSimilarityEmbedding } from '../gemini-embeddings';
import { loadStore, saveStore } from './store';

/**
 * Checks whether a relative path is a document candidate.
 */
export function isDocFile(relativePath: string): boolean {
  return DOC_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/**
 * Checks whether a relative path is a supported source file.
 */
export function isSourceFile(relativePath: string): boolean {
  return SOURCE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/**
 * Normalizes a comment block into one retrieval description line.
 */
export function normalizeDescription(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
      .replace(/^\s*\/\/\s?/gm, '')
      .replace(/^\s*#\s?/gm, '')
      .replace(/^\s*\*\s?/gm, '')
      .replace(/^\s*--\s?/gm, ''),
  ).slice(0, 200);
}

/**
 * Extracts a comment block immediately above a symbol definition.
 */
export function extractLeadingComment(lines: readonly string[], startLine: number): string | null {
  const collected: string[] = [];
  let lineIndex = startLine - 2;
  let sawComment = false;

  while (lineIndex >= 0 && collected.length < 8) {
    const line = lines[lineIndex] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      if (sawComment) {
        break;
      }
      lineIndex -= 1;
      continue;
    }
    const isCommentLine =
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*/') ||
      trimmed.startsWith('--');
    if (!isCommentLine) {
      break;
    }
    sawComment = true;
    collected.unshift(line);
    lineIndex -= 1;
  }

  const normalized = normalizeDescription(collected.join('\n'));
  return normalized || null;
}

/**
 * Builds semantic chunks for one source file.
 */
export async function buildCodeChunks(relativePath: string, raw: string, mtimeMs: number, record?: SyntaxContextRecordSummary): Promise<readonly SemanticChunkRecord[]> {
  const chunks: SemanticChunkRecord[] = [];
  const lines = raw.split(/\r?\n/);
  const extractedUnits = await extractCodeChunkUnits({ relativePath, content: raw });
  const fallbackSymbols = record?.symbols.slice(0, MAX_CHUNKS_PER_FILE - 1) ?? [];
  const units = extractedUnits.length > 0
    ? extractedUnits.slice(0, MAX_CHUNKS_PER_FILE - 1).map((unit) => Object.freeze({
        ...unit,
        excerpt: normalizeWhitespace(raw.slice(unit.startIndex, unit.endIndex)).slice(0, MAX_EXCERPT_CHARS),
      }))
    : fallbackSymbols.map((symbol, index) => {
        const nextLine = fallbackSymbols[index + 1]?.line ?? Math.min(lines.length + 1, symbol.line + 80);
        const startLine = symbol.line;
        const endLine = Math.max(startLine, Math.min(lines.length, nextLine - 1, startLine + 80));
        return Object.freeze({
          name: symbol.name,
          kind: symbol.kind,
          exported: symbol.exported,
          signature: symbol.signature,
          startLine,
          endLine,
          excerpt: normalizeWhitespace(lines.slice(startLine - 1, endLine).join('\n')).slice(0, MAX_EXCERPT_CHARS),
        });
      });

  units.forEach((unit) => {
    if (!unit.excerpt) {
      return;
    }
    const symbol = Object.freeze({
      name: unit.name,
      kind: unit.kind,
      exported: unit.exported,
      line: unit.startLine,
      signature: unit.signature,
    } satisfies SyntaxSymbolRecord);
    const symbolDescription = buildSymbolDescription(symbol, extractLeadingComment(lines, unit.startLine));
    chunks.push(
      createChunk({
        filePath: relativePath,
        title: unit.signature,
        kind: 'code_symbol',
        excerpt: unit.excerpt,
        mtimeMs,
        symbol,
        startLine: unit.startLine,
        endLine: unit.endLine,
        description: symbolDescription.description,
        descriptionSource: symbolDescription.source,
      }),
    );
  });

  const moduleOverview = buildModuleOverview(relativePath, record, raw);
  if (moduleOverview.excerpt) {
    chunks.unshift(
      createChunk({
        filePath: relativePath,
        title: `${relativePath} module overview`,
        kind: 'code_module',
        excerpt: moduleOverview.excerpt,
        mtimeMs,
        startLine: 1,
        endLine: Math.min(lines.length, 80),
        description: moduleOverview.description,
        descriptionSource: 'module_overview',
      }),
    );
  }

  return Object.freeze(chunks.slice(0, MAX_CHUNKS_PER_FILE));
}

/**
 * Splits one document into bounded semantic sections.
 */
export function splitDocSections(raw: string): readonly Readonly<{ title: string; excerpt: string; startLine: number; endLine: number }>[] {
  const lines = raw.split(/\r?\n/);
  const sections: Array<Readonly<{ title: string; excerpt: string; startLine: number; endLine: number }>> = [];
  let startLine = 1;
  let title = 'Document overview';

  const pushSection = (endLine: number): void => {
    const excerpt = normalizeWhitespace(lines.slice(startLine - 1, endLine).join('\n')).slice(0, MAX_EXCERPT_CHARS);
    if (!excerpt) {
      return;
    }
    sections.push(Object.freeze({ title, excerpt, startLine, endLine }));
  };

  lines.forEach((line, index) => {
    if (/^\s{0,3}#{1,3}\s+/.test(line) && index + 1 > startLine) {
      pushSection(index);
      title = line.replace(/^\s{0,3}#{1,3}\s+/, '').trim() || 'Section';
      startLine = index + 1;
    }
  });
  pushSection(lines.length);

  if (sections.length === 0) {
    const excerpt = normalizeWhitespace(raw).slice(0, MAX_EXCERPT_CHARS);
    if (!excerpt) {
      return Object.freeze([]);
    }
    return Object.freeze([Object.freeze({ title: 'Document overview', excerpt, startLine: 1, endLine: lines.length })]);
  }

  return Object.freeze(sections.slice(0, MAX_CHUNKS_PER_FILE));
}

/**
 * Builds semantic chunks for one document file.
 */
export function buildDocChunks(relativePath: string, raw: string, mtimeMs: number): readonly SemanticChunkRecord[] {
  return Object.freeze(
    splitDocSections(raw).map((section) =>
      createChunk({
        filePath: relativePath,
        title: section.title,
        kind: 'doc_section',
        excerpt: section.excerpt,
        mtimeMs,
        startLine: section.startLine,
        endLine: section.endLine,
        description: section.title,
        descriptionSource: 'section_title',
      }),
    ),
  );
}

/**
 * Scans a limited set of document candidates from preferred workspace directories.
 */
export function scanDocCandidates(workspacePath: string): readonly string[] {
  const results: string[] = [];
  const queue = [workspacePath];
  let visitedDirs = 0;

  while (queue.length > 0 && visitedDirs < MAX_SCAN_DIRS && results.length < MAX_SCAN_FILES) {
    const currentDir = queue.shift()!;
    visitedDirs += 1;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const directories = entries
      .filter((entry) => entry.isDirectory() && !IGNORED_SEGMENTS.has(entry.name))
      .sort((a, b) => compareDirNames(a.name, b.name));
    directories.slice(0, 8).forEach((entry) => queue.push(path.join(currentDir, entry.name)));

    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => DOC_SUFFIXES.some((suffix) => name.endsWith(suffix)))
      .slice(0, 12)
      .forEach((fileName) => {
        const relativePath = resolveWorkspaceRelativePath(workspacePath, path.join(currentDir, fileName));
        if (relativePath) {
          results.push(relativePath);
        }
      });
  }

  return Object.freeze([...new Set(results)].slice(0, MAX_SCAN_FILES));
}

/**
 * Rebuilds chunks for one file if it still exists and is eligible.
 */
export async function rebuildChunksForFile(opts: {
  workspacePath: string;
  relativePath: string;
  recordMap: ReadonlyMap<string, SyntaxContextRecordSummary>;
}): Promise<readonly SemanticChunkRecord[]> {
  const absolutePath = path.join(opts.workspacePath, opts.relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return Object.freeze([]);
    }
  } catch {
    return Object.freeze([]);
  }

  let raw = '';
  try {
    raw = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return Object.freeze([]);
  }

  if (isDocFile(opts.relativePath)) {
    return buildDocChunks(opts.relativePath, raw, stat.mtimeMs);
  }
  if (isSourceFile(opts.relativePath)) {
    return await buildCodeChunks(opts.relativePath, raw, stat.mtimeMs, opts.recordMap.get(opts.relativePath));
  }
  return Object.freeze([]);
}

/**
 * Synchronizes the semantic store with candidate files and syntax records.
 */
export async function syncStore(opts: {
  workspacePath: string;
  candidateFiles: readonly string[];
  records: readonly SyntaxContextRecordSummary[];
}): Promise<import('../entities/semantic-index').SemanticIndexStore> {
  const recordMap = new Map(opts.records.map((record) => [record.relativePath, record] as const));
  const currentStore = loadStore(opts.workspacePath);
  const existingChunksByFile = groupChunksByFile(currentStore.chunks);
  const candidateFiles = [...new Set([...opts.candidateFiles, ...scanDocCandidates(opts.workspacePath)])]
    .filter((relativePath) => isDocFile(relativePath) || isSourceFile(relativePath));
  const nextChunks: Record<string, SemanticChunkRecord> = {};

  for (const relativePath of candidateFiles) {
    const absolutePath = path.join(opts.workspacePath, relativePath);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      stat = null;
    }

    if (stat && canReuseFileChunks(existingChunksByFile.get(relativePath), stat.mtimeMs)) {
      existingChunksByFile.get(relativePath)!.forEach((chunk) => {
        nextChunks[chunk.id] = chunk;
      });
      continue;
    }

    (await rebuildChunksForFile({
      workspacePath: opts.workspacePath,
      relativePath,
      recordMap,
    })).forEach((chunk) => {
      nextChunks[chunk.id] = chunk;
    });
  }

  const nextStore = Object.freeze({
    version: SEMANTIC_INDEX_VERSION,
    workspacePath: opts.workspacePath,
    updatedAt: Date.now(),
    chunks: Object.freeze(nextChunks),
  });

  const hasChanged =
    Object.keys(currentStore.chunks).length !== Object.keys(nextStore.chunks).length ||
    Object.entries(nextStore.chunks).some(([chunkId, chunk]) => JSON.stringify(currentStore.chunks[chunkId]) !== JSON.stringify(chunk));
  if (hasChanged) {
    saveStore(opts.workspacePath, nextStore);
  }
  return nextStore;
}

/**
 * Computes the final semantic score for one chunk against the current query.
 */
export function computeSemanticChunkScore(opts: {
  chunk: SemanticChunkRecord;
  queryTerms: Readonly<Record<string, number>>;
  queryMagnitude: number;
  queryEmbedding: readonly number[] | null;
  candidateFiles: readonly string[];
  primaryPaths?: readonly string[];
  definitionPaths?: readonly string[];
  referencePaths?: readonly string[];
  workflowPathScores?: Readonly<Record<string, number>>;
  queryText: string;
  chromaScore?: number;
}): number {
  const lexicalScore = cosineSimilarity(opts.queryTerms, opts.queryMagnitude, opts.chunk.terms, opts.chunk.magnitude);
  const embeddingScore =
    opts.queryEmbedding && opts.chunk.embedding
      ? cosineSimilarityEmbedding(opts.queryEmbedding, opts.chunk.embedding)
      : 0;
  let score = embeddingScore > 0 ? embeddingScore * 0.65 + lexicalScore * 0.35 : lexicalScore;
  const queryTokens = tokenize(opts.queryText);
  const filePathLower = opts.chunk.filePath.toLowerCase();
  const titleLower = opts.chunk.title.toLowerCase();
  const fileTokens = buildPathTokens(opts.chunk.filePath);

  if ((opts.candidateFiles ?? []).includes(opts.chunk.filePath)) {
    score += 0.18;
  }
  if ((opts.primaryPaths ?? []).includes(opts.chunk.filePath)) {
    score += 0.14;
  }
  if ((opts.definitionPaths ?? []).includes(opts.chunk.filePath)) {
    score += 0.1;
  }
  if ((opts.referencePaths ?? []).includes(opts.chunk.filePath)) {
    score += 0.08;
  }
  const workflowPathScore = opts.workflowPathScores?.[opts.chunk.filePath] ?? 0;
  if (workflowPathScore > 0) {
    score += Math.min(0.34, workflowPathScore * 0.025);
  }

  queryTokens.forEach((token) => {
    if (opts.chunk.symbolName?.toLowerCase() === token) {
      score += 0.16;
      return;
    }
    if (titleLower.includes(token)) {
      score += 0.07;
    }
    if (filePathLower.includes(`/${token}/`) || fileTokens.includes(token)) {
      score += 0.05;
    }
  });

  if (opts.chunk.kind === 'code_symbol') {
    score += 0.04;
  } else if (opts.chunk.kind === 'doc_section') {
    score += 0.02;
  }
  if (opts.chunk.exported) {
    score += 0.03;
  }
  if (typeof opts.chromaScore === 'number' && opts.chromaScore > 0) {
    score += opts.chromaScore * 0.2;
  }

  return score;
}
