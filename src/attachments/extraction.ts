/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Attachment text extraction helpers for direct text files, converted documents, and preview assets.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocumentFile } from '../tools/document-reader';
import { TEXT_ATTACHMENT_EXTENSIONS } from '../shared/constants';
import type { AttachmentBufferInput, AttachmentPreviewAsset, AttachmentRecord, AttachmentStorageKind, FigmaImportRecord } from '../shared/attachments';
import { getAttachmentStorageKind, sanitizeFileName } from './storage';

/**
 * Removes XML tags and common entities from extracted office-document XML.
 *
 * @param content Raw XML text.
 * @returns Flattened plain-text approximation.
 */
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

/**
 * Determines whether an attachment can be treated as a plain-text file.
 *
 * @param record Attachment record being inspected.
 * @returns `true` when direct UTF-8 reads should work.
 */
export function isTextAttachment(record: AttachmentRecord): boolean {
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

/**
 * Extracts text with platform-specific fallbacks for office and PDF attachments.
 *
 * @param record Attachment record being converted.
 * @returns Extracted text when a special-case converter succeeds.
 */
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

/**
 * Extracts text content from one stored attachment record.
 *
 * @param record Attachment record being read.
 * @returns Extracted text when the attachment can be read or converted.
 */
export async function extractAttachmentText(record: AttachmentRecord): Promise<string | null> {
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

/**
 * Extracts text directly from an in-memory attachment buffer before persisting it.
 *
 * @param opts Attachment buffer input to inspect.
 * @returns Extracted text when the buffer can be read or converted.
 */
export async function extractAttachmentTextFromBuffer(opts: AttachmentBufferInput): Promise<string | null> {
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

/**
 * Writes a preview asset for a Figma import when embedded PNG or SVG content exists.
 *
 * @param storageDir Directory where preview assets should be stored.
 * @param baseName Base file name for generated preview assets.
 * @param figmaRecord Persisted Figma import record.
 * @returns Preview asset information used for attachment records.
 */
export function writePreviewAsset(storageDir: string, baseName: string, figmaRecord: FigmaImportRecord): AttachmentPreviewAsset {
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
