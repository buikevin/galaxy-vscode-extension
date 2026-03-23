/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Summary card for session file changes with keep, revert, and review actions.
 */

import { Check, ExternalLink, Undo2 } from "lucide-react";
import type { ChangeSummary } from "@shared/protocol";

/**
 * Props for the change summary action card.
 */
type ChangeSummaryCardProps = Readonly<{
  /** Current aggregate change summary from the host. */
  summary: ChangeSummary;
  /** Mark the current diff snapshot as accepted and hide the card. */
  onKeep: () => void;
  /** Revert all tracked changes for the current session. */
  onRevertAll: () => void;
  /** Open the dedicated review/diff experience. */
  onReview: () => void;
}>;

/**
 * Render the change summary box shown above the composer.
 */
export function ChangeSummaryCard(props: ChangeSummaryCardProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/70 px-4 py-3">
      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">
          {props.summary.createdCount > 0
            ? `${props.summary.fileCount} file thay đổi • ${props.summary.createdCount} file mới`
            : `${props.summary.fileCount} file thay đổi`}
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="text-emerald-400">+{props.summary.addedLines}</span>
          <span className="mx-2 text-rose-400">-{props.summary.deletedLines}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
          onClick={props.onKeep}
        >
          <Check className="h-4 w-4" />
          <span>Keep</span>
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
          onClick={props.onRevertAll}
        >
          <Undo2 className="h-4 w-4" />
          <span>Revert</span>
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
          onClick={props.onReview}
        >
          <span>Review</span>
          <ExternalLink className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
