/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for UI transcript persistence.
 */

export type UiTranscriptLoadOptions = Readonly<{
  /** Optional maximum number of most-recent messages to load. */
  maxMessages?: number;
}>;
