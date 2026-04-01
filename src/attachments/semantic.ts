/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Attachment semantic indexing helpers backed by Gemini embeddings and Chroma.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { getProjectStorageInfo } from '../context/project-store';
import { createChromaClient, resolveChromaUrl } from '../context/chroma-manager';
import { embedTexts } from '../context/gemini-embeddings';
import {
  ATTACHMENT_CHROMA_TIMEOUT_MS,
  ATTACHMENT_CHUNK_MIN_CHARS,
  ATTACHMENT_CHUNK_OVERLAP_CHARS,
  ATTACHMENT_CHUNK_TARGET_CHARS,
  MANUAL_EMBEDDING_FUNCTION,
  MAX_ATTACHMENT_CHARS,
} from '../shared/constants';
import type { AttachmentRecord, AttachmentSemanticQueryOptions } from '../shared/attachments';
import { extractAttachmentText } from './extraction';
import { getAttachmentStorageKind } from './storage';

/**
 * Truncates large attachment content for prompt display.
 *
 * @param content Raw attachment content.
 * @returns Prompt-safe content snippet.
 */
export function truncateContent(content: string): string {
  if (content.length <= MAX_ATTACHMENT_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_ATTACHMENT_CHARS)}\n...[truncated]`;
}

/**
 * Normalizes whitespace in extracted attachment text before chunking or indexing.
 *
 * @param content Raw extracted text.
 * @returns Whitespace-normalized text.
 */
function normalizeWhitespace(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

/**
 * Builds the Chroma collection name used for attachment chunks in one workspace.
 *
 * @param workspaceId Stable workspace identifier.
 * @returns Lowercase Chroma collection name.
 */
function buildAttachmentCollectionName(workspaceId: string): string {
  return `galaxy-attachment-chunks-v2-${workspaceId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
}

/**
 * Builds a stable chunk id for one attachment text chunk.
 *
 * @param record Attachment record owning the chunk.
 * @param sourceVersion Version string derived from file mtime and size.
 * @param chunkIndex Zero-based chunk index.
 * @returns Stable hash id for Chroma upserts.
 */
function createAttachmentChunkId(record: AttachmentRecord, sourceVersion: string, chunkIndex: number): string {
  return createHash('sha1').update(`${record.id}:${record.storedPath}:${sourceVersion}:${chunkIndex}`).digest('hex');
}

/**
 * Splits one attachment text payload into overlapping semantic chunks.
 *
 * @param content Raw attachment text.
 * @returns Frozen list of prompt-safe chunks.
 */
function chunkAttachmentContent(content: string): readonly string[] {
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
    if (next.length <= ATTACHMENT_CHUNK_TARGET_CHARS || current.length < ATTACHMENT_CHUNK_MIN_CHARS) {
      current = next;
      return;
    }
    chunks.push(current);
    current = current.slice(-ATTACHMENT_CHUNK_OVERLAP_CHARS) + paragraph;
  });
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return Object.freeze(chunks.map((chunk) => chunk.trim()).filter(Boolean));
}

/**
 * Builds the embedding document string for one attachment chunk.
 *
 * @param record Attachment record owning the chunk.
 * @param chunkText Raw chunk text.
 * @param chunkIndex Zero-based chunk index.
 * @param chunkCount Total number of chunks.
 * @returns Embedding document text sent to Gemini.
 */
function buildAttachmentEmbeddingDocument(
  record: AttachmentRecord,
  chunkText: string,
  chunkIndex: number,
  chunkCount: number,
): string {
  return [
    `Attachment: ${record.originalName}`,
    `Stored path: ${record.storedPath}`,
    getAttachmentStorageKind(record) === 'text-cache' ? 'Storage kind: text-cache' : 'Storage kind: binary',
    `MIME type: ${record.mimeType}`,
    `Chunk ${chunkIndex + 1} of ${chunkCount}`,
    chunkText,
  ].join('\n');
}

/**
 * Queries semantic snippets for one attachment by indexing the latest extracted text into Chroma.
 *
 * @param opts Semantic retrieval options.
 * @returns Most relevant snippets for the current user request.
 */
export async function queryAttachmentSemanticSnippets(
  opts: AttachmentSemanticQueryOptions,
): Promise<readonly string[]> {
  const query = opts.queryText.trim();
  if (!query) {
    return Object.freeze([]);
  }

  const chromaPath = await resolveChromaUrl(opts.workspacePath);
  if (!chromaPath) {
    return Object.freeze([]);
  }

  const storage = getProjectStorageInfo(opts.workspacePath);
  const stat = fs.statSync(opts.record.storedPath);
  const sourceVersion = `${stat.mtimeMs}:${stat.size}`;
  const rawContent = await extractAttachmentText(opts.record);
  const normalizedContent = rawContent ? normalizeWhitespace(rawContent) : '';
  if (!normalizedContent) {
    return Object.freeze([]);
  }

  const chunks = chunkAttachmentContent(normalizedContent);
  if (chunks.length === 0) {
    return Object.freeze([]);
  }

  try {
    const client = createChromaClient(chromaPath);
    const collection = await Promise.race([
      client.getOrCreateCollection({
        name: buildAttachmentCollectionName(storage.workspaceId),
        embeddingFunction: MANUAL_EMBEDDING_FUNCTION,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ATTACHMENT_CHROMA_TIMEOUT_MS)),
    ]);
    if (!collection) {
      return Object.freeze([]);
    }

    const embeddingInputs = chunks.map((chunk, chunkIndex) =>
      buildAttachmentEmbeddingDocument(opts.record, chunk, chunkIndex, chunks.length),
    );
    const embeddings = await embedTexts(embeddingInputs, 'RETRIEVAL_DOCUMENT');
    if (!embeddings || embeddings.length !== chunks.length) {
      return Object.freeze([]);
    }

    await Promise.race([
      collection.upsert({
        ids: chunks.map((_, chunkIndex) => createAttachmentChunkId(opts.record, sourceVersion, chunkIndex)),
        documents: chunks.map((chunk) => truncateContent(chunk)),
        embeddings: embeddings.map((embedding) => [...embedding]),
        metadatas: chunks.map((_, chunkIndex) => ({
          sourceId: opts.record.id,
          sourceVersion,
          storedPath: opts.record.storedPath,
          originalName: opts.record.originalName,
          mimeType: opts.record.mimeType,
          chunkIndex,
          chunkCount: chunks.length,
        })),
      }),
      new Promise<void>((resolve) => setTimeout(() => resolve(), ATTACHMENT_CHROMA_TIMEOUT_MS)),
    ]);

    const queryEmbedding = (await embedTexts([query], 'RETRIEVAL_QUERY'))?.[0] ?? null;
    if (!queryEmbedding) {
      return Object.freeze([]);
    }

    const result = await Promise.race([
      collection.query({
        queryEmbeddings: [[...queryEmbedding]],
        nResults: Math.max(1, opts.limit),
        where: { sourceId: opts.record.id, sourceVersion },
        include: ['documents', 'distances'],
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ATTACHMENT_CHROMA_TIMEOUT_MS)),
    ]);
    if (!result) {
      return Object.freeze([]);
    }

    const snippets = (result.documents?.[0] ?? [])
      .map((document) => normalizeWhitespace(document ?? ''))
      .filter(Boolean)
      .slice(0, opts.limit);
    return Object.freeze(snippets);
  } catch {
    return Object.freeze([]);
  }
}
