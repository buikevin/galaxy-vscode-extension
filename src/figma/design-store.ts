import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureProjectStorage, getProjectStorageInfo } from '../context/project-store';
import type { FigmaDesignDocument, FigmaDesignNode, FigmaImportRecord, FigmaImportRequest } from './design-types';
import type { FigmaAttachment } from '../shared/protocol';

const FIGMA_CLIPBOARD_PREFIX = '[[galaxy-code:figma-import:';
const FIGMA_CLIPBOARD_SUFFIX = ']]';
const MAX_PROMPT_NODES = 260;
const MAX_PROMPT_HTML_CHARS = 18_000;
const MAX_TEXT_SNIPPETS = 24;
const MAX_METADATA_LINES = 32;

function countNodes(nodes: readonly FigmaDesignNode[] | undefined): number {
  if (!nodes || nodes.length === 0) {
    return 0;
  }

  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

function summarizeDocument(document: FigmaDesignDocument): string {
  const selectionCount = document.selection.length;
  const nodeCount = countNodes(document.selection);
  const firstSelection = document.selection[0];
  const firstLabel = firstSelection ? `${firstSelection.name} (${firstSelection.type})` : 'empty selection';
  return `Imported Figma selection ${firstLabel} with ${selectionCount} top-level node${selectionCount === 1 ? '' : 's'} and ${nodeCount} total node${nodeCount === 1 ? '' : 's'}.`;
}

function parseRecord(line: string): FigmaImportRecord | null {
  try {
    return JSON.parse(line) as FigmaImportRecord;
  } catch {
    return null;
  }
}

export function appendFigmaImport(workspacePath: string, payload: FigmaImportRequest): FigmaImportRecord {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);

  const record: FigmaImportRecord = Object.freeze({
    importId: `figma-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId: storage.workspaceId,
    importedAt: Date.now(),
    source: payload.source,
    ...(payload.workspaceHint ? { workspaceHint: payload.workspaceHint } : {}),
    summary: summarizeDocument(payload.document),
    document: payload.document,
  });

  fs.appendFileSync(storage.figmaImportsPath, `${JSON.stringify(record)}\n`, 'utf-8');
  return record;
}

export function loadRecentFigmaImports(workspacePath: string, limit = 10): readonly FigmaImportRecord[] {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  if (!fs.existsSync(storage.figmaImportsPath)) {
    return Object.freeze([]);
  }

  try {
    const lines = fs.readFileSync(storage.figmaImportsPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    return Object.freeze(
      lines
        .slice(-Math.max(1, limit))
        .map(parseRecord)
        .filter((item): item is FigmaImportRecord => item !== null),
    );
  } catch {
    return Object.freeze([]);
  }
}

export function findFigmaImport(workspacePath: string, importId?: string): FigmaImportRecord | null {
  const recent = loadRecentFigmaImports(workspacePath, 100);
  if (recent.length === 0) {
    return null;
  }

  if (!importId) {
    return recent[recent.length - 1] ?? null;
  }

  return recent.find((record) => record.importId === importId) ?? null;
}

export function formatFigmaImportSummary(record: FigmaImportRecord): string {
  const firstSelection = record.document.selection[0];
  const selectionLabel = firstSelection ? `${firstSelection.name} (${firstSelection.type})` : 'empty selection';
  const assetCount = record.document.assets?.length ?? 0;
  return [
    `Import ID: ${record.importId}`,
    `Imported at: ${new Date(record.importedAt).toISOString()}`,
    `Selection root: ${selectionLabel}`,
    `Top-level nodes: ${record.document.selection.length}`,
    `Assets: ${assetCount}`,
    record.summary,
  ].join('\n');
}

export function buildFigmaClipboardToken(importId: string): string {
  return `${FIGMA_CLIPBOARD_PREFIX}${importId}${FIGMA_CLIPBOARD_SUFFIX}`;
}

export function parseFigmaClipboardImportIds(text: string): readonly string[] {
  const matches = text.match(/\[\[galaxy-code:figma-import:([A-Za-z0-9-]+)\]\]/g) ?? [];
  const ids = matches
    .map((match) => match.slice(FIGMA_CLIPBOARD_PREFIX.length, match.length - FIGMA_CLIPBOARD_SUFFIX.length))
    .filter(Boolean);
  return Object.freeze([...new Set(ids)]);
}

function getSelectionLabel(record: FigmaImportRecord): string {
  const firstSelection = record.document.selection[0];
  return firstSelection ? `${firstSelection.name} (${firstSelection.type})` : 'Design By Figma';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumeric(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function simplifyColor(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const color = value as { r?: number; g?: number; b?: number; a?: number };
  if (
    typeof color.r !== 'number' ||
    typeof color.g !== 'number' ||
    typeof color.b !== 'number'
  ) {
    return undefined;
  }

  const clamp = (input: number): number => Math.max(0, Math.min(255, Math.round(input * 255)));
  const rgb = [clamp(color.r), clamp(color.g), clamp(color.b)];
  const alpha = typeof color.a === 'number' ? Math.round(color.a * 100) / 100 : 1;
  return alpha >= 1
    ? `rgb(${rgb.join(',')})`
    : `rgba(${rgb.join(',')},${alpha})`;
}

function simplifyPaints(paints: unknown): string | undefined {
  if (!Array.isArray(paints) || paints.length === 0) {
    return undefined;
  }

  const simplified = paints
    .slice(0, 2)
    .map((paint) => {
      if (!paint || typeof paint !== 'object') {
        return '';
      }

      const item = paint as {
        type?: string;
        color?: unknown;
        opacity?: number;
        gradientStops?: Array<{ color?: unknown; position?: number }>;
      };
      const parts = [typeof item.type === 'string' ? item.type : 'paint'];
      const color = simplifyColor(item.color);
      if (color) {
        parts.push(color);
      }
      if (typeof item.opacity === 'number' && item.opacity < 1) {
        parts.push(`opacity=${Math.round(item.opacity * 100) / 100}`);
      }
      if (Array.isArray(item.gradientStops) && item.gradientStops.length > 0) {
        const stops = item.gradientStops
          .slice(0, 3)
          .map((stop) => {
            const stopColor = simplifyColor(stop?.color);
            const position = typeof stop?.position === 'number' ? Math.round(stop.position * 100) : undefined;
            return stopColor ? `${stopColor}${typeof position === 'number' ? `@${position}%` : ''}` : '';
          })
          .filter(Boolean);
        if (stops.length > 0) {
          parts.push(`stops=${stops.join('|')}`);
        }
      }
      return parts.join(':');
    })
    .filter(Boolean);

  return simplified.length > 0 ? simplified.join(', ') : undefined;
}

function simplifyEffects(effects: unknown): string | undefined {
  if (!Array.isArray(effects) || effects.length === 0) {
    return undefined;
  }

  const simplified = effects
    .slice(0, 2)
    .map((effect) => {
      if (!effect || typeof effect !== 'object') {
        return '';
      }
      const item = effect as {
        type?: string;
        radius?: number;
        spread?: number;
        offset?: { x?: number; y?: number };
        color?: unknown;
      };
      const parts = [typeof item.type === 'string' ? item.type : 'effect'];
      if (typeof item.radius === 'number') {
        parts.push(`radius=${formatNumeric(item.radius)}`);
      }
      if (typeof item.spread === 'number') {
        parts.push(`spread=${formatNumeric(item.spread)}`);
      }
      if (item.offset && (typeof item.offset.x === 'number' || typeof item.offset.y === 'number')) {
        parts.push(`offset=${formatNumeric(item.offset.x) ?? '0'},${formatNumeric(item.offset.y) ?? '0'}`);
      }
      const color = simplifyColor(item.color);
      if (color) {
        parts.push(color);
      }
      return parts.join(':');
    })
    .filter(Boolean);

  return simplified.length > 0 ? simplified.join(', ') : undefined;
}

function normalizeTagName(type: string): string {
  const lowered = type.toLowerCase();
  switch (lowered) {
    case 'frame':
      return 'frame';
    case 'group':
      return 'group';
    case 'text':
      return 'text';
    case 'rectangle':
      return 'rect';
    case 'vector':
      return 'vector';
    default:
      return lowered.replace(/[^a-z0-9]+/g, '-') || 'node';
  }
}

function isSvgLikeNode(node: FigmaDesignNode): boolean {
  const lowerName = node.name.toLowerCase();
  return (
    lowerName.includes('.svg') ||
    node.type.toLowerCase() === 'vector' ||
    typeof node.assetRef === 'string'
  );
}

function branchContainsText(node: FigmaDesignNode): boolean {
  if (node.text?.characters?.trim()) {
    return true;
  }

  return Array.isArray(node.children) ? node.children.some(branchContainsText) : false;
}

function isDecorativeBranch(node: FigmaDesignNode): boolean {
  if (branchContainsText(node)) {
    return false;
  }

  if (isSvgLikeNode(node)) {
    return true;
  }

  return Array.isArray(node.children) && node.children.length > 0
    ? node.children.every(isDecorativeBranch)
    : false;
}

function collectTextSnippets(nodes: readonly FigmaDesignNode[] | undefined, target: string[] = []): string[] {
  for (const node of nodes ?? []) {
    if (target.length >= MAX_TEXT_SNIPPETS) {
      break;
    }
    const text = node.text?.characters?.trim();
    if (text) {
      target.push(text.replace(/\s+/g, ' ').slice(0, 140));
    }
    collectTextSnippets(node.children, target);
  }
  return target;
}

function buildNodeAttributes(node: FigmaDesignNode): string {
  const attrs: string[] = [];
  attrs.push(`name="${escapeHtml(node.name)}"`);
  if (node.visible === false) {
    attrs.push('visible="false"');
  }
  if (node.absoluteBoundingBox) {
    attrs.push(`x="${formatNumeric(node.absoluteBoundingBox.x) ?? '0'}"`);
    attrs.push(`y="${formatNumeric(node.absoluteBoundingBox.y) ?? '0'}"`);
    attrs.push(`width="${formatNumeric(node.absoluteBoundingBox.width) ?? '0'}"`);
    attrs.push(`height="${formatNumeric(node.absoluteBoundingBox.height) ?? '0'}"`);
  }
  if (node.layout) {
    if (node.layout.mode && node.layout.mode !== 'none') {
      attrs.push(`layout="${node.layout.mode}"`);
    }
    if (typeof node.layout.gap === 'number' && node.layout.gap !== 0) {
      attrs.push(`gap="${formatNumeric(node.layout.gap)}"`);
    }
    const paddings = [
      node.layout.paddingTop,
      node.layout.paddingRight,
      node.layout.paddingBottom,
      node.layout.paddingLeft,
    ];
    if (paddings.some((value) => typeof value === 'number' && value !== 0)) {
      attrs.push(`padding="${paddings.map((value) => formatNumeric(value) ?? '0').join(' ')}"`);
    }
    if (node.layout.sizingHorizontal) {
      attrs.push(`sizeX="${node.layout.sizingHorizontal}"`);
    }
    if (node.layout.sizingVertical) {
      attrs.push(`sizeY="${node.layout.sizingVertical}"`);
    }
    if (node.layout.alignMain) {
      attrs.push(`alignMain="${node.layout.alignMain}"`);
    }
    if (node.layout.alignCross) {
      attrs.push(`alignCross="${node.layout.alignCross}"`);
    }
    if (node.layout.wrap) {
      attrs.push('wrap="true"');
    }
  }
  if (node.style) {
    const fills = simplifyPaints(node.style.fills);
    if (fills) {
      attrs.push(`fills="${escapeHtml(fills)}"`);
    }
    const strokes = simplifyPaints(node.style.strokes);
    if (strokes) {
      attrs.push(`strokes="${escapeHtml(strokes)}"`);
    }
    if (typeof node.style.strokeWidth === 'number' && node.style.strokeWidth > 0) {
      attrs.push(`strokeWidth="${formatNumeric(node.style.strokeWidth)}"`);
    }
    if (typeof node.style.opacity === 'number' && node.style.opacity < 1) {
      attrs.push(`opacity="${formatNumeric(node.style.opacity)}"`);
    }
    if (typeof node.style.radius === 'number' && node.style.radius > 0) {
      attrs.push(`radius="${formatNumeric(node.style.radius)}"`);
    }
    const effects = simplifyEffects(node.style.effects);
    if (effects) {
      attrs.push(`effects="${escapeHtml(effects)}"`);
    }
  }
  if (node.constraints) {
    if (node.constraints.horizontal) {
      attrs.push(`constraintX="${node.constraints.horizontal}"`);
    }
    if (node.constraints.vertical) {
      attrs.push(`constraintY="${node.constraints.vertical}"`);
    }
  }
  if (node.text) {
    attrs.push(`font="${escapeHtml(node.text.fontFamily ?? 'unknown')}"`);
    if (node.text.fontWeight) {
      attrs.push(`weight="${escapeHtml(String(node.text.fontWeight))}"`);
    }
    if (typeof node.text.fontSize === 'number') {
      attrs.push(`fontSize="${formatNumeric(node.text.fontSize)}"`);
    }
    if (typeof node.text.lineHeight === 'number') {
      attrs.push(`lineHeight="${formatNumeric(node.text.lineHeight)}"`);
    }
    if (typeof node.text.letterSpacing === 'number' && node.text.letterSpacing !== 0) {
      attrs.push(`letterSpacing="${formatNumeric(node.text.letterSpacing)}"`);
    }
    if (node.text.textAlignHorizontal) {
      attrs.push(`align="${node.text.textAlignHorizontal}"`);
    }
  }
  return attrs.join(' ');
}

function serializeNode(
  node: FigmaDesignNode,
  state: { count: number; lines: string[]; truncated: boolean },
  depth = 0,
): void {
  if (state.truncated || state.count >= MAX_PROMPT_NODES) {
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

function buildRawFigmaHtml(document: FigmaDesignDocument): string {
  const state = {
    count: 0,
    lines: [] as string[],
    truncated: false,
  };

  for (const node of document.selection) {
    serializeNode(node, state, 0);
    if (state.truncated) {
      break;
    }
  }

  let html = state.lines.join('\n');
  if (html.length > MAX_PROMPT_HTML_CHARS) {
    html = `${html.slice(0, MAX_PROMPT_HTML_CHARS)}\n...[truncated raw figma html]`;
    state.truncated = true;
  }
  if (state.truncated) {
    html += '\n<!-- truncated for prompt safety -->';
  }
  return html;
}

function buildMetadataSummary(record: FigmaImportRecord): readonly string[] {
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
  return Object.freeze(lines.slice(0, MAX_METADATA_LINES));
}

function buildPreviewDataUrl(record: FigmaImportRecord): string | undefined {
  const asset = record.document.assets?.find((item) => item.kind === 'svg' || item.kind === 'png');
  if (!asset?.contentBase64) {
    return undefined;
  }

  const mime = asset.kind === 'png' ? 'image/png' : 'image/svg+xml';
  return `data:${mime};base64,${asset.contentBase64}`;
}

export function buildFigmaAttachment(workspacePath: string, importId: string): FigmaAttachment | null {
  const record = findFigmaImport(workspacePath, importId);
  if (!record) {
    return null;
  }

  const attachment: FigmaAttachment = {
    importId: record.importId,
    label: getSelectionLabel(record),
    summary: record.summary,
  };
  const previewDataUrl = buildPreviewDataUrl(record);
  return Object.freeze(previewDataUrl ? { ...attachment, previewDataUrl } : attachment);
}

export function buildAttachedFigmaContextNote(workspacePath: string, importIds: readonly string[]): string {
  const sections = importIds
    .map((importId) => findFigmaImport(workspacePath, importId))
    .filter((record): record is FigmaImportRecord => record !== null)
    .map((record) => {
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
    });

  return sections.length > 0 ? `Attached Figma designs:\n${sections.join('\n\n')}` : '';
}
