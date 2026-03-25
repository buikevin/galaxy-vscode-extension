/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Reusable shell command card that keeps chat lightweight and opens the native VS Code terminal for full output.
 */

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
  /** Whether the panel body is expanded. */
  expanded: boolean;
  /** Whether the copy button is in copied state. */
  copied: boolean;
  /** Toggle collapse/expand state. */
  onToggle: () => void;
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
  const statusSummary = props.running
    ? "Lệnh đang chạy trong terminal của VS Code. Bấm View để xem output trực tiếp."
    : props.success
      ? "Lệnh đã hoàn tất. Bấm View để xem output đầy đủ trong terminal."
      : "Lệnh đã kết thúc lỗi. Bấm View để xem output đầy đủ trong terminal.";

  return (
    <div className="max-w-full min-w-0 space-y-2 overflow-x-hidden">
      <div className="px-1 text-xs font-medium text-muted-foreground">
        {props.running
          ? `Running command${props.durationLabel ? ` for ${props.durationLabel}` : ""}`
          : props.durationLabel
            ? `${props.success ? "Command finished in" : "Command failed after"} ${props.durationLabel}`
            : props.success
              ? "Command finished"
              : "Command failed"}
      </div>
      <div className="overflow-hidden rounded-[22px] border border-white/10 bg-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <button
          type="button"
          className="flex w-full items-center justify-between bg-white/[0.05] px-4 py-3 text-left"
          onClick={props.onToggle}
        >
          <div className="flex items-center min-w-0 gap-3">
            <span className="text-base font-semibold text-foreground">Shell</span>
            {typeof props.exitCode === "number" ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  props.exitCode === 0
                    ? "bg-emerald-500/10 text-emerald-300"
                    : "bg-rose-500/10 text-rose-300"
                }`}
              >
                exit {props.exitCode}
              </span>
            ) : props.running ? (
              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
                live
              </span>
            ) : null}
          </div>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              props.expanded ? "rotate-180" : ""
            }`}
          />
        </button>
        {props.expanded ? (
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="overflow-x-auto whitespace-nowrap font-mono text-sm text-slate-200">
                  $ {props.commandText || "(unknown command)"}
                </div>
                {props.cwd ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    cwd: {props.cwd}
                  </div>
                ) : null}
                {props.terminalTitle ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    terminal: {props.terminalTitle}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="rounded-full shrink-0"
                  onClick={props.onViewTerminal}
                >
                  <SquareTerminal className="w-4 h-4" />
                  <span>View</span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="rounded-full shrink-0"
                  onClick={props.onCopy}
                >
                  {props.copied ? (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      <span>Copy</span>
                    </>
                  )}
                </Button>
              </div>
            </div>
            <div
              ref={props.onOutputNode}
              className="rounded-xl border border-white/10 bg-[#151515] px-4 py-3 shadow-[inset_0_1px_18px_rgba(255,255,255,0.03)]"
            >
              <div className="space-y-2">
                <div className="text-sm leading-6 text-slate-300">
                  {statusSummary}
                </div>
                {props.output.trim() ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-slate-400 [overflow-wrap:anywhere]">
                    {props.output}
                  </pre>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
