/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for token estimation and context compaction.
 */

/**
 * Minimal token encoder contract used by compaction logic.
 */
export type TokenEncoder = Readonly<{
  /**
   * Encodes arbitrary text into token ids.
   */
  encode(text: string): ArrayLike<number>;
}>;
