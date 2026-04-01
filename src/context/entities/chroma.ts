/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Chroma manager entity definitions.
 */

/**
 * Persisted state for a managed local Chroma instance.
 */
export type ChromaState = Readonly<{
  /** Local port assigned to the Chroma instance. */
  port: number;
  /** Base URL used by callers to reach the instance. */
  url: string;
  /** Last time the state file was updated. */
  updatedAt: number;
}>;
