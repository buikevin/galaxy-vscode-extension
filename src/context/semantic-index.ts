import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './compaction';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';
import { queryRagHintPaths, syncSemanticMetadata } from './rag-metadata-store';
import type { SyntaxContextRecordSummary, SyntaxSymbolRecord } from './syntax-index';

const SEMANTIC_INDEX_VERSION = 2;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CHUNKS_PER_FILE = 6;
const MAX_RESULTS = 5;
const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_TIMEOUT_MS = 2500;
const MAX_EXCERPT_CHARS = 280;
const MAX_TERMS_PER_CHUNK = 48;
const MAX_SCAN_DIRS = 24;
const MAX_SCAN_FILES = 120;
const DOC_SUFFIXES = ['.md', '.mdx', '.txt', '.json', '.yaml', '.yml'];
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'then', 'than',
  'are', 'was', 'were', 'been', 'have', 'has', 'had', 'not', 'but', 'use', 'using',
  'your', 'you', 'they', 'them', 'their', 'file', 'files', 'code', 'will', 'just',
  'about', 'after', 'before', 'into', 'onto', 'over', 'under', 'also', 'each',
]);
const PREFERRED_DIR_NAMES = ['docs', 'doc', 'spec', 'specs', 'src', 'app', 'packages', 'components', 'webview'];
const IGNORED_SEGMENTS = new Set(['.git', '.galaxy', 'node_modules', 'dist', 'build', 'out', 'coverage']);
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
const GEMINI_EMBEDDING_API_KEY = 'AIzaSyBBEuo4Hz1d5oCtSxYe0uULMCXtQS-7DF0';

type SemanticChunkKind = 'code_symbol' | 'code_module' | 'doc_section';

type SemanticChunkRecord = Readonly<{
  id: string;
  filePath: string;
  title: string;
  kind: SemanticChunkKind;
  symbolName?: string;
  symbolKind?: string;
  exported?: boolean;
  startLine?: number;
  endLine?: number;
  excerpt: string;
  terms: Readonly<Record<string, number>>;
  magnitude: number;
  embedding?: readonly number[];
  embeddingModel?: string;
  mtimeMs: number;
  indexedAt: number;
}>;

type SemanticIndexStore = Readonly<{
  version: number;
  workspacePath: string;
  updatedAt: number;
  chunks: Readonly<Record<string, SemanticChunkRecord>>;
}>;

export type SemanticRetrievalResult = Readonly<{
  content: string;
  chunkContent: string;
  tokens: number;
  entryCount: number;
  candidatePaths: readonly string[];
}>;

function createEmptyStore(workspacePath: string): SemanticIndexStore {
  return Object.freeze({
    version: SEMANTIC_INDEX_VERSION,
    workspacePath,
    updatedAt: 0,
    chunks: Object.freeze({}),
  });
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function resolveWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
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

function compareDirNames(a: string, b: string): number {
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

function loadStore(workspacePath: string): SemanticIndexStore {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  if (!fs.existsSync(storage.semanticIndexPath)) {
    return createEmptyStore(workspacePath);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(storage.semanticIndexPath, 'utf-8')) as SemanticIndexStore;
    if (raw.version !== SEMANTIC_INDEX_VERSION || raw.workspacePath !== workspacePath) {
      return createEmptyStore(workspacePath);
    }
    return raw;
  } catch {
    return createEmptyStore(workspacePath);
  }
}

function saveStore(workspacePath: string, store: SemanticIndexStore): void {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  fs.writeFileSync(storage.semanticIndexPath, JSON.stringify(store, null, 2), 'utf-8');
  syncSemanticMetadata(
    workspacePath,
    Object.values(store.chunks).map((chunk) =>
      Object.freeze({
        id: chunk.id,
        filePath: chunk.filePath,
        title: chunk.title,
        kind: chunk.kind,
        ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
        ...(typeof chunk.exported === 'boolean' ? { exported: chunk.exported } : {}),
        ...(typeof chunk.startLine === 'number' ? { startLine: chunk.startLine } : {}),
        ...(typeof chunk.endLine === 'number' ? { endLine: chunk.endLine } : {}),
        mtimeMs: chunk.mtimeMs,
        ...(chunk.embeddingModel ? { embeddingModel: chunk.embeddingModel } : {}),
        indexedAt: chunk.indexedAt,
      }),
    ),
  );
}

function isDocFile(relativePath: string): boolean {
  return DOC_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

function isSourceFile(relativePath: string): boolean {
  return SOURCE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): readonly string[] {
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

function buildPathTokens(relativePath: string): readonly string[] {
  return Object.freeze(
    relativePath
      .toLowerCase()
      .split('/')
      .flatMap((segment) => segment.split(/[^a-z0-9_]+/))
      .filter((token) => token.length >= 2),
  );
}

function buildTermVector(text: string): Readonly<{ terms: Readonly<Record<string, number>>; magnitude: number }> {
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

function cosineSimilarity(
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

function cosineSimilarityEmbedding(query: readonly number[], chunk: readonly number[]): number {
  if (query.length === 0 || chunk.length === 0 || query.length !== chunk.length) {
    return 0;
  }

  let dot = 0;
  let queryMagnitude = 0;
  let chunkMagnitude = 0;
  for (let index = 0; index < query.length; index += 1) {
    const q = query[index] ?? 0;
    const c = chunk[index] ?? 0;
    dot += q * c;
    queryMagnitude += q * q;
    chunkMagnitude += c * c;
  }
  if (dot === 0 || queryMagnitude === 0 || chunkMagnitude === 0) {
    return 0;
  }
  return dot / (Math.sqrt(queryMagnitude) * Math.sqrt(chunkMagnitude));
}

function makeChunkId(filePath: string, kind: SemanticChunkKind, title: string, startLine?: number): string {
  return `${filePath}#${kind}:${title}:${startLine ?? 0}`;
}

function createChunk(opts: {
  filePath: string;
  title: string;
  kind: SemanticChunkKind;
  excerpt: string;
  mtimeMs: number;
  symbol?: SyntaxSymbolRecord;
  startLine?: number;
  endLine?: number;
}): SemanticChunkRecord {
  const vector = buildTermVector(`${opts.title}\n${opts.excerpt}`);
  return Object.freeze({
    id: makeChunkId(opts.filePath, opts.kind, opts.title, opts.startLine),
    filePath: opts.filePath,
    title: opts.title,
    kind: opts.kind,
    ...(opts.symbol ? { symbolName: opts.symbol.name, symbolKind: opts.symbol.kind, exported: opts.symbol.exported } : {}),
    ...(typeof opts.startLine === 'number' ? { startLine: opts.startLine } : {}),
    ...(typeof opts.endLine === 'number' ? { endLine: opts.endLine } : {}),
    excerpt: opts.excerpt,
    terms: vector.terms,
    magnitude: vector.magnitude,
    mtimeMs: opts.mtimeMs,
    indexedAt: Date.now(),
  });
}

function groupChunksByFile(
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

function canReuseFileChunks(
  existingChunks: readonly SemanticChunkRecord[] | undefined,
  mtimeMs: number,
): existingChunks is readonly SemanticChunkRecord[] {
  if (!existingChunks || existingChunks.length === 0) {
    return false;
  }
  return existingChunks.every((chunk) => chunk.mtimeMs === mtimeMs);
}

function computeSemanticChunkScore(opts: {
  chunk: SemanticChunkRecord;
  queryTerms: Readonly<Record<string, number>>;
  queryMagnitude: number;
  queryEmbedding: readonly number[] | null;
  candidateFiles: readonly string[];
  primaryPaths?: readonly string[];
  definitionPaths?: readonly string[];
  referencePaths?: readonly string[];
  queryText: string;
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

  return score;
}

function buildCodeChunks(relativePath: string, raw: string, mtimeMs: number, record?: SyntaxContextRecordSummary): readonly SemanticChunkRecord[] {
  const chunks: SemanticChunkRecord[] = [];
  const lines = raw.split(/\r?\n/);
  const symbols = record?.symbols.slice(0, MAX_CHUNKS_PER_FILE - 1) ?? [];

  symbols.forEach((symbol, index) => {
    const nextLine = symbols[index + 1]?.line ?? Math.min(lines.length + 1, symbol.line + 80);
    const startLine = symbol.line;
    const endLine = Math.max(startLine, Math.min(lines.length, nextLine - 1, startLine + 80));
    const excerpt = normalizeWhitespace(lines.slice(startLine - 1, endLine).join('\n')).slice(0, MAX_EXCERPT_CHARS);
    if (!excerpt) {
      return;
    }
    chunks.push(
      createChunk({
        filePath: relativePath,
        title: symbol.signature,
        kind: 'code_symbol',
        excerpt,
        mtimeMs,
        symbol,
        startLine,
        endLine,
      }),
    );
  });

  const moduleExcerpt = normalizeWhitespace(lines.slice(0, 80).join('\n')).slice(0, MAX_EXCERPT_CHARS);
  if (moduleExcerpt) {
    chunks.unshift(
      createChunk({
        filePath: relativePath,
        title: `${relativePath} module overview`,
        kind: 'code_module',
        excerpt: moduleExcerpt,
        mtimeMs,
        startLine: 1,
        endLine: Math.min(lines.length, 80),
      }),
    );
  }

  return Object.freeze(chunks.slice(0, MAX_CHUNKS_PER_FILE));
}

function splitDocSections(raw: string): readonly Readonly<{ title: string; excerpt: string; startLine: number; endLine: number }>[] {
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

function buildDocChunks(relativePath: string, raw: string, mtimeMs: number): readonly SemanticChunkRecord[] {
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
      }),
    ),
  );
}

function scanDocCandidates(workspacePath: string): readonly string[] {
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

function rebuildChunksForFile(opts: {
  workspacePath: string;
  relativePath: string;
  recordMap: ReadonlyMap<string, SyntaxContextRecordSummary>;
}): readonly SemanticChunkRecord[] {
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
    return buildCodeChunks(opts.relativePath, raw, stat.mtimeMs, opts.recordMap.get(opts.relativePath));
  }
  return Object.freeze([]);
}

function syncStore(opts: {
  workspacePath: string;
  candidateFiles: readonly string[];
  records: readonly SyntaxContextRecordSummary[];
}): SemanticIndexStore {
  const recordMap = new Map(opts.records.map((record) => [record.relativePath, record] as const));
  const currentStore = loadStore(opts.workspacePath);
  const existingChunksByFile = groupChunksByFile(currentStore.chunks);
  const candidateFiles = [...new Set([...opts.candidateFiles, ...scanDocCandidates(opts.workspacePath)])]
    .filter((relativePath) => isDocFile(relativePath) || isSourceFile(relativePath));
  const nextChunks: Record<string, SemanticChunkRecord> = {};

  candidateFiles.forEach((relativePath) => {
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
      return;
    }

    rebuildChunksForFile({
      workspacePath: opts.workspacePath,
      relativePath,
      recordMap,
    }).forEach((chunk) => {
      nextChunks[chunk.id] = chunk;
    });
  });

  const nextStore = Object.freeze({
    version: SEMANTIC_INDEX_VERSION,
    workspacePath: opts.workspacePath,
    updatedAt: Date.now(),
    chunks: Object.freeze(nextChunks),
  });

  const hasChanged =
    Object.keys(currentStore.chunks).length !== Object.keys(nextStore.chunks).length ||
    Object.entries(nextStore.chunks).some(([chunkId, chunk]) => {
      const current = currentStore.chunks[chunkId];
      return JSON.stringify(current) !== JSON.stringify(chunk);
    });
  if (hasChanged) {
    saveStore(opts.workspacePath, nextStore);
  }
  return nextStore;
}

async function embedTexts(
  texts: readonly string[],
  taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT',
): Promise<readonly (readonly number[])[] | null> {
  if (texts.length === 0) {
    return Object.freeze([]);
  }

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: GEMINI_EMBEDDING_API_KEY });
    const response = await Promise.race([
      client.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: [...texts],
        config: {
          taskType,
        },
      }),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), EMBEDDING_TIMEOUT_MS);
      }),
    ]);
    if (!response) {
      return null;
    }
    const embeddings = (response.embeddings ?? []).map((item) => Object.freeze([...(item.values ?? [])]));
    if (embeddings.length !== texts.length) {
      return null;
    }
    return Object.freeze(embeddings);
  } catch {
    return null;
  }
}

async function ensureChunkEmbeddings(store: SemanticIndexStore): Promise<SemanticIndexStore> {
  const missing = Object.entries(store.chunks).filter(([, chunk]) => !chunk.embedding || chunk.embeddingModel !== GEMINI_EMBEDDING_MODEL);
  if (missing.length === 0) {
    return store;
  }

  const nextChunks: Record<string, SemanticChunkRecord> = { ...store.chunks };
  let changed = false;

  for (let index = 0; index < missing.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = missing.slice(index, index + EMBEDDING_BATCH_SIZE);
    const inputs = batch.map(([, chunk]) => `${chunk.title}\n${chunk.excerpt}`);
    const embeddings = await embedTexts(inputs, 'RETRIEVAL_DOCUMENT');
    if (!embeddings || embeddings.length !== batch.length) {
      continue;
    }

    batch.forEach(([chunkId, chunk], batchIndex) => {
      const embedding = embeddings[batchIndex];
      if (!embedding || embedding.length === 0) {
        return;
      }
      nextChunks[chunkId] = Object.freeze({
        ...chunk,
        embedding: Object.freeze([...embedding]),
        embeddingModel: GEMINI_EMBEDDING_MODEL,
      });
      changed = true;
    });
  }

  if (!changed) {
    return store;
  }

  const nextStore = Object.freeze({
    ...store,
    updatedAt: Date.now(),
    chunks: Object.freeze(nextChunks),
  });
  saveStore(store.workspacePath, nextStore);
  return nextStore;
}

export async function buildSemanticRetrievalContext(opts: {
  workspacePath: string;
  queryText: string;
  candidateFiles: readonly string[];
  records: readonly SyntaxContextRecordSummary[];
  primaryPaths?: readonly string[];
  definitionPaths?: readonly string[];
  referencePaths?: readonly string[];
}): Promise<SemanticRetrievalResult> {
  if (!opts.queryText.trim()) {
    return Object.freeze({
      content: '',
      chunkContent: '',
      tokens: 0,
      entryCount: 0,
      candidatePaths: Object.freeze([]),
    });
  }

  const sqliteHintPaths = queryRagHintPaths(opts.workspacePath, opts.queryText, 4);

  const syncedStore = syncStore({
    workspacePath: opts.workspacePath,
    candidateFiles: [...opts.candidateFiles, ...sqliteHintPaths],
    records: opts.records,
  });
  const store = await ensureChunkEmbeddings(syncedStore).catch(() => syncedStore);
  const queryVector = buildTermVector(opts.queryText);
  const queryEmbedding = (await embedTexts([opts.queryText], 'RETRIEVAL_QUERY'))?.[0] ?? null;
  const topChunks = Object.values(store.chunks)
    .map((chunk) => {
      const score = computeSemanticChunkScore({
        chunk,
        queryTerms: queryVector.terms,
        queryMagnitude: queryVector.magnitude,
        queryEmbedding,
        candidateFiles: [...opts.candidateFiles, ...sqliteHintPaths],
        primaryPaths: opts.primaryPaths,
        definitionPaths: opts.definitionPaths,
        referencePaths: opts.referencePaths,
        queryText: opts.queryText,
      });
      return Object.freeze({ chunk, score });
    })
    .filter((entry) => entry.score > 0.08)
    .sort((a, b) => b.score - a.score || a.chunk.filePath.localeCompare(b.chunk.filePath))
    .slice(0, MAX_RESULTS);

  if (topChunks.length === 0) {
    return Object.freeze({
      content: '',
      chunkContent: '',
      tokens: 0,
      entryCount: 0,
      candidatePaths: Object.freeze([]),
    });
  }

  const retrievalLines = ['[SEMANTIC RETRIEVAL]'];
  const chunkLines = ['[SEMANTIC CHUNKS]'];
  topChunks.forEach((entry, index) => {
    retrievalLines.push(`- ${entry.chunk.filePath} :: ${entry.chunk.title} (score ${entry.score.toFixed(2)})`);
    if (index > 0) {
      chunkLines.push('');
    }
    chunkLines.push(`File: ${entry.chunk.filePath}`);
    chunkLines.push(`Chunk: ${entry.chunk.title}`);
    chunkLines.push(`Excerpt: ${entry.chunk.excerpt}`);
  });

  const content = retrievalLines.join('\n').trim();
  const chunkContent = chunkLines.join('\n').trim();
  return Object.freeze({
    content,
    chunkContent,
    tokens: estimateTokens(content) + estimateTokens(chunkContent),
    entryCount: topChunks.length,
    candidatePaths: Object.freeze([...new Set(topChunks.map((entry) => entry.chunk.filePath))]),
  });
}
