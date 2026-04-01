/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared Figma prompt-formatting helpers used to build prompt-safe pseudo HTML and metadata summaries.
 */

import { FIGMA_MAX_TEXT_SNIPPETS } from '../shared/constants';
import type { FigmaDesignNode } from '../shared/figma';

/**
 * Escapes a string for safe inclusion in prompt-oriented pseudo HTML.
 *
 * @param value Raw text value.
 * @returns HTML-escaped text.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats one numeric value for compact prompt output.
 *
 * @param value Numeric value to format.
 * @returns String form with small rounding, or `undefined` when invalid.
 */
export function formatNumeric(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Normalizes a simplified paint color object into RGB/RGBA text.
 *
 * @param value Paint color payload.
 * @returns Compact color string, or `undefined` when the payload is invalid.
 */
export function simplifyColor(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const color = value as { r?: number; g?: number; b?: number; a?: number };
  if (typeof color.r !== 'number' || typeof color.g !== 'number' || typeof color.b !== 'number') {
    return undefined;
  }

  const clamp = (input: number): number => Math.max(0, Math.min(255, Math.round(input * 255)));
  const rgb = [clamp(color.r), clamp(color.g), clamp(color.b)];
  const alpha = typeof color.a === 'number' ? Math.round(color.a * 100) / 100 : 1;
  return alpha >= 1 ? `rgb(${rgb.join(',')})` : `rgba(${rgb.join(',')},${alpha})`;
}

/**
 * Simplifies paint metadata for prompt-safe pseudo HTML attributes.
 *
 * @param paints Paint list from the Figma node style payload.
 * @returns Compact paint summary, or `undefined` when no useful data exists.
 */
export function simplifyPaints(paints: unknown): string | undefined {
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

/**
 * Simplifies effect metadata for prompt-safe pseudo HTML attributes.
 *
 * @param effects Effect list from the Figma node style payload.
 * @returns Compact effect summary, or `undefined` when no useful data exists.
 */
export function simplifyEffects(effects: unknown): string | undefined {
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

/**
 * Normalizes a node type into a compact pseudo-HTML tag.
 *
 * @param type Figma node type.
 * @returns Prompt-safe pseudo tag name.
 */
export function normalizeTagName(type: string): string {
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

/**
 * Detects whether a node should be treated like an SVG/vector asset.
 *
 * @param node Figma node to inspect.
 * @returns `true` when the node behaves like a decorative asset.
 */
export function isSvgLikeNode(node: FigmaDesignNode): boolean {
  const lowerName = node.name.toLowerCase();
  return lowerName.includes('.svg') || node.type.toLowerCase() === 'vector' || typeof node.assetRef === 'string';
}

/**
 * Checks whether a branch contains visible text content.
 *
 * @param node Figma node to inspect recursively.
 * @returns `true` when text content exists in the branch.
 */
export function branchContainsText(node: FigmaDesignNode): boolean {
  if (node.text?.characters?.trim()) {
    return true;
  }

  return Array.isArray(node.children) ? node.children.some(branchContainsText) : false;
}

/**
 * Determines whether a branch is purely decorative and can be collapsed in the prompt representation.
 *
 * @param node Figma node to inspect recursively.
 * @returns `true` when the branch is decorative-only.
 */
export function isDecorativeBranch(node: FigmaDesignNode): boolean {
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

/**
 * Collects representative text snippets from the imported design tree.
 *
 * @param nodes Node list to traverse.
 * @param target Mutable output array reused across recursion.
 * @returns Collected text snippets.
 */
export function collectTextSnippets(nodes: readonly FigmaDesignNode[] | undefined, target: string[] = []): string[] {
  for (const node of nodes ?? []) {
    if (target.length >= FIGMA_MAX_TEXT_SNIPPETS) {
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

/**
 * Builds pseudo-HTML attributes for one serialized node.
 *
 * @param node Figma node to serialize.
 * @returns Prompt-safe attribute string.
 */
export function buildNodeAttributes(node: FigmaDesignNode): string {
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
    const paddings = [node.layout.paddingTop, node.layout.paddingRight, node.layout.paddingBottom, node.layout.paddingLeft];
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
