import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ChromaClient } from 'chromadb';
import { ensureProjectStorage, getProjectStorageInfo } from '../context/project-store';
import { resolveChromaUrl } from '../context/chroma-manager';
import { embedTexts } from '../context/gemini-embeddings';
import { findFigmaImport } from '../figma/design-store';
import type { FigmaImportRecord } from '../figma/design-types';
import type { FigmaAttachment, LocalAttachmentPayload, MessageAttachment } from '../shared/protocol';
import { readDocumentFile } from '../tools/document-reader';

type AttachmentKind = 'file' | 'figma';
type AttachmentStatus = 'draft' | 'committed' | 'removed';
type AttachmentStorageKind = 'binary' | 'text-cache';

type AttachmentRecord = Readonly<{
  id: string;
  workspaceId: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  originalName: string;
  storedPath: string;
  storageKind?: AttachmentStorageKind;
  mimeType: string;
  size: number;
  previewPath?: string;
  figmaImportId?: string;
  createdAt: number;
  updatedAt: number;
  messageId?: string;
}>;

const MAX_CONTEXT_ATTACHMENTS = 4;
const MAX_ATTACHMENT_CHARS = 6_000;
const MAX_ATTACHMENT_SNIPPETS = 2;
const ATTACHMENT_CHUNK_TARGET_CHARS = 1_400;
const ATTACHMENT_CHUNK_MIN_CHARS = 240;
const ATTACHMENT_CHUNK_OVERLAP_CHARS = 180;
const ATTACHMENT_CHROMA_TIMEOUT_MS = 2_500;
const MANUAL_EMBEDDING_FUNCTION = Object.freeze({
  name: "galaxy-manual-embedding",
  async generate(): Promise<number[][]> {
    throw new Error("Manual embeddings only. Provide embeddings explicitly.");
  },
  async generateForQueries(): Promise<number[][]> {
    throw new Error("Manual embeddings only. Provide query embeddings explicitly.");
  },
});
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
  '.htm',
  '.sql',
  '.sh',
  '.py',
  '.java',
  '.kt',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.cs',
  '.swift',
  '.dart',
]);

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'attachment';
}

function loadIndex(workspacePath: string): AttachmentRecord[] {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  try {
    const raw = fs.readFileSync(storage.attachmentsIndexPath, 'utf-8');
    const parsed = JSON.parse(raw) as AttachmentRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getAttachmentStorageKind(record: AttachmentRecord): AttachmentStorageKind {
  return record.storageKind === 'text-cache' ? 'text-cache' : 'binary';
}

function normalizeAttachmentLookup(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\\/g, '/')
    .replace(/[^a-zA-Z0-9./_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function normalizeAttachmentKey(value: string): string {
  return normalizeAttachmentLookup(value).replace(/[^a-z0-9]+/g, '');
}

function computeEditDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j]!;
    }
  }

  return previous[b.length]!;
}

function computeCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function truncateContent(content: string): string {
  if (content.length <= MAX_ATTACHMENT_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_ATTACHMENT_CHARS)}\n...[truncated]`;
}

function normalizeWhitespace(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function buildAttachmentCollectionName(workspaceId: string): string {
  return `galaxy-attachment-chunks-v2-${workspaceId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
}

function createAttachmentChunkId(record: AttachmentRecord, sourceVersion: string, chunkIndex: number): string {
  return createHash('sha1')
    .update(`${record.id}:${record.storedPath}:${sourceVersion}:${chunkIndex}`)
    .digest('hex');
}

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

function buildAttachmentEmbeddingDocument(record: AttachmentRecord, chunkText: string, chunkIndex: number, chunkCount: number): string {
  return [
    `Attachment: ${record.originalName}`,
    `Stored path: ${record.storedPath}`,
    getAttachmentStorageKind(record) === 'text-cache' ? 'Storage kind: text-cache' : 'Storage kind: binary',
    `MIME type: ${record.mimeType}`,
    `Chunk ${chunkIndex + 1} of ${chunkCount}`,
    chunkText,
  ].join('\n');
}

function stripXmlTags(content: string): string {
  return content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSpecialAttachmentText(record: AttachmentRecord): string | null {
  const ext = path.extname(record.originalName).toLowerCase();

  try {
    if (process.platform === 'darwin' && (ext === '.docx' || ext === '.doc' || ext === '.rtf')) {
      return execFileSync('textutil', ['-convert', 'txt', '-stdout', record.storedPath], {
        encoding: 'utf-8',
        maxBuffer: 8 * 1024 * 1024,
      }).trim();
    }

    if (process.platform === 'darwin' && ext === '.pdf') {
      const text = execFileSync('mdls', ['-raw', '-name', 'kMDItemTextContent', record.storedPath], {
        encoding: 'utf-8',
        maxBuffer: 8 * 1024 * 1024,
      }).trim();
      return text === '(null)' ? null : text;
    }

    if (ext === '.docx') {
      const xml = execFileSync('unzip', ['-p', record.storedPath, 'word/document.xml'], {
        encoding: 'utf-8',
        maxBuffer: 8 * 1024 * 1024,
      });
      return stripXmlTags(xml);
    }

    if (ext === '.xlsx') {
      const xml = execFileSync('unzip', ['-p', record.storedPath, 'xl/sharedStrings.xml'], {
        encoding: 'utf-8',
        maxBuffer: 8 * 1024 * 1024,
      });
      return stripXmlTags(xml);
    }
  } catch {
    return null;
  }

  return null;
}

async function extractAttachmentText(record: AttachmentRecord): Promise<string | null> {
  if (getAttachmentStorageKind(record) === 'text-cache') {
    try {
      return fs.readFileSync(record.storedPath, 'utf-8');
    } catch {
      return null;
    }
  }

  if (isTextAttachment(record)) {
    try {
      return fs.readFileSync(record.storedPath, 'utf-8');
    } catch {
      return null;
    }
  }

  const parsed = await readDocumentFile(record.storedPath);
  if (parsed.success && parsed.content.trim()) {
    return parsed.content;
  }

  return extractSpecialAttachmentText(record);
}

function isTextAttachment(record: AttachmentRecord): boolean {
  if (record.kind === 'figma') {
    return false;
  }

  if (record.mimeType.startsWith('text/')) {
    return true;
  }

  if (
    record.mimeType.includes('json') ||
    record.mimeType.includes('xml') ||
    record.mimeType.includes('yaml') ||
    record.mimeType.includes('javascript') ||
    record.mimeType.includes('typescript')
  ) {
    return true;
  }

  const ext = path.extname(record.originalName).toLowerCase();
  return TEXT_ATTACHMENT_EXTENSIONS.has(ext);
}

async function extractAttachmentTextFromBuffer(opts: {
  name: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<string | null> {
  const ext = path.extname(opts.name).toLowerCase();

  if (
    opts.mimeType.startsWith('text/') ||
    opts.mimeType.includes('json') ||
    opts.mimeType.includes('xml') ||
    opts.mimeType.includes('yaml') ||
    opts.mimeType.includes('javascript') ||
    opts.mimeType.includes('typescript') ||
    TEXT_ATTACHMENT_EXTENSIONS.has(ext)
  ) {
    try {
      return opts.buffer.toString('utf-8');
    } catch {
      return null;
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-attachment-'));
  const tempPath = path.join(tempDir, `${sanitizeFileName(path.basename(opts.name, ext)) || 'attachment'}${ext}`);
  try {
    fs.writeFileSync(tempPath, opts.buffer);
    const parsed = await readDocumentFile(tempPath, { maxChars: Number.MAX_SAFE_INTEGER, offset: 0 });
    return parsed.success && parsed.content.trim() ? parsed.content : null;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}

function saveIndex(workspacePath: string, records: readonly AttachmentRecord[]): void {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  fs.writeFileSync(storage.attachmentsIndexPath, JSON.stringify(records, null, 2), 'utf-8');
}

function upsertRecord(workspacePath: string, record: AttachmentRecord): void {
  const existing = loadIndex(workspacePath).filter((item) => item.id !== record.id);
  existing.push(record);
  saveIndex(workspacePath, existing);
}

function readPreviewDataUrl(record: AttachmentRecord): string | undefined {
  const targetPath = record.previewPath ?? record.storedPath;
  if (!targetPath || !fs.existsSync(targetPath) || !record.mimeType.startsWith('image/')) {
    return undefined;
  }

  const contentBase64 = fs.readFileSync(targetPath).toString('base64');
  return `data:${record.mimeType};base64,${contentBase64}`;
}

function buildLocalAttachmentPayload(record: AttachmentRecord): LocalAttachmentPayload {
  return Object.freeze({
    attachmentId: record.id,
    name: record.originalName,
    mimeType: record.mimeType,
    isImage: record.mimeType.startsWith('image/'),
    ...(readPreviewDataUrl(record) ? { previewDataUrl: readPreviewDataUrl(record) } : {}),
  });
}

async function queryAttachmentSemanticSnippets(opts: {
  workspacePath: string;
  record: AttachmentRecord;
  queryText: string;
  limit: number;
}): Promise<readonly string[]> {
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
    const client = new ChromaClient({ path: chromaPath });
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
        where: {
          sourceId: opts.record.id,
          sourceVersion,
        },
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

function writePreviewAsset(storageDir: string, baseName: string, figmaRecord: FigmaImportRecord): { previewPath?: string; mimeType: string } {
  const asset = figmaRecord.document.assets?.find((item) => item.kind === 'svg' || item.kind === 'png');
  if (!asset?.contentBase64) {
    return { mimeType: 'application/x-figma+json' };
  }

  const extension = asset.kind === 'png' ? 'png' : 'svg';
  const mimeType = asset.kind === 'png' ? 'image/png' : 'image/svg+xml';
  const previewPath = path.join(storageDir, `${baseName}.${extension}`);
  fs.writeFileSync(previewPath, Buffer.from(asset.contentBase64, 'base64'));
  return { previewPath, mimeType };
}

export async function createDraftLocalAttachment(opts: {
  workspacePath: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}): Promise<LocalAttachmentPayload> {
  const storage = getProjectStorageInfo(opts.workspacePath);
  ensureProjectStorage(storage);

  const base64 = opts.dataUrl.split(',')[1] ?? '';
  const buffer = Buffer.from(base64, 'base64');
  const ext = path.extname(opts.name) || '';
  const baseName = `${sanitizeFileName(path.basename(opts.name, ext))}_${randomUUID().slice(0, 8)}`;
  const isImage = opts.mimeType.startsWith('image/');
  let storedPath: string;
  let storageKind: AttachmentStorageKind = 'binary';
  if (isImage) {
    storedPath = path.join(storage.attachmentsImagesDirPath, `${baseName}${ext}`);
    fs.writeFileSync(storedPath, buffer);
  } else {
    const extractedText = await extractAttachmentTextFromBuffer({
      name: opts.name,
      mimeType: opts.mimeType,
      buffer,
    });
    if (extractedText?.trim()) {
      storedPath = path.join(storage.attachmentsTextDirPath, `${baseName}.txt`);
      fs.writeFileSync(storedPath, extractedText, 'utf-8');
      storageKind = 'text-cache';
    } else {
      storedPath = path.join(storage.attachmentsFilesDirPath, `${baseName}${ext}`);
      fs.writeFileSync(storedPath, buffer);
    }
  }

  const record: AttachmentRecord = Object.freeze({
    id: `attachment-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId: storage.workspaceId,
    kind: 'file',
    status: 'draft',
    originalName: opts.name,
    storedPath,
    storageKind,
    mimeType: opts.mimeType || 'application/octet-stream',
    size: buffer.byteLength,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  upsertRecord(opts.workspacePath, record);
  return buildLocalAttachmentPayload(record);
}

export function createDraftFigmaAttachment(workspacePath: string, importId: string): FigmaAttachment | null {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  const figmaRecord = findFigmaImport(workspacePath, importId);
  if (!figmaRecord) {
    return null;
  }

  const baseName = `figma_${figmaRecord.importId}_${randomUUID().slice(0, 8)}`;
  const storedPath = path.join(storage.attachmentsFigmaDirPath, `${baseName}.jsonl`);
  fs.writeFileSync(storedPath, `${JSON.stringify(figmaRecord)}\n`, 'utf-8');

  const preview = writePreviewAsset(storage.attachmentsImagesDirPath, baseName, figmaRecord);
  const label = figmaRecord.document.selection[0]
    ? `${figmaRecord.document.selection[0].name} (${figmaRecord.document.selection[0].type})`
    : 'Design By Figma';
  const record: AttachmentRecord = Object.freeze({
    id: `attachment-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId: storage.workspaceId,
    kind: 'figma',
    status: 'draft',
    originalName: label,
    storedPath,
    mimeType: preview.mimeType,
    size: Buffer.byteLength(JSON.stringify(figmaRecord)),
    ...(preview.previewPath ? { previewPath: preview.previewPath } : {}),
    figmaImportId: figmaRecord.importId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  upsertRecord(workspacePath, record);

  return Object.freeze({
    attachmentId: record.id,
    importId: figmaRecord.importId,
    label,
    summary: figmaRecord.summary,
    ...(preview.previewPath && preview.mimeType.startsWith('image/')
      ? { previewDataUrl: readPreviewDataUrl(record) }
      : {}),
  });
}

function buildMessageAttachment(record: AttachmentRecord): MessageAttachment {
  const previewDataUrl = readPreviewDataUrl(record);
  return Object.freeze({
    attachmentId: record.id,
    kind:
      record.kind === 'figma'
        ? 'figma'
        : record.mimeType.startsWith('image/')
          ? 'image'
          : 'file',
    label: record.kind === 'figma' ? `Design By Figma` : record.originalName,
    ...(previewDataUrl ? { previewDataUrl } : {}),
    ...(record.figmaImportId ? { importId: record.figmaImportId } : {}),
  });
}

export function removeDraftAttachment(workspacePath: string, attachmentId: string): boolean {
  const records = loadIndex(workspacePath);
  const target = records.find((record) => record.id === attachmentId);
  if (!target || target.status !== 'draft') {
    return false;
  }

  if (fs.existsSync(target.storedPath)) {
    fs.unlinkSync(target.storedPath);
  }
  if (target.previewPath && target.previewPath !== target.storedPath && fs.existsSync(target.previewPath)) {
    fs.unlinkSync(target.previewPath);
  }

  saveIndex(workspacePath, records.filter((record) => record.id !== attachmentId));
  return true;
}

export function commitAttachments(workspacePath: string, attachmentIds: readonly string[], messageId: string): void {
  if (attachmentIds.length === 0) {
    return;
  }

  const updated = loadIndex(workspacePath).map((record) => (
    attachmentIds.includes(record.id)
      ? Object.freeze({
          ...record,
          status: 'committed' as const,
          messageId,
          updatedAt: Date.now(),
        })
      : record
  ));
  saveIndex(workspacePath, updated);
}

export function buildMessageAttachments(workspacePath: string, attachmentIds: readonly string[]): MessageAttachment[] {
  if (attachmentIds.length === 0) {
    return [];
  }

  const idSet = new Set(attachmentIds);
  return loadIndex(workspacePath)
    .filter((record) => idSet.has(record.id))
    .map((record) => buildMessageAttachment(record));
}

export function resolveAttachmentStoredPath(workspacePath: string, rawPath: string): string | null {
  const baseName = path.basename(rawPath);
  const target = normalizeAttachmentLookup(baseName);
  const targetKey = normalizeAttachmentKey(baseName);
  if (!target) {
    return null;
  }

  const records = loadIndex(workspacePath).filter((record) => record.status !== 'removed');
  const scoredMatches = records.map((record) => {
    const original = normalizeAttachmentLookup(record.originalName);
    const storedBase = normalizeAttachmentLookup(path.basename(record.storedPath));
    const originalKey = normalizeAttachmentKey(record.originalName);
    const storedKey = normalizeAttachmentKey(path.basename(record.storedPath));
    const candidates = [original, storedBase, originalKey, storedKey].filter(Boolean);
    let score = 0;

    for (const candidate of candidates) {
      if (candidate === target || candidate === targetKey) {
        score = Math.max(score, 100);
        continue;
      }
      if (candidate === originalKey || candidate === storedKey) {
        score = Math.max(score, 96);
      }
      if (targetKey.length >= 8 && (candidate.includes(targetKey) || targetKey.includes(candidate))) {
        score = Math.max(score, 84);
      }

      const prefixLength = computeCommonPrefixLength(candidate, targetKey);
      const prefixRatio = prefixLength / Math.max(candidate.length, targetKey.length, 1);
      if (prefixRatio >= 0.82) {
        score = Math.max(score, 72 + Math.round(prefixRatio * 10));
      }

      const distance = computeEditDistance(candidate, targetKey);
      if (Math.max(candidate.length, targetKey.length) >= 8 && distance <= 3) {
        score = Math.max(score, 78 - distance * 8);
      }
    }

    return Object.freeze({ record, score });
  })
    .filter((entry) => entry.score >= 64)
    .sort((a, b) => b.score - a.score || a.record.createdAt - b.record.createdAt);

  const [bestMatch, secondMatch] = scoredMatches;
  const match =
    bestMatch && (!secondMatch || bestMatch.score - secondMatch.score >= 8)
      ? bestMatch.record
      : null;

  if (!match || !fs.existsSync(match.storedPath)) {
    return null;
  }

  return match.storedPath;
}

export function buildAttachmentImagePaths(workspacePath: string, attachmentIds: readonly string[]): string[] {
  if (attachmentIds.length === 0) {
    return [];
  }

  const idSet = new Set(attachmentIds);
  return loadIndex(workspacePath)
    .filter((record) => idSet.has(record.id))
    .flatMap((record) => {
      if (record.kind === 'figma' && record.previewPath && fs.existsSync(record.previewPath)) {
        return [record.previewPath];
      }

      if (record.mimeType.startsWith('image/') && fs.existsSync(record.storedPath)) {
        return [record.storedPath];
      }

      return [];
    });
}

export async function buildAttachmentContextNote(
  workspacePath: string,
  attachmentIds: readonly string[],
  queryText = '',
): Promise<string> {
  if (attachmentIds.length === 0) {
    return '';
  }

  const idSet = new Set(attachmentIds);
  const records = loadIndex(workspacePath)
    .filter((record) => idSet.has(record.id))
    .filter((record) => record.kind !== 'figma')
    .slice(0, MAX_CONTEXT_ATTACHMENTS);

  if (records.length === 0) {
    return '';
  }

  const sections = await Promise.all(records.map(async (record) => {
    const semanticSnippets = await queryAttachmentSemanticSnippets({
      workspacePath,
      record,
      queryText,
      limit: MAX_ATTACHMENT_SNIPPETS,
    });
    if (semanticSnippets.length > 0) {
      return [
        `### ATTACHMENT: ${record.originalName}`,
        `Stored path: ${record.storedPath}`,
        `Semantic snippets most relevant to the current request:`,
        ...semanticSnippets.map((snippet, index) => `[Snippet ${index + 1}] ${snippet}`),
      ].join('\n');
    }

    const extractedText = await extractAttachmentText(record);
    if (extractedText?.trim()) {
      if (getAttachmentStorageKind(record) === 'text-cache') {
        return [
          `### ATTACHMENT: ${record.originalName}`,
          `Cached text path: ${record.storedPath}`,
          `Read file with path "${record.storedPath}".`,
          truncateContent(extractedText),
        ].join('\n');
      }
      if (!isTextAttachment(record)) {
        return [
          `### ATTACHMENT: ${record.originalName}`,
          `Stored path: ${record.storedPath}`,
          `Read document with path "${record.storedPath}".`,
          truncateContent(extractedText),
        ].join('\n');
      }
      return [
        `### ATTACHMENT: ${record.originalName}`,
        `Stored path: ${record.storedPath}`,
        `Read file with path "${record.storedPath}".`,
        truncateContent(extractedText),
      ].join('\n');
    }

    return [
      `### ATTACHMENT: ${record.originalName}`,
      `Stored path: ${record.storedPath}`,
      `Failed to read the attachment content.`,
    ].join('\n');
  }));

  return sections.length > 0
    ? `Attached files:\n${sections.join('\n\n')}`
    : '';
}
