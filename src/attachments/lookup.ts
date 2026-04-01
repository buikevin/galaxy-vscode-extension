/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Attachment lookup helpers used to resolve approximate user-provided paths back to stored attachments.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadIndex } from './storage';

/**
 * Normalizes attachment names for fuzzy lookup.
 *
 * @param value Raw attachment file name or path.
 * @returns Accent-stripped lowercase lookup key with normalized separators.
 */
function normalizeAttachmentLookup(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\\/g, '/')
    .replace(/[^a-zA-Z0-9./_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Normalizes attachment names into alphanumeric fuzzy keys.
 *
 * @param value Raw attachment file name or path.
 * @returns Compact fuzzy-match key.
 */
function normalizeAttachmentKey(value: string): string {
  return normalizeAttachmentLookup(value).replace(/[^a-z0-9]+/g, '');
}

/**
 * Computes Levenshtein distance between two fuzzy-match keys.
 *
 * @param a First comparison key.
 * @param b Second comparison key.
 * @returns Edit distance between the two keys.
 */
function computeEditDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j]!;
    }
  }

  return previous[b.length]!;
}

/**
 * Computes the common prefix length between two fuzzy-match keys.
 *
 * @param a First comparison key.
 * @param b Second comparison key.
 * @returns Number of leading characters shared by the two keys.
 */
function computeCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

/**
 * Resolves a fuzzy raw path back to the stored attachment payload path.
 *
 * @param workspacePath Workspace root owning the attachment store.
 * @param rawPath Raw attachment path or file name supplied by the agent.
 * @returns Absolute stored attachment path when a confident match is found.
 */
export function resolveAttachmentStoredPath(workspacePath: string, rawPath: string): string | null {
  const baseName = path.basename(rawPath);
  const target = normalizeAttachmentLookup(baseName);
  const targetKey = normalizeAttachmentKey(baseName);
  if (!target) {
    return null;
  }

  const records = loadIndex(workspacePath).filter((record) => record.status !== 'removed');
  const scoredMatches = records.map((record) => {
    const original = normalizeAttachmentLookup(record.originalName);
    const storedBase = normalizeAttachmentLookup(path.basename(record.storedPath));
    const originalKey = normalizeAttachmentKey(record.originalName);
    const storedKey = normalizeAttachmentKey(path.basename(record.storedPath));
    const candidates = [original, storedBase, originalKey, storedKey].filter(Boolean);
    let score = 0;

    for (const candidate of candidates) {
      if (candidate === target || candidate === targetKey) {
        score = Math.max(score, 100);
        continue;
      }
      if (candidate === originalKey || candidate === storedKey) {
        score = Math.max(score, 96);
      }
      if (targetKey.length >= 8 && (candidate.includes(targetKey) || targetKey.includes(candidate))) {
        score = Math.max(score, 84);
      }

      const prefixLength = computeCommonPrefixLength(candidate, targetKey);
      const prefixRatio = prefixLength / Math.max(candidate.length, targetKey.length, 1);
      if (prefixRatio >= 0.82) {
        score = Math.max(score, 72 + Math.round(prefixRatio * 10));
      }

      const distance = computeEditDistance(candidate, targetKey);
      if (Math.max(candidate.length, targetKey.length) >= 8 && distance <= 3) {
        score = Math.max(score, 78 - distance * 8);
      }
    }

    return Object.freeze({ record, score });
  })
    .filter((entry) => entry.score >= 64)
    .sort((a, b) => b.score - a.score || a.record.createdAt - b.record.createdAt);

  const [bestMatch, secondMatch] = scoredMatches;
  const match = bestMatch && (!secondMatch || bestMatch.score - secondMatch.score >= 8) ? bestMatch.record : null;

  if (!match || !fs.existsSync(match.storedPath)) {
    return null;
  }

  return match.storedPath;
}
