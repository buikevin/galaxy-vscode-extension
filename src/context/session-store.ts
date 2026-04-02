/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Loads, migrates, and persists workspace session memory snapshots.
 */

import fs from 'node:fs';
import { normalizeActiveProjectPath } from './active-project';
import type { ActiveTaskMemory, ProjectMemory, SessionMemory, TurnDigest } from './entities/history';
import {
  createEmptyActiveTaskMemory,
  createEmptyProjectMemory,
  deriveCombinedKeyFiles,
  normalizeActiveTaskMemory,
  normalizeProjectMemory,
} from './memory-format';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';

/**
 * Returns true when a value is a string array.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Returns true when a value is a plain JSON-like object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts unknown input into a frozen string array.
 */
function toStringArray(value: unknown): readonly string[] {
  return isStringArray(value) ? Object.freeze(value) : Object.freeze([]);
}

/**
 * Revives persisted active-task memory into the normalized in-memory shape.
 */
function reviveActiveTaskMemory(value: unknown, now: number): ActiveTaskMemory {
  if (!isPlainObject(value)) {
    return createEmptyActiveTaskMemory(now);
  }

  return normalizeActiveTaskMemory(
    Object.freeze({
      taskId: typeof value.taskId === 'string' ? value.taskId : null,
      originalUserGoal: typeof value.originalUserGoal === 'string' ? value.originalUserGoal : '',
      currentObjective: typeof value.currentObjective === 'string' ? value.currentObjective : '',
      definitionOfDone: toStringArray(value.definitionOfDone),
      completedSteps: toStringArray(value.completedSteps),
      pendingSteps: toStringArray(value.pendingSteps),
      blockers: toStringArray(value.blockers),
      filesTouched: toStringArray(value.filesTouched),
      keyFiles: toStringArray(value.keyFiles),
      attachments: toStringArray(value.attachments),
      deniedCommands: toStringArray(value.deniedCommands),
      recentTurnSummaries: toStringArray(value.recentTurnSummaries),
      handoffSummary: typeof value.handoffSummary === 'string' ? value.handoffSummary : '',
      lastUpdatedAt: typeof value.lastUpdatedAt === 'number' ? value.lastUpdatedAt : now,
    }),
  );
}

/**
 * Revives persisted project memory into the normalized in-memory shape.
 */
function reviveProjectMemory(value: unknown, now: number): ProjectMemory {
  if (!isPlainObject(value)) {
    return createEmptyProjectMemory(now);
  }

  return normalizeProjectMemory(
    Object.freeze({
      summary: typeof value.summary === 'string' ? value.summary : '',
      conventions: toStringArray(value.conventions),
      recurringPitfalls: toStringArray(value.recurringPitfalls),
      recentDecisions: toStringArray(value.recentDecisions),
      keyFiles: toStringArray(value.keyFiles),
      lastUpdatedAt: typeof value.lastUpdatedAt === 'number' ? value.lastUpdatedAt : now,
    }),
  );
}

/**
 * Revives legacy recent digests stored before the current session-memory schema.
 */
function reviveLegacyRecentDigests(value: unknown): readonly TurnDigest[] {
  return Object.freeze(Array.isArray(value) ? (value as TurnDigest[]) : []);
}

/**
 * Migrates one legacy session-memory payload into the current normalized schema.
 */
function migrateLegacySessionMemory(
  workspaceId: string,
  workspacePath: string,
  parsed: Record<string, unknown>,
): SessionMemory {
  const now = Date.now();
  const recentDigests = reviveLegacyRecentDigests(parsed.recentDigests);
  const openItems = toStringArray(parsed.openItems);
  const legacyKeyFiles = toStringArray(parsed.keyFiles);
  const recentTurnSummaries = recentDigests
    .map((digest) => {
      const userMessage = typeof digest.userMessage === 'string' ? digest.userMessage : '';
      const assistantSummary = typeof digest.assistantSummary === 'string' ? digest.assistantSummary : '';
      return [userMessage ? `User: ${userMessage}` : '', assistantSummary ? `Assistant: ${assistantSummary}` : '']
        .filter(Boolean)
        .join(' | ');
    })
    .filter(Boolean);
  const recentFiles = recentDigests.flatMap((digest) =>
    Array.isArray(digest.filesTouched) ? digest.filesTouched.filter((item): item is string => typeof item === 'string') : [],
  );

  const activeTaskMemory = normalizeActiveTaskMemory(
    Object.freeze({
      taskId: null,
      originalUserGoal:
        recentDigests.length > 0 && typeof recentDigests[recentDigests.length - 1]?.userMessage === 'string'
          ? recentDigests[recentDigests.length - 1]!.userMessage
          : '',
      currentObjective: '',
      definitionOfDone: Object.freeze([]),
      completedSteps: Object.freeze([]),
      pendingSteps: openItems,
      blockers: Object.freeze([]),
      filesTouched: Object.freeze(recentFiles),
      keyFiles: legacyKeyFiles,
      attachments: Object.freeze([]),
      deniedCommands: Object.freeze([]),
      recentTurnSummaries: Object.freeze(recentTurnSummaries),
      handoffSummary: typeof parsed.rollingSummary === 'string' ? parsed.rollingSummary : '',
      lastUpdatedAt: typeof parsed.lastUpdatedAt === 'number' ? parsed.lastUpdatedAt : now,
    }),
  );

  const projectMemory = normalizeProjectMemory(
    Object.freeze({
      summary: typeof parsed.rollingSummary === 'string' ? parsed.rollingSummary : '',
      conventions: Object.freeze([]),
      recurringPitfalls: Object.freeze([]),
      recentDecisions: Object.freeze([]),
      keyFiles: legacyKeyFiles,
      lastUpdatedAt: typeof parsed.lastUpdatedAt === 'number' ? parsed.lastUpdatedAt : now,
    }),
  );

  return Object.freeze({
    workspaceId,
    workspacePath,
    activeProjectPath: undefined,
    activeTaskMemory,
    projectMemory,
    lastFinalAssistantConclusion:
      recentDigests.length > 0 && typeof recentDigests[recentDigests.length - 1]?.assistantSummary === 'string'
        ? recentDigests[recentDigests.length - 1]!.assistantSummary
        : '',
    keyFiles: deriveCombinedKeyFiles(activeTaskMemory, projectMemory),
    lastUpdatedAt: typeof parsed.lastUpdatedAt === 'number' ? parsed.lastUpdatedAt : now,
  });
}

/**
 * Creates an empty session memory snapshot for a workspace with fresh timestamps.
 */
export function createEmptySessionMemory(workspacePath: string): SessionMemory {
  const info = getProjectStorageInfo(workspacePath);
  const now = Date.now();
  const activeTaskMemory = createEmptyActiveTaskMemory(now);
  const projectMemory = createEmptyProjectMemory(now);

  return Object.freeze({
    workspaceId: info.workspaceId,
    workspacePath: info.workspacePath,
    activeProjectPath: undefined,
    activeTaskMemory,
    projectMemory,
    lastFinalAssistantConclusion: '',
    keyFiles: deriveCombinedKeyFiles(activeTaskMemory, projectMemory),
    lastUpdatedAt: now,
  });
}

/**
 * Returns the absolute path of the session memory file for one workspace.
 */
export function getSessionStorePath(workspacePath: string): string {
  const info = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(info);
  return info.sessionMemoryPath;
}

/**
 * Loads, validates, and migrates one persisted session memory snapshot.
 */
export function loadSessionMemory(workspacePath: string): SessionMemory | null {
  const filePath = getSessionStorePath(workspacePath);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }
    if (typeof parsed.workspaceId !== 'string') {
      return null;
    }
    if (typeof parsed.workspacePath !== 'string') {
      return null;
    }
    if (typeof parsed.lastUpdatedAt !== 'number') {
      return null;
    }

    if (!('activeTaskMemory' in parsed) || !('projectMemory' in parsed)) {
      return migrateLegacySessionMemory(parsed.workspaceId, parsed.workspacePath, parsed);
    }

    const now = Date.now();
    const activeTaskMemory = reviveActiveTaskMemory(parsed.activeTaskMemory, now);
    const projectMemory = reviveProjectMemory(parsed.projectMemory, now);

    return Object.freeze({
      workspaceId: parsed.workspaceId,
      workspacePath: parsed.workspacePath,
      activeProjectPath: normalizeActiveProjectPath(
        parsed.workspacePath,
        typeof parsed.activeProjectPath === 'string' ? parsed.activeProjectPath : undefined,
      ),
      activeTaskMemory,
      projectMemory,
      lastFinalAssistantConclusion:
        typeof parsed.lastFinalAssistantConclusion === 'string' ? parsed.lastFinalAssistantConclusion : '',
      keyFiles: deriveCombinedKeyFiles(activeTaskMemory, projectMemory),
      lastUpdatedAt: parsed.lastUpdatedAt,
    });
  } catch {
    return null;
  }
}

/**
 * Persists one normalized session memory snapshot to disk.
 */
export function saveSessionMemory(memory: SessionMemory): void {
  const filePath = getSessionStorePath(memory.workspacePath);
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), 'utf-8');
}
