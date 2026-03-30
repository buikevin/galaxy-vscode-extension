/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Reusable shell command card that keeps chat lightweight and opens the native VS Code terminal for full output.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, SquareTerminal } from "lucide-react";
import { Button } from "@webview/components/ui/button";

/**
 * Props for the streamed shell panel.
 */
type ShellPanelProps = Readonly<{
  /** Stable panel id, usually the tool message id. */
  panelId: string;
  /** Exact command rendered in the header. */
  commandText: string;
  /** Effective cwd for the command. */
  cwd: string;
  /** Streamed stdout/stderr content accumulated so far. */
  output: string;
  /** Optional terminal title when the host created a native VS Code terminal. */
  terminalTitle?: string;
  /** Final command success state when available. */
  success?: boolean;
  /** Final exit code when available. */
  exitCode?: number;
  /** Preformatted duration label shown in the UI. */
  durationLabel?: string;
  /** Whether the command is still running. */
  running?: boolean;
  /** Whether the panel should start expanded from the parent state. */
  defaultExpanded?: boolean;
  /** Whether the copy button is in copied state. */
  copied: boolean;
  /** Copy command text into clipboard. */
  onCopy: () => void;
  /** Reveal the native VS Code terminal for this command. */
  onViewTerminal: () => void;
  /** Ref callback used by the parent for auto-scrolling shell output. */
  onOutputNode: (node: HTMLDivElement | null) => void;
}>;

/**
 * Render the live shell output card used by run_project_command results.
 */
export function ShellPanel(props: ShellPanelProps) {
  const [expanded, setExpanded] = useState(
    Boolean(props.defaultExpanded ?? props.running)
  );
  const previousRunningRef = useRef(Boolean(props.running));
  const commandLabel = props.commandText || "lệnh không xác định";
  const summaryLabel = props.running
    ? `Đang chạy ${commandLabel}${props.durationLabel ? ` trong ${props.durationLabel}` : ""}`
    : props.durationLabel
      ? `${props.success === false ? "Lệnh lỗi" : "Đã chạy"} ${commandLabel} trong ${props.durationLabel}`
      : `${props.success === false ? "Lệnh lỗi" : "Đã chạy"} ${commandLabel}`;
  const statusSummary = props.running
    ? "Đang stream output mới nhất. Mở terminal để xem toàn bộ output."
    : props.success
      ? "Lệnh đã hoàn tất. Mở terminal để xem đầy đủ output."
      : "Lệnh đã kết thúc lỗi. Mở terminal để xem đầy đủ output.";
  const outputPreview = useMemo(() => {
    const normalized = props.output.replace(/\r\n/g, "\n").trimEnd();
    if (!normalized) {
      return "";
    }
    return normalized.split("\n").slice(-8).join("\n").slice(-2400);
  }, [props.output]);
  const hasOutputPreview = outputPreview.length > 0;
  const shouldShowBody = expanded && (props.running || hasOutputPreview);

  useEffect(() => {
    if (props.running && hasOutputPreview) {
      setExpanded(true);
    } else if (previousRunningRef.current) {
      setExpanded(false);
    }
    previousRunningRef.current = Boolean(props.running);
  }, [hasOutputPreview, props.running]);

  return (
    <div className="max-w-full min-w-0 overflow-x-hidden">
      <div className="rounded-xl bg-[color:color-mix(in_srgb,var(--gc-surface)_82%,transparent)]">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => {
              if (!props.running && !hasOutputPreview) {
                return;
              }
              setExpanded((current) => !current);
            }}
          >
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--gc-accent)_14%,transparent)] text-[color:var(--gc-accent)]">
              <SquareTerminal className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-[color:var(--gc-foreground)]">
                {summaryLabel}
              </div>
              {props.running && props.cwd ? (
                <div className="truncate text-xs text-[color:var(--gc-muted)]">
                  {props.cwd}
                </div>
              ) : null}
            </div>
            {typeof props.exitCode === "number" ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  props.exitCode === 0
                    ? "bg-emerald-500/10 text-emerald-300"
                    : "bg-rose-500/10 text-rose-300"
                }`}
              >
                mã thoát {props.exitCode}
              </span>
            ) : props.running ? (
              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
                đang chạy
              </span>
            ) : null}
            {props.running || hasOutputPreview ? (
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  expanded ? "rotate-180" : ""
                }`}
              />
            ) : null}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 w-8 rounded-full border-0 bg-transparent p-0 text-[color:var(--gc-muted)] shadow-none hover:bg-[var(--gc-surface)] hover:text-[color:var(--gc-foreground)]"
              onClick={props.onViewTerminal}
              title="Mở terminal"
            >
              <SquareTerminal className="w-4 h-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 w-8 rounded-full border-0 bg-transparent p-0 text-[color:var(--gc-muted)] shadow-none hover:bg-[var(--gc-surface)] hover:text-[color:var(--gc-foreground)]"
              onClick={props.onCopy}
              title={props.copied ? "Đã copy" : "Copy lệnh"}
            >
              {props.copied ? (
                <Check className="w-4 h-4" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
        {shouldShowBody ? (
          <div className="space-y-2 px-3 pb-3 pt-1">
            <div className="rounded-xl bg-[color:color-mix(in_srgb,var(--gc-surface-elevated)_88%,transparent)] px-3 py-2">
              <div className="overflow-x-auto whitespace-nowrap font-mono text-sm text-slate-200">
                $ {commandLabel}
              </div>
              {props.terminalTitle ? (
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  terminal: {props.terminalTitle}
                </div>
              ) : null}
              <div className="mt-2 text-sm leading-6 text-slate-300">
                {statusSummary}
              </div>
            </div>
            {hasOutputPreview ? (
              <div className="overflow-hidden rounded-xl bg-[#111214]">
                <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-6 text-slate-300 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {outputPreview}
                </pre>
              </div>
            ) : null}
            <div ref={props.onOutputNode} className="hidden" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
