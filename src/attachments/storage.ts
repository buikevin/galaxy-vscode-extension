/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Attachment storage helpers for reading and updating the workspace attachment index.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureProjectStorage, getProjectStorageInfo } from '../context/project-store';
import type { AttachmentRecord, AttachmentStorageKind, LocalAttachmentPayload, MessageAttachment } from '../shared/attachments';

/**
 * Sanitizes a user-provided file name for safe on-disk storage.
 *
 * @param value Raw file name.
 * @returns File-system-safe base name.
 */
export function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'attachment';
}

/**
 * Loads the attachment index for one workspace.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @returns Parsed attachment records, or an empty list when the index is missing or invalid.
 */
export function loadIndex(workspacePath: string): AttachmentRecord[] {
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

/**
 * Persists the attachment index for one workspace.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param records Attachment records to persist.
 */
export function saveIndex(workspacePath: string, records: readonly AttachmentRecord[]): void {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  fs.writeFileSync(storage.attachmentsIndexPath, JSON.stringify(records, null, 2), 'utf-8');
}

/**
 * Inserts or replaces one attachment record in the workspace index.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param record Attachment record to upsert.
 */
export function upsertRecord(workspacePath: string, record: AttachmentRecord): void {
  const existing = loadIndex(workspacePath).filter((item) => item.id !== record.id);
  existing.push(record);
  saveIndex(workspacePath, existing);
}

/**
 * Normalizes optional storage kind values into a stable concrete storage mode.
 *
 * @param record Attachment record being inspected.
 * @returns Concrete storage kind used by downstream helpers.
 */
export function getAttachmentStorageKind(record: AttachmentRecord): AttachmentStorageKind {
  return record.storageKind === 'text-cache' ? 'text-cache' : 'binary';
}

/**
 * Reads the preview data URL for one stored attachment when a preview asset exists.
 *
 * @param record Attachment record being rendered.
 * @returns Data URL for the preview asset when available.
 */
export function readPreviewDataUrl(record: AttachmentRecord): string | undefined {
  const targetPath = record.previewPath ?? record.storedPath;
  if (!targetPath || !fs.existsSync(targetPath) || !record.mimeType.startsWith('image/')) {
    return undefined;
  }

  const contentBase64 = fs.readFileSync(targetPath).toString('base64');
  return `data:${record.mimeType};base64,${contentBase64}`;
}

/**
 * Builds the lightweight webview payload for one local attachment record.
 *
 * @param record Attachment record being surfaced to the UI.
 * @returns Webview-ready attachment payload.
 */
export function buildLocalAttachmentPayload(record: AttachmentRecord): LocalAttachmentPayload {
  const previewDataUrl = readPreviewDataUrl(record);
  return Object.freeze({
    attachmentId: record.id,
    name: record.originalName,
    mimeType: record.mimeType,
    isImage: record.mimeType.startsWith('image/'),
    ...(previewDataUrl ? { previewDataUrl } : {}),
  });
}

/**
 * Builds one transcript attachment descriptor from a stored attachment record.
 *
 * @param record Attachment record being attached to a message.
 * @returns Transcript attachment descriptor.
 */
export function buildMessageAttachment(record: AttachmentRecord): MessageAttachment {
  const previewDataUrl = readPreviewDataUrl(record);
  return Object.freeze({
    attachmentId: record.id,
    kind: record.kind === 'figma' ? 'figma' : record.mimeType.startsWith('image/') ? 'image' : 'file',
    label: record.kind === 'figma' ? 'Design By Figma' : record.originalName,
    ...(previewDataUrl ? { previewDataUrl } : {}),
    ...(record.figmaImportId ? { importId: record.figmaImportId } : {}),
  });
}

/**
 * Removes one draft attachment and its stored payloads from disk.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param attachmentId Attachment id to remove.
 * @returns `true` when the draft attachment existed and was removed.
 */
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

/**
 * Marks draft attachments as committed once a message is persisted.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param attachmentIds Attachment ids to mark as committed.
 * @param messageId Transcript message id that owns the attachments.
 */
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

/**
 * Resolves transcript attachment descriptors for a set of attachment ids.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param attachmentIds Attachment ids attached to the current message.
 * @returns Transcript attachment descriptors in index order.
 */
export function buildMessageAttachments(workspacePath: string, attachmentIds: readonly string[]): MessageAttachment[] {
  if (attachmentIds.length === 0) {
    return [];
  }

  const idSet = new Set(attachmentIds);
  return loadIndex(workspacePath)
    .filter((record) => idSet.has(record.id))
    .map((record) => buildMessageAttachment(record));
}

/**
 * Resolves stored image paths for attachments that can be passed to multimodal models.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param attachmentIds Attachment ids attached to the current message.
 * @returns Absolute image paths for previewable attachments.
 */
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
