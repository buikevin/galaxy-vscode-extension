import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ensureProjectStorage, getProjectStorageInfo } from '../context/project-store';
import { findFigmaImport } from '../figma/design-store';
import type { FigmaImportRecord } from '../figma/design-types';
import type { FigmaAttachment, LocalAttachmentPayload, MessageAttachment } from '../shared/protocol';
import { readDocumentFile } from '../tools/document-reader';

type AttachmentKind = 'file' | 'figma';
type AttachmentStatus = 'draft' | 'committed' | 'removed';

type AttachmentRecord = Readonly<{
  id: string;
  workspaceId: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  originalName: string;
  storedPath: string;
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

function truncateContent(content: string): string {
  if (content.length <= MAX_ATTACHMENT_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_ATTACHMENT_CHARS)}\n...[truncated]`;
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

export function createDraftLocalAttachment(opts: {
  workspacePath: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}): LocalAttachmentPayload {
  const storage = getProjectStorageInfo(opts.workspacePath);
  ensureProjectStorage(storage);

  const base64 = opts.dataUrl.split(',')[1] ?? '';
  const buffer = Buffer.from(base64, 'base64');
  const ext = path.extname(opts.name) || '';
  const baseName = `${sanitizeFileName(path.basename(opts.name, ext))}_${randomUUID().slice(0, 8)}`;
  const targetDir = opts.mimeType.startsWith('image/') ? storage.attachmentsImagesDirPath : storage.attachmentsFilesDirPath;
  const storedPath = path.join(targetDir, `${baseName}${ext}`);
  fs.writeFileSync(storedPath, buffer);

  const record: AttachmentRecord = Object.freeze({
    id: `attachment-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId: storage.workspaceId,
    kind: 'file',
    status: 'draft',
    originalName: opts.name,
    storedPath,
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
  const match = records.find((record) => {
    const original = normalizeAttachmentLookup(record.originalName);
    const storedBase = normalizeAttachmentLookup(path.basename(record.storedPath));
    const originalKey = normalizeAttachmentKey(record.originalName);
    const storedKey = normalizeAttachmentKey(path.basename(record.storedPath));
    return (
      original === target ||
      storedBase === target ||
      originalKey === targetKey ||
      storedKey === targetKey ||
      (targetKey.length >= 8 && (originalKey.includes(targetKey) || targetKey.includes(originalKey))) ||
      (targetKey.length >= 8 && (storedKey.includes(targetKey) || targetKey.includes(storedKey)))
    );
  });

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

export async function buildAttachmentContextNote(workspacePath: string, attachmentIds: readonly string[]): Promise<string> {
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
    if (!isTextAttachment(record)) {
      const parsed = await readDocumentFile(record.storedPath);
      const extractedText = parsed.success && parsed.content.trim()
        ? parsed.content
        : extractSpecialAttachmentText(record);
      if (extractedText?.trim()) {
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
        `Read document with path "${record.storedPath}".`,
        `A non-text attachment is included (${record.mimeType}). Its binary content could not be extracted into plain text for the prompt.`,
      ].join('\n');
    }

    try {
      const raw = fs.readFileSync(record.storedPath, 'utf-8');
      return [
        `### ATTACHMENT: ${record.originalName}`,
        `Stored path: ${record.storedPath}`,
        `Read file with path "${record.storedPath}".`,
        truncateContent(raw),
      ].join('\n');
    } catch {
      return [
        `### ATTACHMENT: ${record.originalName}`,
        `Stored path: ${record.storedPath}`,
        `Failed to read the attachment content.`,
      ].join('\n');
    }
  }));

  return sections.length > 0
    ? `Attached files:\n${sections.join('\n\n')}`
    : '';
}
