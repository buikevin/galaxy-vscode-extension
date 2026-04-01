/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared entities used by document-reader helpers.
 */

export type DocumentResult = Readonly<{
  /** Whether the document read completed successfully. */
  success: boolean;
  /** Decoded content or retrieved chunk returned to the caller. */
  content: string;
  /** Optional error message when the read fails. */
  error?: string;
  /** Human-readable document format label. */
  format?: string;
  /** Optional page or sheet count when the format exposes it. */
  pageCount?: number;
  /** Whether the returned content is truncated or paginated. */
  truncated?: boolean;
  /** Total characters available in the decoded document. */
  totalChars?: number;
  /** Number of characters returned in this response. */
  returnedChars?: number;
  /** Character offset used for this response. */
  offset?: number;
  /** Next offset to request when more content remains. */
  nextOffset?: number;
  /** Whether more content remains after this chunk. */
  hasMore?: boolean;
}>;

export type DocumentReadOptions = Readonly<{
  /** Maximum number of characters to return for this read. */
  maxChars?: number;
  /** Character offset used for sequential pagination. */
  offset?: number;
}>;

export type DocumentSliceResult = Readonly<{
  /** Sliced content returned for this page. */
  content: string;
  /** Whether the document was truncated or paginated. */
  truncated: boolean;
  /** Total characters available in the decoded document. */
  totalChars: number;
  /** Number of characters returned in this page. */
  returnedChars: number;
  /** Character offset used for the page. */
  offset: number;
  /** Next offset to request when more content remains. */
  nextOffset?: number;
  /** Whether more content remains after the current page. */
  hasMore: boolean;
}>;
