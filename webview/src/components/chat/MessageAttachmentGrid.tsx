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
    <div className="mb-2 flex flex-wrap gap-2">
      {props.attachments.map((attachment) => (
        <div
          key={`${attachment.attachmentId}-${attachment.label}`}
          className="grid min-w-0 max-w-full grid-cols-[36px_minmax(0,1fr)] items-center gap-2 rounded-xl bg-[color:color-mix(in_srgb,var(--gc-surface)_88%,transparent)] px-2.5 py-2 text-xs text-foreground"
        >
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-[var(--gc-surface-elevated)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--gc-surface-elevated)_92%,white_4%)]"
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
          <div className="min-w-0">
            <div
              className="truncate text-[12px] font-medium text-[color:var(--gc-foreground)]"
              title={attachment.label}
            >
              {attachment.label}
            </div>
            <div className="text-[10px] uppercase tracking-[0.08em] text-[color:var(--gc-muted)]">
              {attachment.kind}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
