/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Normalization and formatting helpers for active task and project memory.
 */

import { estimateTokens } from './compaction';
import {
  MAX_ACTIVE_LIST_ITEMS,
  MAX_HANDOFF_SUMMARY_CHARS,
  MAX_KEY_FILES,
  MAX_PROJECT_DECISIONS,
  MAX_PROJECT_SUMMARY_CHARS,
} from './entities/constants';
import type { ActiveTaskMemory, ProjectMemory } from './entities/history';

/**
 * Deduplicates and trims one memory list while preserving recency.
 */
function normalizeList(items: readonly string[], maxItems: number): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return Object.freeze(normalized.slice(-maxItems));
}

/**
 * Produces a bounded single-line summary for memory fields.
 */
function summarizeText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

/**
 * Appends a titled list block into a memory content buffer.
 */
function pushList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(title);
  items.forEach((item) => {
    lines.push(`- ${item}`);
  });
  lines.push('');
}

/**
 * Creates an empty active task memory snapshot.
 */
export function createEmptyActiveTaskMemory(now = Date.now()): ActiveTaskMemory {
  return Object.freeze({
    taskId: null,
    originalUserGoal: '',
    currentObjective: '',
    definitionOfDone: Object.freeze([]),
    completedSteps: Object.freeze([]),
    pendingSteps: Object.freeze([]),
    blockers: Object.freeze([]),
    filesTouched: Object.freeze([]),
    keyFiles: Object.freeze([]),
    attachments: Object.freeze([]),
    deniedCommands: Object.freeze([]),
    recentTurnSummaries: Object.freeze([]),
    handoffSummary: '',
    lastUpdatedAt: now,
  });
}

/**
 * Creates an empty project memory snapshot.
 */
export function createEmptyProjectMemory(now = Date.now()): ProjectMemory {
  return Object.freeze({
    summary: '',
    conventions: Object.freeze([]),
    recurringPitfalls: Object.freeze([]),
    recentDecisions: Object.freeze([]),
    keyFiles: Object.freeze([]),
    lastUpdatedAt: now,
  });
}

/**
 * Derives the combined key file list shared across prompt retrieval.
 */
export function deriveCombinedKeyFiles(
  activeTaskMemory: ActiveTaskMemory,
  projectMemory: ProjectMemory,
): readonly string[] {
  return normalizeList(
    [...activeTaskMemory.keyFiles, ...activeTaskMemory.filesTouched, ...projectMemory.keyFiles],
    MAX_KEY_FILES,
  );
}

/**
 * Normalizes active task memory into bounded, deduplicated fields.
 */
export function normalizeActiveTaskMemory(memory: ActiveTaskMemory): ActiveTaskMemory {
  return Object.freeze({
    ...memory,
    originalUserGoal: summarizeText(memory.originalUserGoal, 800),
    currentObjective: summarizeText(memory.currentObjective, 800),
    definitionOfDone: normalizeList(memory.definitionOfDone, MAX_ACTIVE_LIST_ITEMS),
    completedSteps: normalizeList(memory.completedSteps, MAX_ACTIVE_LIST_ITEMS),
    pendingSteps: normalizeList(memory.pendingSteps, MAX_ACTIVE_LIST_ITEMS),
    blockers: normalizeList(memory.blockers, 6),
    filesTouched: normalizeList(memory.filesTouched, MAX_KEY_FILES),
    keyFiles: normalizeList(memory.keyFiles, MAX_KEY_FILES),
    attachments: normalizeList(memory.attachments, MAX_ACTIVE_LIST_ITEMS),
    deniedCommands: normalizeList(memory.deniedCommands, MAX_ACTIVE_LIST_ITEMS),
    recentTurnSummaries: normalizeList(
      memory.recentTurnSummaries.map((item) => summarizeText(item, 240)),
      6,
    ),
    handoffSummary: summarizeText(memory.handoffSummary, MAX_HANDOFF_SUMMARY_CHARS),
  });
}

/**
 * Normalizes project memory into bounded, deduplicated fields.
 */
export function normalizeProjectMemory(memory: ProjectMemory): ProjectMemory {
  return Object.freeze({
    ...memory,
    summary: summarizeText(memory.summary, MAX_PROJECT_SUMMARY_CHARS),
    conventions: normalizeList(memory.conventions, 8),
    recurringPitfalls: normalizeList(memory.recurringPitfalls, 8),
    recentDecisions: normalizeList(
      memory.recentDecisions.map((item) => summarizeText(item, 240)),
      MAX_PROJECT_DECISIONS,
    ),
    keyFiles: normalizeList(memory.keyFiles, MAX_KEY_FILES),
  });
}

/**
 * Builds the prompt block for active task memory.
 */
export function buildActiveTaskMemoryContent(memory: ActiveTaskMemory): string {
  const normalized = normalizeActiveTaskMemory(memory);
  const lines: string[] = [];

  if (normalized.originalUserGoal) {
    lines.push('[ACTIVE TASK MEMORY]');
    lines.push(`Original goal: ${normalized.originalUserGoal}`);
    if (normalized.currentObjective) {
      lines.push(`Current objective: ${normalized.currentObjective}`);
    }
    lines.push('');
  }

  pushList(lines, 'Definition of done:', normalized.definitionOfDone);
  pushList(lines, 'Completed:', normalized.completedSteps);
  pushList(lines, 'Pending:', normalized.pendingSteps);
  pushList(lines, 'Blockers:', normalized.blockers);
  pushList(lines, 'Attachments:', normalized.attachments);
  pushList(lines, 'Denied commands:', normalized.deniedCommands);
  pushList(lines, 'Files touched:', normalized.filesTouched);
  pushList(lines, 'Key files:', normalized.keyFiles);
  pushList(lines, 'Recent handoffs:', normalized.recentTurnSummaries);

  if (normalized.handoffSummary) {
    lines.push('Latest handoff:');
    lines.push(normalized.handoffSummary);
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Builds the prompt block for project memory.
 */
export function buildProjectMemoryContent(memory: ProjectMemory): string {
  const normalized = normalizeProjectMemory(memory);
  const lines: string[] = [];

  if (normalized.summary) {
    lines.push('[PROJECT MEMORY]');
    lines.push(normalized.summary);
    lines.push('');
  }

  pushList(lines, 'Conventions:', normalized.conventions);
  pushList(lines, 'Recurring pitfalls:', normalized.recurringPitfalls);
  pushList(lines, 'Recent decisions:', normalized.recentDecisions);
  pushList(lines, 'Project key files:', normalized.keyFiles);

  return lines.join('\n').trim();
}

/**
 * Estimates token usage for the active task memory block.
 */
export function estimateActiveTaskMemoryTokens(memory: ActiveTaskMemory): number {
  return estimateTokens(buildActiveTaskMemoryContent(memory));
}

/**
 * Estimates token usage for the project memory block.
 */
export function estimateProjectMemoryTokens(memory: ProjectMemory): number {
  return estimateTokens(buildProjectMemoryContent(memory));
}
