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
  /** Short summary shown in the activity header. */
  summaryLabel: string;
  /** Action bodies rendered when the group is expanded. */
  children: ReactNode;
  /** Short textual summaries rendered inside the expanded activity log. */
  summaryRows: readonly ReactNode[];
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
        className="flex w-full min-w-0 items-center justify-between rounded-xl bg-[color:color-mix(in_srgb,var(--gc-surface)_82%,transparent)] px-3 py-2 text-left transition-colors hover:bg-[var(--gc-surface)]"
        onClick={props.onToggle}
      >
        <div className="min-w-0 flex-1 overflow-hidden pr-3">
          <span className="block min-w-0 truncate text-sm font-medium text-[color:var(--gc-foreground)]">
            {props.summaryLabel}
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-[color:var(--gc-muted)] transition-transform ${
            props.expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      {props.expanded ? (
        <div className="space-y-1 pl-1">
          {props.summaryRows.map((row, index) => (
            <div
              key={`summary-${index}`}
              className="rounded-lg px-2 py-1.5 text-left"
            >
              {row}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
