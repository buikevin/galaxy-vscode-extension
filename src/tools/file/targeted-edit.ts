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
 * Finds all candidate line ranges whose content exactly matches one snapshot block.
 *
 * @param lines Current file lines on disk.
 * @param expectedRangeContent Exact range content captured from the previous read.
 * @returns Matching inclusive line ranges.
 */
function findMatchingRanges(
  lines: readonly string[],
  expectedRangeContent: string,
): ReadonlyArray<Readonly<{ startLine: number; endLine: number }>> {
  const expectedLines = expectedRangeContent.split('\n');
  const rangeLength = expectedLines.length;
  if (rangeLength === 0 || lines.length < rangeLength) {
    return Object.freeze([]);
  }

  const matches: Array<Readonly<{ startLine: number; endLine: number }>> = [];
  for (let startIndex = 0; startIndex <= lines.length - rangeLength; startIndex += 1) {
    const candidate = lines.slice(startIndex, startIndex + rangeLength).join('\n');
    if (candidate === expectedRangeContent) {
      matches.push(Object.freeze({ startLine: startIndex + 1, endLine: startIndex + rangeLength }));
    }
  }

  return Object.freeze(matches);
}

/**
 * Returns true when the candidate range still satisfies the caller's nearby anchors.
 *
 * @param lines Current file lines on disk.
 * @param candidate Candidate range located via exact content matching.
 * @param options Snapshot evidence captured from a previous read.
 * @returns Whether the anchors remain valid for the candidate range.
 */
function candidateMatchesAnchors(
  lines: readonly string[],
  candidate: Readonly<{ startLine: number; endLine: number }>,
  options?: LineEditSnapshot,
): boolean {
  if (typeof options?.anchorBefore === 'string' && options.anchorBefore.length > 0) {
    if (getLineAt(lines, candidate.startLine - 1) !== options.anchorBefore) {
      return false;
    }
  }

  if (typeof options?.anchorAfter === 'string' && options.anchorAfter.length > 0) {
    if (getLineAt(lines, candidate.endLine + 1) !== options.anchorAfter) {
      return false;
    }
  }

  return true;
}

/**
 * Attempts to relocate a stale range edit by exact snapshot content and nearby anchors.
 *
 * @param lines Current file lines on disk.
 * @param startLine Preferred 1-based inclusive start line from the caller.
 * @param endLine Preferred 1-based inclusive end line from the caller.
 * @param options Snapshot evidence captured from the previous read.
 * @returns Resolved line range or null when relocation is impossible.
 */
export function resolveRangeEditLocation(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  options?: LineEditSnapshot,
): Readonly<{ startLine: number; endLine: number }> | null {
  const currentRangeContent = getRangeContent(lines, startLine, endLine);
  const expectedRangeContentProvided = Boolean(options?.expectedRangeContentProvided);
  const expectedRangeContent = typeof options?.expectedRangeContent === 'string' ? options.expectedRangeContent : '';

  const currentCandidate = Object.freeze({ startLine, endLine });
  const currentMatchesContent = !expectedRangeContentProvided || currentRangeContent === expectedRangeContent;
  if (currentMatchesContent && candidateMatchesAnchors(lines, currentCandidate, options)) {
    return currentCandidate;
  }

  if (!expectedRangeContentProvided || expectedRangeContent.length === 0) {
    return null;
  }

  const matchingRanges = findMatchingRanges(lines, expectedRangeContent)
    .filter((candidate) => candidateMatchesAnchors(lines, candidate, options));
  if (matchingRanges.length !== 1) {
    return null;
  }

  return matchingRanges[0] ?? null;
}

/**
 * Attempts to relocate a stale insertion point by nearby anchors.
 *
 * @param lines Current file lines on disk.
 * @param preferredLine Preferred 1-based insertion line from the caller.
 * @param options Snapshot evidence captured from the previous read.
 * @returns Resolved insertion line or null when relocation is impossible.
 */
export function resolveInsertionLine(
  lines: readonly string[],
  preferredLine: number,
  options?: LineEditSnapshot,
): number | null {
  const matchesCurrentPosition =
    (typeof options?.anchorBefore !== 'string' || options.anchorBefore.length === 0 || getLineAt(lines, preferredLine - 1) === options.anchorBefore)
    && (typeof options?.anchorAfter !== 'string' || options.anchorAfter.length === 0 || getLineAt(lines, preferredLine) === options.anchorAfter);
  if (matchesCurrentPosition && preferredLine >= 1 && preferredLine <= lines.length + 1) {
    return preferredLine;
  }

  const candidates: number[] = [];
  for (let candidateLine = 1; candidateLine <= lines.length + 1; candidateLine += 1) {
    const beforeMatches =
      typeof options?.anchorBefore !== 'string'
      || options.anchorBefore.length === 0
      || getLineAt(lines, candidateLine - 1) === options.anchorBefore;
    const afterMatches =
      typeof options?.anchorAfter !== 'string'
      || options.anchorAfter.length === 0
      || getLineAt(lines, candidateLine) === options.anchorAfter;
    if (beforeMatches && afterMatches) {
      candidates.push(candidateLine);
    }
  }

  return candidates.length === 1 ? candidates[0]! : null;
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
  return resolveRangeEditLocation(originalLines, startLine, endLine, options)
    ? null
    : `Target range in ${rawPath} no longer matches the last read snapshot. Read the file again before editing.`;
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
  if (!hasLineEditSnapshot(snapshot)) {
    const lineCountHint =
      Number.isFinite(expectedTotalLines) && Number(expectedTotalLines) > 0
        ? ' expected_total_lines alone is not enough.'
        : '';
    return `${operation} on ${rawPath} requires exact snapshot evidence.${lineCountHint} Provide expected_range_content or nearby anchors from a fresh read_file result before editing.`;
  }
  return null;
}
