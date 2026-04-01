/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Facade for draft attachment persistence, Figma attachment creation, and prompt context assembly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureProjectStorage, getProjectStorageInfo } from '../context/project-store';
import { findFigmaImport } from '../figma/design-store';
import {
  MAX_ATTACHMENT_SNIPPETS,
  MAX_CONTEXT_ATTACHMENTS,
} from '../shared/constants';
import type { AttachmentRecord, AttachmentStorageKind, FigmaAttachment, FigmaImportRecord, LocalAttachmentPayload, MessageAttachment } from '../shared/attachments';
import { extractAttachmentText, extractAttachmentTextFromBuffer, isTextAttachment, writePreviewAsset } from './extraction';
import { resolveAttachmentStoredPath } from './lookup';
import { queryAttachmentSemanticSnippets, truncateContent } from './semantic';
import {
  buildAttachmentImagePaths,
  buildLocalAttachmentPayload,
  buildMessageAttachments,
  commitAttachments,
  getAttachmentStorageKind,
  loadIndex,
  readPreviewDataUrl,
  removeDraftAttachment,
  sanitizeFileName,
  upsertRecord,
} from './storage';

/**
 * Creates and stores one draft local attachment from a webview data URL payload.
 *
 * @param opts Workspace root and uploaded attachment payload.
 * @returns Webview-ready local attachment metadata.
 */
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
    const extractedText = await extractAttachmentTextFromBuffer({ name: opts.name, mimeType: opts.mimeType, buffer });
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

/**
 * Creates and stores one draft Figma attachment that points at an imported Figma record.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param importId Figma import id to attach.
 * @returns Figma attachment metadata for the transcript, or `null` when the import is missing.
 */
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

/**
 * Builds the prompt block for all non-Figma attachments attached to the current turn.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param attachmentIds Attachment ids attached to the current turn.
 * @param queryText Optional free-text query used for semantic snippet selection.
 * @returns Prompt-ready attachment context block.
 */
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

  return sections.length > 0 ? `Attached files:\n${sections.join('\n\n')}` : '';
}

export {
  buildAttachmentImagePaths,
  buildMessageAttachments,
  commitAttachments,
  removeDraftAttachment,
  resolveAttachmentStoredPath,
};

export type { FigmaAttachment, FigmaImportRecord, LocalAttachmentPayload, MessageAttachment };
