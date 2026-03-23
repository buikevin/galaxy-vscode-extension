/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Grid renderer for message-level attachments shown above transcript message content.
 */

import { FileText, Image as ImageIcon } from "lucide-react";
import type { MessageAttachment } from "@shared/protocol";

/**
 * Props required to render message attachments inside transcript cards.
 */
type MessageAttachmentGridProps = Readonly<{
  /** Attachments already associated with the rendered transcript message. */
  attachments: readonly MessageAttachment[];
  /** Open the preview modal for one attachment. */
  onOpenPreview: (attachment: MessageAttachment) => void;
}>;

/**
 * Render transcript-level attachments as previewable chips.
 */
export function MessageAttachmentGrid(props: MessageAttachmentGridProps) {
  return (
    <div className="grid grid-cols-1 gap-2 p-2 mb-2 border rounded-xl border-sky-400/20 bg-sky-500/5">
      {props.attachments.map((attachment) => (
        <div
          key={`${attachment.attachmentId}-${attachment.label}`}
          className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 rounded-2xl border border-white/10 bg-background/70 px-3 py-2 text-xs text-foreground"
        >
          <button
            type="button"
            className="flex items-center justify-center w-10 h-10 overflow-hidden rounded-xl bg-white/5"
            disabled={!attachment.previewDataUrl}
            onClick={() => props.onOpenPreview(attachment)}
            title={attachment.previewDataUrl ? "Xem preview" : attachment.label}
          >
            {attachment.previewDataUrl ? (
              <img
                src={attachment.previewDataUrl}
                alt={attachment.label}
                className="object-cover w-full h-full"
              />
            ) : attachment.kind === "figma" || attachment.kind === "image" ? (
              <ImageIcon className="w-4 h-4 text-muted-foreground" />
            ) : (
              <FileText className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
          <div className="text-sm truncate" title={attachment.label}>
            {attachment.label}
          </div>
        </div>
      ))}
    </div>
  );
}
