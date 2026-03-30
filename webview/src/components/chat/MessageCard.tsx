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
  const isUser = props.message.role === "user";
  const isTool = props.message.role === "tool";
  const wrapperClassName = isTool
    ? "mr-auto max-w-[90%] max-[620px]:max-w-full"
    : isUser
      ? `ml-auto max-w-[82%] max-[620px]:max-w-[96%] ${props.pending ? "opacity-70" : ""}`
      : "mr-auto max-w-[90%] max-[620px]:max-w-full";
  const cardClassName = isUser
    ? "rounded-2xl border border-[color:var(--gc-accent)]/18 bg-[var(--gc-accent-soft)] px-4 py-3 text-[color:var(--gc-foreground)] shadow-[0_8px_22px_rgba(0,0,0,0.12)] max-[620px]:rounded-xl max-[620px]:px-3 max-[620px]:py-2.5"
    : "rounded-2xl bg-[var(--gc-surface-elevated)] px-4 py-3 text-[color:var(--gc-foreground)] shadow-[0_6px_18px_rgba(0,0,0,0.10)] max-[620px]:rounded-xl max-[620px]:px-3 max-[620px]:py-2.5";
  const metaClassName = isUser
    ? "text-[color:color-mix(in_srgb,var(--gc-foreground)_72%,transparent)]"
    : "text-[color:var(--gc-muted)]";

  return (
    <div className={`w-full min-w-0 max-w-full overflow-x-hidden ${wrapperClassName}`}>
      {props.message.role !== "tool" ? (
        <div className={cardClassName}>
          <div className={`mb-2 flex items-center justify-between gap-3 text-[11px] max-[520px]:items-start max-[520px]:gap-2 ${metaClassName}`}>
            <div className="flex min-w-0 items-center gap-2 max-[520px]:flex-wrap">
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em]">
                {props.titleLabel}
              </span>
              {props.pending ? (
                <span className="rounded-full bg-[color:color-mix(in_srgb,var(--gc-surface)_92%,transparent)] px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal">
                  Đang gửi
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2 max-[520px]:shrink-0">
              <span className="whitespace-nowrap text-[10px]">{props.timestampLabel}</span>
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface)] hover:text-[color:var(--gc-foreground)]"
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
          {props.attachmentsContent}
          {props.body}
        </div>
      ) : (
        <>
          {props.attachmentsContent}
          {props.body}
        </>
      )}
    </div>
  );
}
