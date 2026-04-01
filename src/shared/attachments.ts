/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared attachment entities used by attachment storage, prompt context, and semantic retrieval.
 */

import type { FigmaImportRecord } from './figma';
import type { FigmaAttachment, LocalAttachmentPayload, MessageAttachment } from './protocol';

/** Persisted attachment category stored in workspace metadata. */
export type AttachmentKind = 'file' | 'figma';

/** Lifecycle state of one stored attachment. */
export type AttachmentStatus = 'draft' | 'committed' | 'removed';

/** Physical storage mode used for one attachment payload. */
export type AttachmentStorageKind = 'binary' | 'text-cache';

/** One persisted attachment record stored in the attachment index. */
export type AttachmentRecord = Readonly<{
  /** Stable attachment identifier used across transcript and storage. */
  id: string;
  /** Workspace id that owns the attachment. */
  workspaceId: string;
  /** Attachment category used for downstream behavior. */
  kind: AttachmentKind;
  /** Current attachment lifecycle state. */
  status: AttachmentStatus;
  /** Original user-provided attachment name. */
  originalName: string;
  /** Absolute path where the attachment payload is stored. */
  storedPath: string;
  /** Storage mode used for the payload. */
  storageKind?: AttachmentStorageKind;
  /** Browser-reported or synthesized MIME type. */
  mimeType: string;
  /** Raw payload size in bytes. */
  size: number;
  /** Optional preview asset path for images and Figma previews. */
  previewPath?: string;
  /** Optional linked Figma import id for Figma-backed attachments. */
  figmaImportId?: string;
  /** Unix timestamp in milliseconds when the record was created. */
  createdAt: number;
  /** Unix timestamp in milliseconds when the record was last updated. */
  updatedAt: number;
  /** Optional message id once the attachment is committed into chat history. */
  messageId?: string;
}>;

/** Input used when extracting text from an in-memory attachment buffer. */
export type AttachmentBufferInput = Readonly<{
  /** Original file name used to infer extension and storage name. */
  name: string;
  /** MIME type reported by the webview or browser. */
  mimeType: string;
  /** Raw attachment bytes. */
  buffer: Buffer;
}>;

/** Query options used to retrieve semantic snippets for one attachment. */
export type AttachmentSemanticQueryOptions = Readonly<{
  /** Workspace root owning the attachment store. */
  workspacePath: string;
  /** Attachment record to index and query. */
  record: AttachmentRecord;
  /** Free-text query describing the current user request. */
  queryText: string;
  /** Maximum number of snippets to return. */
  limit: number;
}>;

/** Temporary preview asset information generated for a Figma import. */
export type AttachmentPreviewAsset = Readonly<{
  /** Optional preview asset path when a preview file was generated. */
  previewPath?: string;
  /** MIME type associated with the preview asset or fallback payload. */
  mimeType: string;
}>;

export type {
  FigmaAttachment,
  FigmaImportRecord,
  LocalAttachmentPayload,
  MessageAttachment,
};
