/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Attachment-related entities used by the Galaxy Code webview.
 */

/**
 * Local file/image attachment stored in the composer before sending.
 */
export type LocalAttachment = Readonly<{
  /** Stable attachment id used for remove/preview actions. */
  attachmentId: string;
  /** Original file name shown in the UI. */
  name: string;
  /** Whether this attachment should render as an image preview. */
  isImage: boolean;
  /** Optional preview URL for images or browser-openable files. */
  previewUrl?: string;
}>;

/**
 * Preview asset shown in the modal viewer.
 */
export type PreviewAsset = Readonly<{
  /** Human-readable preview title. */
  title: string;
  /** Image URL/data URL rendered inside the preview modal. */
  imageUrl: string;
}>;
