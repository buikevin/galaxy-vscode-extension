/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Reusable transcript card for assistant thinking blocks, including streamed thinking state.
 */

import { Brain, ChevronDown } from "lucide-react";
import { Spinner } from "@webview/components/ui/spinner";

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
        className={`flex items-center justify-between w-full min-w-0 px-3 py-2 text-left border  border-border/60 bg-background/50${props.expanded ? " rounded-t-[8px]" : " rounded-[8px]"}`}
        onClick={props.onToggle}
      >
        <div className="flex items-center min-w-0 gap-2 text-sm font-medium text-foreground">
          <Brain className="w-4 h-4 text-violet-300" />
          <span>Thinking</span>
        </div>
        <div className="flex items-center gap-2">
          {props.streaming ? (
            <Spinner size="sm" className="h-3.5 w-3.5 border-[1.5px]" />
          ) : null}
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              props.expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>
      {props.expanded ? (
        <div className="max-w-full p-3 overflow-auto border rounded-b-[8x] max-h-36 border-border/60 bg-background/60">
          <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">
            {props.content}
          </div>
        </div>
      ) : null}
    </div>
  );
}
