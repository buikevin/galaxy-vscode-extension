/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-04-03
 * @desc Compact summary card for tracked workspace changes shown above the composer.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  FileText,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import type { ChangeSummary, ReviewFinding } from "@shared/protocol";
import type { WebviewMessage } from "@shared/protocol";
import { postHostMessage } from "@webview/vscode";

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

function formatSummaryLabel(summary: ChangeSummary): string {
  return summary.createdCount > 0
    ? `${summary.fileCount} file thay đổi • ${summary.createdCount} file mới`
    : `${summary.fileCount} file thay đổi`;
}

function getFileDisplayLabel(file: ChangeSummary["files"][number]): string {
  return file.label || file.filePath.split(/[\\/]/).pop() || file.filePath;
}

function getFileSecondaryLabel(file: ChangeSummary["files"][number]): string {
  const label = file.label || file.filePath;
  const segments = label.split("/");
  if (segments.length <= 1) {
    return "";
  }
  return segments.slice(0, -1).join("/");
}

export function ChangeSummaryCard(props: ChangeSummaryCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [keptFilePaths, setKeptFilePaths] = useState<string[]>([]);

  const openFindings = useMemo(
    () =>
      (props.reviewFindings ?? []).filter(
        (finding) => (finding.status ?? "open") !== "dismissed"
      ),
    [props.reviewFindings]
  );
  const [activeFindingIndex, setActiveFindingIndex] = useState(0);

  useEffect(() => {
    setKeptFilePaths([]);
  }, [props.summary]);

  useEffect(() => {
    if (openFindings.length === 0) {
      setActiveFindingIndex(0);
      return;
    }
    if (activeFindingIndex >= openFindings.length) {
      setActiveFindingIndex(0);
    }
  }, [activeFindingIndex, openFindings.length]);

  const visibleFiles = useMemo(
    () =>
      props.summary.files.filter((file) => !keptFilePaths.includes(file.filePath)),
    [keptFilePaths, props.summary.files]
  );

  const visibleSummary = useMemo<ChangeSummary>(
    () => ({
      ...props.summary,
      fileCount: visibleFiles.length,
      createdCount: visibleFiles.filter((file) => file.wasNew).length,
      addedLines: visibleFiles.reduce((total, file) => total + file.addedLines, 0),
      deletedLines: visibleFiles.reduce((total, file) => total + file.deletedLines, 0),
      files: visibleFiles,
    }),
    [props.summary, visibleFiles]
  );

  useEffect(() => {
    if (props.summary.fileCount > 0 && visibleFiles.length === 0) {
      props.onKeep();
    }
  }, [props, visibleFiles.length]);

  const activeFinding =
    openFindings.length > 0 ? openFindings[activeFindingIndex] : null;

  function openNativeDiff(filePath: string): void {
    postHostMessage({
      type: "file-diff",
      payload: { filePath },
    } satisfies WebviewMessage);
  }

  function openFile(filePath: string): void {
    postHostMessage({
      type: "file-open",
      payload: { filePath },
    } satisfies WebviewMessage);
  }

  function revertFile(filePath: string): void {
    postHostMessage({
      type: "revert-file-change",
      payload: { filePath },
    } satisfies WebviewMessage);
  }

  function keepFile(filePath: string): void {
    setKeptFilePaths((current) =>
      current.includes(filePath) ? current : [...current, filePath]
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-[color:var(--gc-border)] bg-[var(--gc-surface)] px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setCollapsed((current) => !current)}
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-[color:var(--gc-muted)] transition-transform ${
              collapsed ? "-rotate-90" : "rotate-0"
            }`}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-[color:var(--gc-foreground)]">
              <span>{formatSummaryLabel(visibleSummary)}</span>
              <span className="text-emerald-400">+{visibleSummary.addedLines}</span>
              <span className="text-rose-400">-{visibleSummary.deletedLines}</span>
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-lg border border-[color:var(--gc-border)] px-2.5 text-sm text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
            onClick={props.onKeep}
            title="Giữ thay đổi hiện tại"
          >
            Keep
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-lg border border-[color:var(--gc-border)] px-2.5 text-sm text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
            onClick={props.onRevertAll}
            title="Hoàn tác toàn bộ thay đổi"
          >
            Undo
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--gc-border)] text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface-elevated)] hover:text-[color:var(--gc-foreground)]"
            onClick={props.onReview}
            title="Mở Galaxy Diff"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!collapsed && visibleSummary.files.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[color:color-mix(in_srgb,var(--gc-border)_70%,transparent)] bg-[color:color-mix(in_srgb,var(--gc-surface-elevated)_86%,transparent)]">
          <div className="max-h-[248px] overflow-y-auto">
            {visibleSummary.files.map((file) => (
              <button
                key={file.filePath}
                type="button"
                className="group flex w-full items-center gap-3 border-b border-[color:color-mix(in_srgb,var(--gc-border)_60%,transparent)] px-3 py-2.5 text-left last:border-b-0 hover:bg-[color:color-mix(in_srgb,var(--gc-surface)_92%,transparent)]"
                onClick={() =>
                  file.wasNew ? openFile(file.filePath) : openNativeDiff(file.filePath)
                }
                title={file.filePath}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <FileText className="h-4 w-4 shrink-0 text-[color:var(--gc-muted)]" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[color:var(--gc-foreground)]">
                      {getFileDisplayLabel(file)}
                    </div>
                    {getFileSecondaryLabel(file) ? (
                      <div className="truncate text-xs text-[color:var(--gc-muted)]">
                        {getFileSecondaryLabel(file)}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="shrink-0 text-sm tabular-nums">
                  <span className="text-emerald-400">+{file.addedLines}</span>
                  {!file.wasNew ? (
                    <span className="ml-2 text-rose-400">-{file.deletedLines}</span>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface)] hover:text-emerald-300"
                    onClick={(event) => {
                      event.stopPropagation();
                      keepFile(file.filePath);
                    }}
                    title="Giữ file này"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface)] hover:text-rose-300"
                    onClick={(event) => {
                      event.stopPropagation();
                      revertFile(file.filePath);
                    }}
                    title="Hoàn tác file này"
                  >
                    <Undo2 className="h-4 w-4" />
                  </button>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {activeFinding ? (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/5 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-amber-300">
                <Sparkles className="h-3.5 w-3.5" />
                <span>
                  Review finding {activeFindingIndex + 1}/{openFindings.length}
                </span>
              </div>
              <div className="text-sm font-medium text-[color:var(--gc-foreground)]">
                [{activeFinding.severity.toUpperCase()}] {activeFinding.location}
              </div>
              <div className="text-sm text-[color:var(--gc-muted)]">
                {activeFinding.message}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-lg border border-[color:var(--gc-border)] px-2.5 text-sm text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
                onClick={() =>
                  setActiveFindingIndex((current) =>
                    openFindings.length === 0
                      ? 0
                      : (current + 1) % openFindings.length
                  )
                }
              >
                Next
              </button>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--gc-border)] text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface-elevated)] hover:text-[color:var(--gc-foreground)]"
                onClick={() => props.onDismissReviewFinding(activeFinding.id)}
                title="Bỏ qua finding này"
              >
                <X className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--gc-accent)]/30 bg-[var(--gc-accent-soft)] text-[color:var(--gc-accent)] transition-colors hover:opacity-90"
                onClick={() => props.onApplyReviewFinding(activeFinding.id)}
                title="Áp dụng finding này"
              >
                <Sparkles className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
