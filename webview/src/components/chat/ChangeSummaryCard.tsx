/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Summary card for session file changes with keep, revert, and Galaxy Diff actions.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, ExternalLink, FileText, Sparkles, Undo2, X } from "lucide-react";
import type { ChangeSummary, ReviewFinding } from "@shared/protocol";
import type { WebviewMessage } from "@shared/protocol";
import { postHostMessage } from "@webview/vscode";

type PreviewRow =
  | Readonly<{ type: "collapsed"; count: number }>
  | Readonly<{
      type: "line";
      kind: "unchanged" | "modified" | "deleted" | "added";
      leftNumber: number | null;
      rightNumber: number | null;
      leftText: string;
      rightText: string;
    }>;

function buildPreviewRows(file: ChangeSummary["files"][number]): readonly PreviewRow[] {
  const originalLines = (file.originalContent ?? "").split("\n");
  const currentLines = (file.currentContent ?? "").split("\n");

  if (file.wasNew) {
    return Object.freeze(
      currentLines.map(
        (line, index): PreviewRow =>
          Object.freeze({
            type: "line",
            kind: "added",
            leftNumber: null,
            rightNumber: index + 1,
            leftText: "",
            rightText: line,
          })
      )
    );
  }

  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < currentLines.length &&
    originalLines[prefix] === currentLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < currentLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] ===
      currentLines[currentLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const rows: PreviewRow[] = [];
  if (prefix > 0) {
    rows.push(Object.freeze({ type: "collapsed", count: prefix }));
  }

  const originalChanged = originalLines.slice(prefix, originalLines.length - suffix);
  const currentChanged = currentLines.slice(prefix, currentLines.length - suffix);
  const maxChanged = Math.max(originalChanged.length, currentChanged.length);

  for (let index = 0; index < maxChanged; index += 1) {
    const leftText = originalChanged[index];
    const rightText = currentChanged[index];
    rows.push(
      Object.freeze({
        type: "line",
        kind:
          typeof leftText === "string" && typeof rightText === "string"
            ? "modified"
            : typeof leftText === "string"
              ? "deleted"
              : "added",
        leftNumber: typeof leftText === "string" ? prefix + index + 1 : null,
        rightNumber: typeof rightText === "string" ? prefix + index + 1 : null,
        leftText: leftText ?? "",
        rightText: rightText ?? "",
      })
    );
  }

  if (suffix > 0) {
    rows.push(Object.freeze({ type: "collapsed", count: suffix }));
  }

  if (rows.length === 0) {
    rows.push(
      Object.freeze({
        type: "line",
        kind: "unchanged",
        leftNumber: 1,
        rightNumber: 1,
        leftText: originalLines[0] ?? "",
        rightText: currentLines[0] ?? "",
      })
    );
  }

  return Object.freeze(rows);
}

function getVisiblePreviewRows(rows: readonly PreviewRow[], maxRows = 10): readonly PreviewRow[] {
  if (rows.length <= maxRows) {
    return rows;
  }

  const visible = rows.slice(0, maxRows - 1);
  const hiddenCount = rows.length - visible.length;
  return Object.freeze([
    ...visible,
    Object.freeze({ type: "collapsed", count: hiddenCount }),
  ]);
}

function renderPreviewLine(
  row: Extract<PreviewRow, { type: "line" }>,
  key: string
) {
  if (row.kind === "unchanged") {
    return (
      <div
        key={key}
        className="grid grid-cols-[40px_12px_minmax(0,1fr)] items-start gap-0 font-mono text-[12px] leading-6 text-[color:var(--gc-muted)]"
      >
        <div className="select-none px-3 text-right text-[color:color-mix(in_srgb,var(--gc-muted)_70%,transparent)]">
          {row.rightNumber ?? row.leftNumber ?? ""}
        </div>
        <div className="select-none text-center"> </div>
        <div className="min-w-0 overflow-hidden px-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {row.rightText || row.leftText}
        </div>
      </div>
    );
  }

  if (row.kind === "modified") {
    return (
      <div key={key} className="space-y-px">
        <div className="grid grid-cols-[40px_12px_minmax(0,1fr)] items-start gap-0 bg-rose-500/8 font-mono text-[12px] leading-6 text-rose-200">
          <div className="select-none px-3 text-right text-rose-300/80">
            {row.leftNumber ?? ""}
          </div>
          <div className="select-none text-center text-rose-300">-</div>
          <div className="min-w-0 overflow-hidden px-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {row.leftText}
          </div>
        </div>
        <div className="grid grid-cols-[40px_12px_minmax(0,1fr)] items-start gap-0 bg-emerald-500/10 font-mono text-[12px] leading-6 text-emerald-200">
          <div className="select-none px-3 text-right text-emerald-300/80">
            {row.rightNumber ?? ""}
          </div>
          <div className="select-none text-center text-emerald-300">+</div>
          <div className="min-w-0 overflow-hidden px-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {row.rightText}
          </div>
        </div>
      </div>
    );
  }

  const isAdded = row.kind === "added";
  return (
    <div
      key={key}
      className={`grid grid-cols-[40px_12px_minmax(0,1fr)] items-start gap-0 font-mono text-[12px] leading-6 ${
        isAdded
          ? "bg-emerald-500/10 text-emerald-200"
          : "bg-rose-500/8 text-rose-200"
      }`}
    >
      <div
        className={`select-none px-3 text-right ${
          isAdded ? "text-emerald-300/80" : "text-rose-300/80"
        }`}
      >
        {isAdded ? (row.rightNumber ?? "") : (row.leftNumber ?? "")}
      </div>
      <div
        className={`select-none text-center ${
          isAdded ? "text-emerald-300" : "text-rose-300"
        }`}
      >
        {isAdded ? "+" : "-"}
      </div>
      <div className="min-w-0 overflow-hidden px-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {isAdded ? row.rightText : row.leftText}
      </div>
    </div>
  );
}

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

  return (
    <div className="space-y-3 rounded-xl border border-[color:var(--gc-border)] bg-[var(--gc-surface)] px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-sm font-medium text-[color:var(--gc-foreground)]">
            {props.summary.createdCount > 0
              ? `${props.summary.fileCount} file thay đổi • ${props.summary.createdCount} file mới`
              : `${props.summary.fileCount} file thay đổi`}
          </div>
          <div className="text-xs text-[color:var(--gc-muted)]">
            <span className="text-emerald-400">+{props.summary.addedLines}</span>
            <span className="mx-2 text-rose-400">-{props.summary.deletedLines}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-[color:var(--gc-border)] bg-transparent px-2.5 py-1 text-sm text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
            onClick={props.onKeep}
          >
            <Check className="h-4 w-4" />
            <span>Keep</span>
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-[color:var(--gc-border)] bg-transparent px-2.5 py-1 text-sm text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
            onClick={props.onRevertAll}
          >
            <Undo2 className="h-4 w-4" />
            <span>Revert</span>
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-[color:var(--gc-border)] bg-transparent px-2.5 py-1 text-sm text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
            onClick={props.onReview}
          >
            <span>Galaxy Diff</span>
            <ExternalLink className="h-4 w-4" />
          </button>
        </div>
      </div>

      {props.summary.files.length > 0 ? (
        <div className="space-y-1">
          {props.summary.files.slice(0, 8).map((file) => (
            <div
              key={file.filePath}
              className="overflow-hidden rounded-xl bg-[color:color-mix(in_srgb,var(--gc-surface-elevated)_90%,transparent)]"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-[color:color-mix(in_srgb,var(--gc-border)_70%,transparent)] px-3 py-2">
                <div className="min-w-0">
                  <div
                    className="truncate text-sm font-medium text-[color:var(--gc-foreground)]"
                    title={file.label}
                  >
                    {file.label}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-[color:var(--gc-muted)]">
                  <span className="text-emerald-400">+{file.addedLines}</span>
                  {!file.wasNew ? (
                    <span className="mx-1 text-rose-400">-{file.deletedLines}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface)] hover:text-[color:var(--gc-foreground)]"
                  onClick={() =>
                    file.wasNew ? openFile(file.filePath) : openNativeDiff(file.filePath)
                  }
                  title={file.wasNew ? "Mở file" : "Mở diff native"}
                >
                  {file.wasNew ? (
                    <FileText className="h-4 w-4" />
                  ) : (
                    <ExternalLink className="h-4 w-4" />
                  )}
                </button>
              </div>
              <div className="overflow-hidden bg-[#111214]">
                {getVisiblePreviewRows(buildPreviewRows(file)).map((row, index) =>
                  row.type === "collapsed" ? (
                    <div
                      key={`${file.filePath}-collapsed-${index}`}
                      className="px-3 py-2 text-xs text-[color:var(--gc-muted)]"
                    >
                      {row.count} dòng khác không đổi
                    </div>
                  ) : (
                    renderPreviewLine(row, `${file.filePath}-line-${index}`)
                  )
                )}
              </div>
            </div>
          ))}
          {props.summary.files.length > 8 ? (
            <div className="px-2 pt-1 text-xs text-[color:var(--gc-muted)]">
              +{props.summary.files.length - 8} file nữa
            </div>
          ) : null}
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
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-[color:var(--gc-border)] bg-transparent px-2 py-1 text-sm text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
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
                className="inline-flex items-center gap-1 rounded-full border border-[color:var(--gc-border)] bg-transparent px-2 py-1 text-sm text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
                onClick={() => props.onDismissReviewFinding(activeFinding.id)}
              >
                <X className="h-4 w-4" />
                <span>Dismiss</span>
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-[color:var(--gc-accent)]/30 bg-[var(--gc-accent-soft)] px-2 py-1 text-sm text-[color:var(--gc-accent)] transition-colors hover:opacity-90"
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
