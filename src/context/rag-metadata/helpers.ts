/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Helper utilities shared by the RAG metadata modules.
 */

import type { TaskMemoryEntryRecord } from '../entities/rag-metadata';
import { TASK_MEMORY_MIN_ASSISTANT_CHARS } from './constants';

/**
 * Tokenizes free-form search text for lightweight lexical scoring.
 */
export function tokenizeQuery(text: string): readonly string[] {
  return Object.freeze(
    [...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .filter((token) => token.length >= 2),
    )].slice(0, 12),
  );
}

/**
 * Normalizes task memory text before persistence or comparison.
 */
export function normalizeTaskMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Checks whether a task memory entry is useful enough to persist.
 */
export function shouldPersistTaskMemoryEntry(entry: TaskMemoryEntryRecord): boolean {
  const assistantConclusion = normalizeTaskMemoryText(entry.assistantConclusion);
  const userIntent = normalizeTaskMemoryText(entry.userIntent);
  if (assistantConclusion.length < TASK_MEMORY_MIN_ASSISTANT_CHARS) {
    return false;
  }
  if (!userIntent) {
    return false;
  }
  const rejectedPatterns = [
    /^no final assistant response\.?$/i,
    /^attempting automatic repair/i,
    /^running (validation|review)/i,
  ];
  return !rejectedPatterns.some((pattern) => pattern.test(assistantConclusion));
}

/**
 * Safely parses a JSON array of strings from SQLite.
 */
export function safeParseStringArray(raw: string | null): readonly string[] {
  if (!raw) {
    return Object.freeze([]);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Object.freeze(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return Object.freeze([]);
  }
}

/**
 * Builds the canonical embedding document for one task memory entry.
 */
export function buildTaskMemoryEmbeddingDocument(entry: Readonly<{
  turnKind: string;
  userIntent: string;
  assistantConclusion: string;
  files: readonly string[];
  attachments: readonly string[];
}>): string {
  return [
    `Turn kind: ${entry.turnKind}`,
    `User intent: ${entry.userIntent}`,
    `Assistant conclusion: ${entry.assistantConclusion}`,
    entry.files.length > 0 ? `Files: ${entry.files.join(', ')}` : '',
    entry.attachments.length > 0 ? `Attachments: ${entry.attachments.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Parses an embedding vector serialized into SQLite.
 */
export function parseStoredEmbedding(raw: string): readonly number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? Object.freeze(parsed.filter((item): item is number => typeof item === 'number'))
      : null;
  } catch {
    return null;
  }
}
