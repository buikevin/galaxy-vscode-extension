/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Public Figma prompt helpers used to build transcript attachments and attached-design context sections.
 */

import type { FigmaAttachment } from '../shared/protocol';
import type { FigmaImportRecord } from '../shared/figma';

/**
 * Builds a concise label for the primary selection in an imported Figma record.
 *
 * @param record Persisted Figma import record.
 * @returns Human-readable selection label.
 */
export function getSelectionLabel(record: FigmaImportRecord): string {
  const firstSelection = record.document.selection[0];
  return firstSelection ? `${firstSelection.name} (${firstSelection.type})` : 'Design By Figma';
}

/**
 * Builds the preview data URL for the first embedded preview asset.
 *
 * @param record Persisted Figma import record.
 * @returns Preview data URL when an SVG or PNG asset is present.
 */
export function buildPreviewDataUrl(record: FigmaImportRecord): string | undefined {
  const asset = record.document.assets?.find((item) => item.kind === 'svg' || item.kind === 'png');
  if (!asset?.contentBase64) {
    return undefined;
  }

  const mime = asset.kind === 'png' ? 'image/png' : 'image/svg+xml';
  return `data:${mime};base64,${asset.contentBase64}`;
}

/**
 * Builds a transcript attachment payload from a persisted Figma import record.
 *
 * @param record Persisted Figma import record.
 * @returns Transcript attachment metadata with optional preview.
 */
export function buildFigmaAttachmentFromRecord(record: FigmaImportRecord): FigmaAttachment {
  const attachment: FigmaAttachment = {
    importId: record.importId,
    label: getSelectionLabel(record),
    summary: record.summary,
  };
  const previewDataUrl = buildPreviewDataUrl(record);
  return Object.freeze(previewDataUrl ? { ...attachment, previewDataUrl } : attachment);
}
