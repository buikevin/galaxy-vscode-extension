/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Collapsible wrapper for grouped assistant actions rendered in the transcript.
 */

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Props used to render one grouped action card.
 */
type ActionGroupCardProps = Readonly<{
  /** Whether the grouped actions are currently expanded. */
  expanded: boolean;
  /** Number of action items inside the group. */
  actionCount: number;
  /** Preview icons rendered in the collapsed header. */
  previewIcons: readonly ReactNode[];
  /** Action bodies rendered when the group is expanded. */
  children: ReactNode;
  /** Toggle collapse/expand state. */
  onToggle: () => void;
}>;

/**
 * Render one collapsible action group in the transcript.
 */
export function ActionGroupCard(props: ActionGroupCardProps) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex w-full min-w-0 items-center justify-between rounded-[5px] border border-white/10 bg-white/5 px-3 py-1 text-left"
        onClick={props.onToggle}
      >
        <div className="flex items-center min-w-0 gap-2">
          <div className="flex items-center">{props.previewIcons}</div>
          <span className="min-w-0 max-w-full break-all text-sm font-medium text-foreground [overflow-wrap:anywhere]">
            {props.expanded ? "Thu gọn" : `${props.actionCount} actions`}
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
            props.expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      {props.expanded ? <div className="space-y-2">{props.children}</div> : null}
    </div>
  );
}
