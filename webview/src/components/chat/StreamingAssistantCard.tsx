/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Transcript card used to render the assistant response while it is still streaming.
 */

/**
 * Props required to render the in-flight assistant response.
 */
type StreamingAssistantCardProps = Readonly<{
  /** Streaming assistant content accumulated so far. */
  content: string;
}>;

/**
 * Render one assistant card while the response is still streaming.
 */
export function StreamingAssistantCard(props: StreamingAssistantCardProps) {
  return (
    <div className="mr-auto w-full min-w-0 max-w-[90%] overflow-x-hidden px-1 py-1 text-[color:var(--gc-foreground)] max-[620px]:max-w-full">
      <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-words text-[13px] leading-7 text-[color:var(--gc-foreground)] [overflow-wrap:anywhere]">
        {props.content}
      </div>
    </div>
  );
}
