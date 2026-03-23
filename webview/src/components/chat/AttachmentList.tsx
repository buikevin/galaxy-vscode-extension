/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Composer attachment list for Figma imports and local file/image attachments.
 */

import { FileText, Image as ImageIcon, X } from "lucide-react";
import type { FigmaAttachment } from "@shared/protocol";
import type { LocalAttachment } from "@webview/entities/attachments";

type AttachmentListProps = Readonly<{
  /** Attached Figma design imports shown as design chips. */
  figmaAttachments: readonly FigmaAttachment[];
  /** Locally attached files/images pending send. */
  localAttachments: readonly LocalAttachment[];
  /** Open preview for a Figma attachment. */
  onOpenFigmaPreview: (attachment: FigmaAttachment) => void;
  /** Remove a Figma attachment from the composer. */
  onRemoveFigmaAttachment: (importId: string) => void;
  /** Open preview for a local attachment if available. */
  onOpenLocalPreview: (attachment: LocalAttachment) => void;
  /** Remove a local attachment from the composer. */
  onRemoveLocalAttachment: (attachmentId: string) => void;
}>;

/**
 * Render the list of composer attachments above the textarea.
 */
export function AttachmentList(props: AttachmentListProps) {
  if (props.figmaAttachments.length === 0 && props.localAttachments.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-2 rounded-xl border border-sky-400/20 bg-sky-500/5 p-2">
      {props.figmaAttachments.map((attachment) => (
        <div
          key={attachment.importId}
          className="flex items-center justify-between gap-3 rounded-2xl border border-sky-400/30 bg-background/70 px-3 py-2 text-xs text-foreground"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-300">
              <ImageIcon className="h-4 w-4" />
            </div>
            <button
              type="button"
              className="truncate text-left font-medium text-sky-300 hover:text-sky-200"
              onClick={() => props.onOpenFigmaPreview(attachment)}
            >
              Design By Figma
            </button>
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => props.onRemoveFigmaAttachment(attachment.importId)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      {props.localAttachments.map((attachment) => (
        <div
          key={attachment.attachmentId}
          className="grid grid-cols-[40px_minmax(0,1fr)_20px] items-center gap-3 rounded-2xl border border-white/10 bg-background/70 px-3 py-2 text-xs text-foreground"
        >
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white/5"
            onClick={() => props.onOpenLocalPreview(attachment)}
            disabled={!attachment.previewUrl}
            title={attachment.previewUrl ? "Xem preview" : attachment.name}
          >
            {attachment.previewUrl ? (
              <img
                src={attachment.previewUrl}
                alt={attachment.name}
                className="h-full w-full object-cover"
              />
            ) : attachment.isImage ? (
              <ImageIcon className="h-4 w-4 text-muted-foreground" />
            ) : (
              <FileText className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          <div className="truncate text-sm" title={attachment.name}>
            {attachment.name}
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => props.onRemoveLocalAttachment(attachment.attachmentId)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
