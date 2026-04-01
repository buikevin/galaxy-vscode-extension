/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Validation helpers for targeted line-based edits.
 */

import type { LineEditSnapshot } from '../entities/file-tools';

/**
 * Returns one 1-based line from an in-memory file snapshot.
 *
 * @param lines Snapshot lines from the current file content.
 * @param lineNumber 1-based line number to read.
 * @returns Exact line text or null when the position is out of range.
 */
export function getLineAt(lines: readonly string[], lineNumber: number): string | null {
  if (!Number.isFinite(lineNumber) || lineNumber < 1 || lineNumber > lines.length) {
    return null;
  }
  return lines[lineNumber - 1] ?? null;
}

/**
 * Joins one inclusive line range back into raw text for snapshot comparison.
 *
 * @param lines Snapshot lines from the current file content.
 * @param startLine 1-based inclusive start line.
 * @param endLine 1-based inclusive end line.
 * @returns Joined content for the requested range.
 */
export function getRangeContent(lines: readonly string[], startLine: number, endLine: number): string {
  if (startLine > endLine) {
    return '';
  }
  return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * Verifies that a targeted range edit still matches the caller's last read snapshot.
 *
 * @param rawPath User-visible path for error messages.
 * @param originalLines Current file lines on disk.
 * @param startLine 1-based inclusive start line.
 * @param endLine 1-based inclusive end line.
 * @param options Snapshot evidence captured from a previous read.
 * @returns Null when the edit is safe to apply, otherwise an actionable error message.
 */
export function validateAnchoredRangeEdit(
  rawPath: string,
  originalLines: readonly string[],
  startLine: number,
  endLine: number,
  options?: LineEditSnapshot,
): string | null {
  const expectedRangeContentProvided = Boolean(options?.expectedRangeContentProvided);
  if (expectedRangeContentProvided) {
    const expectedRangeContent = String(options?.expectedRangeContent ?? '');
    const currentRangeContent = getRangeContent(originalLines, startLine, endLine);
    if (currentRangeContent !== expectedRangeContent) {
      return `Target range in ${rawPath} no longer matches the last read snapshot. Read the file again before editing.`;
    }
  }

  if (typeof options?.anchorBefore === 'string' && options.anchorBefore.length > 0) {
    const currentBefore = getLineAt(originalLines, startLine - 1);
    if (currentBefore !== options.anchorBefore) {
      return `anchor_before no longer matches ${rawPath} near line ${startLine}. Read the file again before editing.`;
    }
  }

  if (typeof options?.anchorAfter === 'string' && options.anchorAfter.length > 0) {
    const currentAfter = getLineAt(originalLines, endLine + 1);
    if (currentAfter !== options.anchorAfter) {
      return `anchor_after no longer matches ${rawPath} near line ${endLine}. Read the file again before editing.`;
    }
  }

  return null;
}

/**
 * Returns whether the caller supplied any usable snapshot evidence for a line edit.
 *
 * @param snapshot Snapshot evidence captured from a previous read.
 * @returns True when exact content or anchors are available.
 */
export function hasLineEditSnapshot(snapshot?: LineEditSnapshot): boolean {
  return (
    Boolean(snapshot?.expectedRangeContentProvided) ||
    (typeof snapshot?.anchorBefore === 'string' && snapshot.anchorBefore.length > 0) ||
    (typeof snapshot?.anchorAfter === 'string' && snapshot.anchorAfter.length > 0)
  );
}

/**
 * Validates the minimum safety preconditions required before applying a targeted line edit.
 *
 * @param rawPath User-visible path for error messages.
 * @param operation Human-readable operation label.
 * @param expectedTotalLines File line count captured from the previous read.
 * @param snapshot Snapshot evidence captured from the previous read.
 * @returns Null when the edit request contains enough safety evidence.
 */
export function validateTargetedEditPreconditions(
  rawPath: string,
  operation: 'insert' | 'range-edit' | 'multi-range-edit',
  expectedTotalLines?: number,
  snapshot?: LineEditSnapshot,
): string | null {
  if (!Number.isFinite(expectedTotalLines) || Number(expectedTotalLines) <= 0) {
    return `${operation} on ${rawPath} requires expected_total_lines from a fresh read_file result. Read the file again before editing.`;
  }
  if (!hasLineEditSnapshot(snapshot)) {
    return `${operation} on ${rawPath} requires exact snapshot evidence. Provide expected_range_content or nearby anchors from a fresh read_file result before editing.`;
  }
  return null;
}
