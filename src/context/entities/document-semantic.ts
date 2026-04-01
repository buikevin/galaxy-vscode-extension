/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for semantic document retrieval.
 */

/**
 * Normalized source payload cached after one expensive document decode.
 */
export type DocumentSemanticSource = Readonly<{
  /**
   * Absolute file path used as the canonical storage key.
   */
  resolvedPath: string;
  /**
   * Filesystem stats captured when the source was loaded.
   */
  stat: import('node:fs').Stats;
  /**
   * Version token derived from mtime and size for invalidation.
   */
  sourceVersion: string;
  /**
   * Fully decoded text content of the document.
   */
  content: string;
  /**
   * Optional document format reported by the decoder.
   */
  format?: string;
  /**
   * Optional number of pages reported by the decoder.
   */
  pageCount?: number;
}>;

/**
 * Semantic retrieval result for one document query.
 */
export type DocumentSemanticQueryResult = Readonly<{
  /**
   * Ranked snippets returned to the prompt layer.
   */
  snippets: readonly string[];
  /**
   * Optional source document format.
   */
  format?: string;
  /**
   * Optional page count for UI and prompt context.
   */
  pageCount?: number;
}>;
