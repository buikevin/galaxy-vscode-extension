/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Reusable transcript card for assistant thinking blocks, including streamed thinking state.
 */

import { ChevronDown } from "lucide-react";

/**
 * Props required to render a thinking card.
 */
type ThinkingCardProps = Readonly<{
  /** Stable key owned by the parent expand/collapse state. */
  panelId: string;
  /** Whether the thinking content is currently expanded. */
  expanded: boolean;
  /** Thinking text shown inside the body. */
  content: string;
  /** Toggle collapse/expand state. */
  onToggle: () => void;
  /** Whether this is a live streaming thinking block. */
  streaming?: boolean;
}>;

/**
 * Render one collapsible thinking block in the transcript.
 */
export function ThinkingCard(props: ThinkingCardProps) {
  return (
    <div className="max-w-full min-w-0 overflow-x-hidden">
      <button
        type="button"
        className="flex w-full min-w-0 items-center justify-between px-0.5 py-0.5 text-left"
        onClick={props.onToggle}
      >
        <div className="min-w-0 text-[11px] tracking-[0.04em] text-[color:color-mix(in_srgb,var(--gc-muted)_88%,transparent)]">
          {props.streaming ? "thinking..." : "Thinking"}
        </div>
        <div className="flex items-center gap-1">
          <ChevronDown
            className={`h-3.5 w-3.5 text-[color:color-mix(in_srgb,var(--gc-muted)_88%,transparent)] transition-transform ${
              props.expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>
      {props.expanded ? (
        <div className="max-h-36 max-w-full overflow-auto px-0.5 pb-1 pt-0.5">
          <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-words text-[11px] leading-5 text-[color:var(--gc-muted)] [overflow-wrap:anywhere]">
            {props.content}
          </div>
        </div>
      ) : null}
    </div>
  );
}
