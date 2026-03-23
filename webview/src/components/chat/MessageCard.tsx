/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Reusable wrapper for transcript message cards rendered in the Galaxy Code chat view.
 */

import type { ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import type { ChatMessage } from "@shared/protocol";

/**
 * Props used to render one transcript message card.
 */
type MessageCardProps = Readonly<{
  /** Source message currently rendered. */
  message: ChatMessage;
  /** Whether the message content is expanded. */
  expanded: boolean;
  /** Whether the message is still pending delivery. */
  pending?: boolean;
  /** Header label shown for non-tool messages. */
  titleLabel: string;
  /** Preformatted local time shown in the card header. */
  timestampLabel: string;
  /** Optional attachment block rendered above the message body. */
  attachmentsContent?: ReactNode;
  /** Main message body content. */
  body: ReactNode;
  /** Toggle expand/collapse state. */
  onToggleExpand: () => void;
}>;

/**
 * Render one chat transcript card with shared layout and controls.
 */
export function MessageCard(props: MessageCardProps) {
  const className =
    props.message.role === "user"
      ? `ml-auto max-w-[92%] rounded-xl border border-primary/30 bg-primary/10 px-3 py-3 ${
          props.pending ? "opacity-50" : ""
        }`
      : props.message.role === "tool"
        ? "mr-auto max-w-[96%]"
        : "mr-auto max-w-[96%] rounded-xl border border-border/60 bg-background/80 px-3 py-3";

  return (
    <div className={`w-full min-w-0 max-w-full overflow-x-hidden ${className}`}>
      {props.message.role !== "tool" ? (
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          <span>{props.titleLabel}</span>
          <div className="flex items-center gap-2">
            {props.pending ? (
              <span className="normal-case tracking-normal text-[12px] text-sky-300">
                Đang gửi...
              </span>
            ) : null}
            <span>{props.timestampLabel}</span>
            <button
              type="button"
              className="inline-flex items-center justify-center w-4 h-4 transition-colors text-muted-foreground hover:text-foreground"
              onClick={props.onToggleExpand}
              title={props.expanded ? "Thu gọn" : "Phóng to"}
            >
              {props.expanded ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      ) : null}
      {props.attachmentsContent}
      {props.body}
    </div>
  );
}
