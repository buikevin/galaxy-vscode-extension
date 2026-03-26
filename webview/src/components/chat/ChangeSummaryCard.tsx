/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Summary card for session file changes with keep, revert, and Galaxy Diff actions.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, ExternalLink, Sparkles, Undo2, X } from "lucide-react";
import type { ChangeSummary, ReviewFinding } from "@shared/protocol";

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
  /** Open the dedicated Galaxy Diff experience. */
  onReview: () => void;
  /** Latest persisted review findings, if any. */
  reviewFindings?: readonly ReviewFinding[];
  /** Dismiss one review finding. */
  onDismissReviewFinding: (findingId: string) => void;
  /** Ask the host to apply one review finding. */
  onApplyReviewFinding: (findingId: string) => void;
}>;

/**
 * Render the change summary box shown above the composer.
 */
export function ChangeSummaryCard(props: ChangeSummaryCardProps) {
  const openFindings = useMemo(
    () =>
      (props.reviewFindings ?? []).filter(
        (finding) => (finding.status ?? "open") !== "dismissed"
      ),
    [props.reviewFindings]
  );
  const [activeFindingIndex, setActiveFindingIndex] = useState(0);

  useEffect(() => {
    if (openFindings.length === 0) {
      setActiveFindingIndex(0);
      return;
    }
    if (activeFindingIndex >= openFindings.length) {
      setActiveFindingIndex(0);
    }
  }, [activeFindingIndex, openFindings.length]);

  const activeFinding =
    openFindings.length > 0 ? openFindings[activeFindingIndex] : null;

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-background/70 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
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
            <span>Galaxy Diff</span>
            <ExternalLink className="h-4 w-4" />
          </button>
        </div>
      </div>
      {activeFinding ? (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-500/5 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-amber-300">
                <Sparkles className="h-3.5 w-3.5" />
                <span>
                  Review finding {activeFindingIndex + 1}/{openFindings.length}
                </span>
              </div>
              <div className="text-sm font-medium text-foreground">
                [{activeFinding.severity.toUpperCase()}] {activeFinding.location}
              </div>
              <div className="text-sm text-muted-foreground">
                {activeFinding.message}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
                onClick={() =>
                  setActiveFindingIndex((current) =>
                    openFindings.length === 0
                      ? 0
                      : (current + 1) % openFindings.length
                  )
                }
              >
                <span>Next</span>
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
                onClick={() => props.onDismissReviewFinding(activeFinding.id)}
              >
                <X className="h-4 w-4" />
                <span>Dismiss</span>
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full bg-sky-500/20 px-2 py-1 text-sm text-sky-200 transition-colors hover:bg-sky-500/30"
                onClick={() => props.onApplyReviewFinding(activeFinding.id)}
              >
                <Sparkles className="h-4 w-4" />
                <span>Apply</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
