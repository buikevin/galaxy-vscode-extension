/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Transcript card used to render the assistant response while it is still streaming.
 */

import { Spinner } from "@webview/components/ui/spinner";

/**
 * Props required to render the in-flight assistant response.
 */
type StreamingAssistantCardProps = Readonly<{
  /** Assistant label resolved from the currently selected agent. */
  titleLabel: string;
  /** Streaming assistant content accumulated so far. */
  content: string;
}>;

/**
 * Render one assistant card while the response is still streaming.
 */
export function StreamingAssistantCard(props: StreamingAssistantCardProps) {
  return (
    <div className="mr-auto w-full min-w-0 max-w-[96%] overflow-x-hidden rounded-xl border border-border/60 bg-background/80 px-3 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        <span>{props.titleLabel}</span>
        <Spinner size="sm" />
      </div>
      <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
        {props.content}
      </div>
    </div>
  );
}
