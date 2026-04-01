/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Semantic document chunking and retrieval for workspace documents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createChromaClient, resolveChromaUrl } from './chroma-manager';
import {
  DOCUMENT_CHROMA_RESOLVE_TIMEOUT_MS,
  DOCUMENT_CHROMA_TIMEOUT_MS,
  DOCUMENT_CHUNK_MIN_CHARS,
  DOCUMENT_CHUNK_OVERLAP_CHARS,
  DOCUMENT_CHUNK_TARGET_CHARS,
  DOCUMENT_SOURCE_CACHE_LIMIT,
  DOCUMENT_SOURCE_CACHE_OFFSET,
} from './entities/constants';
import type { DocumentSemanticQueryResult, DocumentSemanticSource } from './entities/document-semantic';
import { embedTexts } from './gemini-embeddings';
import { getProjectStorageInfo } from './project-store';
import { getCachedReadResult, storeReadCache } from './rag-metadata/read-cache';
import { readDocumentFile } from '../tools/document-reader';
const MANUAL_EMBEDDING_FUNCTION = Object.freeze({
  name: 'galaxy-manual-embedding',
  async generate(): Promise<number[][]> {
    throw new Error('Manual embeddings only. Provide embeddings explicitly.');
  },
  async generateForQueries(): Promise<number[][]> {
    throw new Error('Manual embeddings only. Provide query embeddings explicitly.');
  },
});

/**
 * Collapses noisy whitespace so retrieval snippets remain compact.
 */
function normalizeWhitespace(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

/**
 * Builds the per-workspace Chroma collection name for document chunks.
 */
function buildDocumentCollectionName(workspaceId: string): string {
  return `galaxy-document-chunks-v2-${workspaceId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
}

/**
 * Generates a stable chunk identifier for one document slice.
 */
function createDocumentChunkId(filePath: string, sourceVersion: string, chunkIndex: number): string {
  return createHash('sha1')
    .update(`${filePath}:${sourceVersion}:${chunkIndex}`)
    .digest('hex');
}

/**
 * Splits one decoded document into overlapping semantic chunks.
 */
function chunkDocumentContent(content: string): readonly string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return Object.freeze([]);
  }

  const paragraphs = normalized
    .split(/\n{2,}/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) {
    return Object.freeze([normalized]);
  }

  const chunks: string[] = [];
  let current = '';
  paragraphs.forEach((paragraph) => {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= DOCUMENT_CHUNK_TARGET_CHARS || current.length < DOCUMENT_CHUNK_MIN_CHARS) {
      current = next;
      return;
    }
    chunks.push(current);
    current = `${current.slice(-DOCUMENT_CHUNK_OVERLAP_CHARS)}${paragraph}`;
  });
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return Object.freeze(chunks.map((chunk) => chunk.trim()).filter(Boolean));
}

/**
 * Builds the embedding payload enriched with source metadata.
 */
function buildEmbeddingDocument(
  filePath: string,
  format: string | undefined,
  chunkText: string,
  chunkIndex: number,
  chunkCount: number,
): string {
  return [
    `Document path: ${filePath}`,
    format ? `Format: ${format}` : '',
    `Chunk ${chunkIndex + 1} of ${chunkCount}`,
    chunkText,
  ].filter(Boolean).join('\n');
}

/**
 * Tokenizes free-text queries for lexical fallback ranking.
 */
function tokenize(text: string): readonly string[] {
  return Object.freeze(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((token) => token.length >= 2),
  );
}

/**
 * Produces a lightweight lexical ranking when embeddings are unavailable.
 */
function lexicalRankChunks(queryText: string, chunks: readonly string[], limit: number): readonly string[] {
  const queryTokens = tokenize(queryText);
  return Object.freeze(
    chunks
      .map((chunk) => {
        const haystack = chunk.toLowerCase();
        const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
        return Object.freeze({ chunk, score });
      })
      .sort((a, b) => b.score - a.score)
      .filter((entry) => entry.score > 0)
      .slice(0, Math.max(1, limit))
      .map((entry) => normalizeWhitespace(entry.chunk)),
  );
}

/**
 * Computes cosine similarity between two embedding vectors.
 */
function cosineSimilarityEmbedding(left: readonly number[], right: readonly number[] | null): number {
  if (!right || left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (dot === 0 || leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * Loads and caches the fully decoded text of one document source.
 */
async function loadDocumentSource(workspacePath: string, filePath: string): Promise<DocumentSemanticSource | null> {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const stat = fs.statSync(resolvedPath);
  const cached = getCachedReadResult(workspacePath, {
    filePath: resolvedPath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    readMode: 'document_source',
    offset: DOCUMENT_SOURCE_CACHE_OFFSET,
    limit: DOCUMENT_SOURCE_CACHE_LIMIT,
  });
  if (cached?.content) {
    return Object.freeze({
      resolvedPath,
      stat,
      sourceVersion: `${stat.mtimeMs}:${stat.size}`,
      content: cached.content,
      ...(typeof cached.meta?.format === 'string' ? { format: cached.meta.format } : {}),
      ...(typeof cached.meta?.pageCount === 'number' ? { pageCount: cached.meta.pageCount } : {}),
    });
  }

  const documentResult = await readDocumentFile(resolvedPath, { maxChars: Number.MAX_SAFE_INTEGER, offset: 0 });
  if (!documentResult.success || !documentResult.content.trim()) {
    return null;
  }

  const meta = Object.freeze({
    filePath: resolvedPath,
    readMode: 'document_source',
    ...(documentResult.format ? { format: documentResult.format } : {}),
    ...(typeof documentResult.pageCount === 'number' ? { pageCount: documentResult.pageCount } : {}),
    ...(typeof documentResult.totalChars === 'number' ? { totalChars: documentResult.totalChars } : {}),
  });
  storeReadCache(workspacePath, {
    filePath: resolvedPath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    readMode: 'document_source',
    offset: DOCUMENT_SOURCE_CACHE_OFFSET,
    limit: DOCUMENT_SOURCE_CACHE_LIMIT,
    content: documentResult.content,
    metaJson: JSON.stringify(meta),
  });

  return Object.freeze({
    resolvedPath,
    stat,
    sourceVersion: `${stat.mtimeMs}:${stat.size}`,
    content: documentResult.content,
    ...(documentResult.format ? { format: documentResult.format } : {}),
    ...(typeof documentResult.pageCount === 'number' ? { pageCount: documentResult.pageCount } : {}),
  });
}

/**
 * Retrieves ranked document snippets for one natural-language query.
 */
export async function queryDocumentSemanticSnippets(opts: {
  workspacePath: string;
  filePath: string;
  queryText: string;
  limit?: number;
}): Promise<DocumentSemanticQueryResult> {
  const query = opts.queryText.trim();
  if (!query) {
    return Object.freeze({ snippets: Object.freeze([]) });
  }

  const documentSource = await loadDocumentSource(opts.workspacePath, opts.filePath);
  if (!documentSource) {
    return Object.freeze({ snippets: Object.freeze([]) });
  }

  const chunks = chunkDocumentContent(documentSource.content);
  if (chunks.length === 0) {
    return Object.freeze({ snippets: Object.freeze([]) });
  }

  const limit = Math.max(1, opts.limit ?? 3);
  const lexicalSnippets = lexicalRankChunks(query, chunks, limit);
  const chromaUrl = await Promise.race([
    resolveChromaUrl(opts.workspacePath),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DOCUMENT_CHROMA_RESOLVE_TIMEOUT_MS)),
  ]);
  if (!chromaUrl) {
    return Object.freeze({
      snippets: Object.freeze(lexicalSnippets),
      ...(documentSource.format ? { format: documentSource.format } : {}),
      ...(typeof documentSource.pageCount === 'number' ? { pageCount: documentSource.pageCount } : {}),
    });
  }

  try {
    const storage = getProjectStorageInfo(opts.workspacePath);
    const client = createChromaClient(chromaUrl);
    const collection = await Promise.race([
      client.getOrCreateCollection({
        name: buildDocumentCollectionName(storage.workspaceId),
        embeddingFunction: MANUAL_EMBEDDING_FUNCTION,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DOCUMENT_CHROMA_TIMEOUT_MS)),
    ]);
    if (!collection) {
      return Object.freeze({
        snippets: Object.freeze(lexicalSnippets),
        ...(documentSource.format ? { format: documentSource.format } : {}),
        ...(typeof documentSource.pageCount === 'number' ? { pageCount: documentSource.pageCount } : {}),
      });
    }

    const embeddingInputs = chunks.map((chunk, chunkIndex) =>
      buildEmbeddingDocument(documentSource.resolvedPath, documentSource.format, chunk, chunkIndex, chunks.length),
    );
    const embeddings = await embedTexts(embeddingInputs, 'RETRIEVAL_DOCUMENT');
    if (!embeddings || embeddings.length !== chunks.length) {
      return Object.freeze({
        snippets: Object.freeze(lexicalSnippets),
        ...(documentSource.format ? { format: documentSource.format } : {}),
        ...(typeof documentSource.pageCount === 'number' ? { pageCount: documentSource.pageCount } : {}),
      });
    }

    const queryEmbedding = (await embedTexts([query], 'RETRIEVAL_QUERY'))?.[0] ?? null;
    if (!queryEmbedding) {
      return Object.freeze({
        snippets: Object.freeze(lexicalSnippets),
        ...(documentSource.format ? { format: documentSource.format } : {}),
        ...(typeof documentSource.pageCount === 'number' ? { pageCount: documentSource.pageCount } : {}),
      });
    }

    const localSnippets = chunks
      .map((chunk, chunkIndex) => Object.freeze({
        chunk,
        score: cosineSimilarityEmbedding(queryEmbedding, embeddings[chunkIndex] ?? null),
      }))
      .sort((a, b) => b.score - a.score)
      .filter((entry) => entry.score > 0)
      .slice(0, limit)
      .map((entry) => normalizeWhitespace(entry.chunk));

    await Promise.race([
      collection.upsert({
        ids: chunks.map((_, chunkIndex) => createDocumentChunkId(documentSource.resolvedPath, documentSource.sourceVersion, chunkIndex)),
        documents: [...chunks],
        embeddings: embeddings.map((embedding) => [...embedding]),
        metadatas: chunks.map((_, chunkIndex) => ({
          filePath: documentSource.resolvedPath,
          sourceVersion: documentSource.sourceVersion,
          format: documentSource.format ?? '',
          chunkIndex,
          chunkCount: chunks.length,
        })),
      }),
      new Promise<void>((resolve) => setTimeout(() => resolve(), DOCUMENT_CHROMA_TIMEOUT_MS)),
    ]);

    const result = await Promise.race([
      collection.query({
        queryEmbeddings: [[...queryEmbedding]],
        nResults: limit,
        where: {
          filePath: documentSource.resolvedPath,
          sourceVersion: documentSource.sourceVersion,
        },
        include: ['documents'],
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DOCUMENT_CHROMA_TIMEOUT_MS)),
    ]);
    if (!result) {
      return Object.freeze({
        snippets: Object.freeze(localSnippets.length > 0 ? localSnippets : lexicalSnippets),
        ...(documentSource.format ? { format: documentSource.format } : {}),
        ...(typeof documentSource.pageCount === 'number' ? { pageCount: documentSource.pageCount } : {}),
      });
    }

    const chromaSnippets = (result.documents?.[0] ?? [])
      .map((document) => normalizeWhitespace(document ?? ''))
      .filter(Boolean)
      .slice(0, limit);
    const snippets = chromaSnippets.length > 0
      ? chromaSnippets
      : localSnippets.length > 0
        ? localSnippets
        : lexicalSnippets;
    return Object.freeze({
      snippets: Object.freeze(snippets),
      ...(documentSource.format ? { format: documentSource.format } : {}),
      ...(typeof documentSource.pageCount === 'number' ? { pageCount: documentSource.pageCount } : {}),
    });
  } catch {
    return Object.freeze({
      snippets: Object.freeze(lexicalSnippets),
      ...(documentSource.format ? { format: documentSource.format } : {}),
      ...(typeof documentSource.pageCount === 'number' ? { pageCount: documentSource.pageCount } : {}),
    });
  }
}
