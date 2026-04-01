/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Serialize imported Figma records into prompt-safe pseudo HTML and metadata sections.
 */

import { FIGMA_MAX_METADATA_LINES, FIGMA_MAX_PROMPT_HTML_CHARS, FIGMA_MAX_PROMPT_NODES } from '../shared/constants';
import type { FigmaDesignDocument, FigmaDesignNode, FigmaImportRecord } from '../shared/figma';
import {
  buildNodeAttributes,
  collectTextSnippets,
  escapeHtml,
  formatNumeric,
  isDecorativeBranch,
  normalizeTagName,
} from './formatting';

/**
 * Serializes one Figma node tree into prompt-safe pseudo HTML.
 *
 * @param node Figma node to serialize.
 * @param state Mutable serialization state.
 * @param depth Current tree depth.
 */
function serializeNode(
  node: FigmaDesignNode,
  state: { count: number; lines: string[]; truncated: boolean },
  depth = 0,
): void {
  if (state.truncated || state.count >= FIGMA_MAX_PROMPT_NODES) {
    state.truncated = true;
    return;
  }

  if (node.visible === false) {
    return;
  }

  const indent = '  '.repeat(depth);
  if (isDecorativeBranch(node)) {
    state.lines.push(
      `${indent}<asset name="${escapeHtml(node.name)}" kind="${normalizeTagName(node.type)}" decorative="true"${
        node.absoluteBoundingBox
          ? ` width="${formatNumeric(node.absoluteBoundingBox.width) ?? '0'}" height="${formatNumeric(node.absoluteBoundingBox.height) ?? '0'}"`
          : ''
      } />`,
    );
    state.count += 1;
    return;
  }

  const tag = normalizeTagName(node.type);
  const attrs = buildNodeAttributes(node);
  const openTag = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
  const textContent = node.text?.characters?.replace(/\s+/g, ' ').trim();
  const children = (node.children ?? []).filter((child) => child.visible !== false);

  if (textContent) {
    state.lines.push(`${indent}${openTag}${escapeHtml(textContent)}</${tag}>`);
    state.count += 1;
    return;
  }

  if (children.length === 0) {
    state.lines.push(`${indent}${openTag}</${tag}>`);
    state.count += 1;
    return;
  }

  state.lines.push(`${indent}${openTag}`);
  state.count += 1;
  for (const child of children) {
    serializeNode(child, state, depth + 1);
    if (state.truncated) {
      break;
    }
  }
  state.lines.push(`${indent}</${tag}>`);
}

/**
 * Builds prompt-safe pseudo HTML from an imported Figma document.
 *
 * @param document Imported Figma document payload.
 * @returns Prompt-safe raw Figma HTML string.
 */
export function buildRawFigmaHtml(document: FigmaDesignDocument): string {
  const state = { count: 0, lines: [] as string[], truncated: false };

  for (const node of document.selection) {
    serializeNode(node, state, 0);
    if (state.truncated) {
      break;
    }
  }

  let html = state.lines.join('\n');
  if (html.length > FIGMA_MAX_PROMPT_HTML_CHARS) {
    html = `${html.slice(0, FIGMA_MAX_PROMPT_HTML_CHARS)}\n...[truncated raw figma html]`;
    state.truncated = true;
  }
  if (state.truncated) {
    html += '\n<!-- truncated for prompt safety -->';
  }
  return html;
}

/**
 * Builds metadata lines for one imported Figma record.
 *
 * @param record Persisted Figma import record.
 * @returns Prompt-safe metadata lines.
 */
export function buildMetadataSummary(record: FigmaImportRecord): readonly string[] {
  const lines: string[] = [];
  const firstSelection = record.document.selection[0];
  lines.push(`Import ID: ${record.importId}`);
  lines.push(`Page: ${record.document.pageName ?? '(unknown page)'}`);
  lines.push(`Summary: ${record.summary}`);
  if (firstSelection) {
    lines.push(`Root: ${firstSelection.name} (${firstSelection.type})`);
    if (firstSelection.absoluteBoundingBox) {
      lines.push(
        `Root size: ${formatNumeric(firstSelection.absoluteBoundingBox.width) ?? '0'}x${formatNumeric(firstSelection.absoluteBoundingBox.height) ?? '0'}`,
      );
    }
  }
  const snippets = collectTextSnippets(record.document.selection);
  if (snippets.length > 0) {
    lines.push(`Text content samples: ${snippets.join(' | ')}`);
  }
  lines.push('SVG assets are available for UI preview only and are excluded from prompt context.');
  return Object.freeze(lines.slice(0, FIGMA_MAX_METADATA_LINES));
}

/**
 * Builds one prompt section for an attached Figma record.
 *
 * @param record Persisted Figma import record.
 * @returns Prompt-ready Figma section.
 */
export function buildAttachedFigmaContextSection(record: FigmaImportRecord): string {
  const metadataLines = buildMetadataSummary(record);
  const rawHtml = buildRawFigmaHtml(record.document);
  return [
    `### ATTACHED FIGMA DESIGN`,
    ...metadataLines,
    '',
    `Raw Figma HTML:`,
    '```html',
    rawHtml,
    '```',
    'Use this attached Figma structure as the design source of truth for implementation.',
  ].join('\n');
}
