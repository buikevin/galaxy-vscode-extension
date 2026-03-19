import fs from 'node:fs';
import type { ActiveTaskMemory, ProjectMemory, SessionMemory, TurnDigest } from './history-types';
import {
  createEmptyActiveTaskMemory,
  createEmptyProjectMemory,
  deriveCombinedKeyFiles,
  normalizeActiveTaskMemory,
  normalizeProjectMemory,
} from './memory-format';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): readonly string[] {
  return isStringArray(value) ? Object.freeze(value) : Object.freeze([]);
}

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

function reviveLegacyRecentDigests(value: unknown): readonly TurnDigest[] {
  return Object.freeze(Array.isArray(value) ? (value as TurnDigest[]) : []);
}

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
    activeTaskMemory,
    projectMemory,
    keyFiles: deriveCombinedKeyFiles(activeTaskMemory, projectMemory),
    lastUpdatedAt: typeof parsed.lastUpdatedAt === 'number' ? parsed.lastUpdatedAt : now,
  });
}

export function createEmptySessionMemory(workspacePath: string): SessionMemory {
  const info = getProjectStorageInfo(workspacePath);
  const now = Date.now();
  const activeTaskMemory = createEmptyActiveTaskMemory(now);
  const projectMemory = createEmptyProjectMemory(now);

  return Object.freeze({
    workspaceId: info.workspaceId,
    workspacePath: info.workspacePath,
    activeTaskMemory,
    projectMemory,
    keyFiles: deriveCombinedKeyFiles(activeTaskMemory, projectMemory),
    lastUpdatedAt: now,
  });
}

export function getSessionStorePath(workspacePath: string): string {
  const info = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(info);
  return info.sessionMemoryPath;
}

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
      activeTaskMemory,
      projectMemory,
      keyFiles: deriveCombinedKeyFiles(activeTaskMemory, projectMemory),
      lastUpdatedAt: parsed.lastUpdatedAt,
    });
  } catch {
    return null;
  }
}

export function saveSessionMemory(memory: SessionMemory): void {
  const filePath = getSessionStorePath(memory.workspacePath);
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), 'utf-8');
}
