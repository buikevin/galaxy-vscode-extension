/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Track session file changes, preserve original snapshots, and provide revert/diff summaries for the extension runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SESSION_LANGUAGE_LABELS } from '../shared/constants';
import type {
  ChangedFileSummary,
  OriginalSnapshot,
  RevertAllResult,
  RevertResult,
  SessionChangeSummary,
  TrackedFile,
  WorkspaceFileSnapshot,
} from '../shared/runtime';

const sessionFiles = new Map<string, TrackedFile>();
const originalSnapshots = new Map<string, OriginalSnapshot>();

/**
 * Detects a user-facing language label from the file extension.
 *
 * @param filePath File path whose extension should be mapped.
 * @returns Human-readable language label.
 */
export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return SESSION_LANGUAGE_LABELS[ext] ?? (ext ? ext.toUpperCase() : 'Unknown');
}

/**
 * Captures the original file content before the session edits the file for the first time.
 *
 * @param filePath File path that may be edited by the session.
 */
export function captureOriginal(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (originalSnapshots.has(resolved)) {
    return;
  }

  let content: string | null = null;
  try {
    if (fs.existsSync(resolved)) {
      content = fs.readFileSync(resolved, 'utf-8');
    }
  } catch {
    content = null;
  }

  originalSnapshots.set(resolved, Object.freeze({
    content,
    savedAt: Date.now(),
  }));
}

/**
 * Records that a file was written successfully by the current session.
 *
 * @param filePath File path that was just written or edited.
 */
export function trackFileWrite(filePath: string): void {
  const resolved = path.resolve(filePath);
  const snapshot = originalSnapshots.get(resolved);
  const wasNew = Boolean(snapshot && snapshot.content === null);

  sessionFiles.set(resolved, Object.freeze({
    filePath: resolved,
    language: detectLanguage(resolved),
    modifiedAt: Date.now(),
    wasNew,
  }));
}

/**
 * Reads the original content stored for a tracked file.
 *
 * @param filePath File path whose original snapshot should be returned.
 * @returns Original file content, `null` for newly created files, or `undefined` when untracked.
 */
export function getOriginalContent(filePath: string): string | null | undefined {
  return originalSnapshots.get(path.resolve(filePath))?.content;
}

/**
 * Determines whether a directory or file path should be skipped during workspace snapshot traversal.
 *
 * @param entryPath Absolute path under the workspace tree.
 * @returns `true` when the path should not be traversed or read.
 */
function shouldSkipPath(entryPath: string): boolean {
  const name = path.basename(entryPath);
  return (
    name.startsWith('.') ||
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'out' ||
    name === 'build' ||
    name === 'coverage' ||
    name === '.turbo' ||
    name === '.next' ||
    name === '.nuxt'
  );
}

/**
 * Recursively collects textual workspace files for snapshot-based change detection.
 *
 * @param dirPath Directory currently being traversed.
 * @param files Mutable output array of captured file snapshots.
 * @param depth Current recursion depth used to enforce the traversal limit.
 */
function collectWorkspaceFiles(dirPath: string, files: WorkspaceFileSnapshot[], depth = 0): void {
  if (depth > 8 || !fs.existsSync(dirPath)) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (shouldSkipPath(fullPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      collectWorkspaceFiles(fullPath, files, depth + 1);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      files.push(Object.freeze({
        filePath: path.resolve(fullPath),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        content,
      }));
    } catch {
      continue;
    }
  }
}

/**
 * Captures a shallow textual snapshot of the workspace tree for later change detection.
 *
 * @param workspacePath Workspace root to snapshot.
 * @returns Map keyed by absolute file path.
 */
export function captureWorkspaceSnapshot(workspacePath: string): ReadonlyMap<string, WorkspaceFileSnapshot> {
  const files: WorkspaceFileSnapshot[] = [];
  collectWorkspaceFiles(path.resolve(workspacePath), files);
  return new Map(files.map((file) => [file.filePath, file] as const));
}

/**
 * Compares two workspace snapshots and records any new, changed, or deleted files as session writes.
 *
 * @param workspacePath Workspace root being tracked.
 * @param before Snapshot captured before a command or agent action.
 * @returns Changed paths detected between the snapshots.
 */
export function trackWorkspaceChanges(
  workspacePath: string,
  before: ReadonlyMap<string, WorkspaceFileSnapshot>,
): readonly string[] {
  const after = captureWorkspaceSnapshot(workspacePath);
  const changedPaths = new Set<string>();

  for (const [filePath, snapshot] of after.entries()) {
    const previous = before.get(filePath);
    if (!previous) {
      captureOriginalFromWorkspaceSnapshot(filePath, null);
      trackFileWrite(filePath);
      changedPaths.add(filePath);
      continue;
    }

    if (previous.mtimeMs !== snapshot.mtimeMs || previous.size !== snapshot.size) {
      captureOriginalFromWorkspaceSnapshot(filePath, previous);
      trackFileWrite(filePath);
      changedPaths.add(filePath);
    }
  }

  for (const filePath of before.keys()) {
    if (!after.has(filePath)) {
      captureOriginalFromWorkspaceSnapshot(filePath, before.get(filePath) ?? null);
      trackFileWrite(filePath);
      changedPaths.add(filePath);
    }
  }

  return Object.freeze([...changedPaths]);
}

/**
 * Saves an original snapshot from a previously captured workspace snapshot instead of rereading the file.
 *
 * @param filePath File path being tracked.
 * @param snapshot Snapshot captured before the file changed, or `null` for deleted/new files.
 */
function captureOriginalFromWorkspaceSnapshot(
  filePath: string,
  snapshot: WorkspaceFileSnapshot | null,
): void {
  const resolved = path.resolve(filePath);
  if (originalSnapshots.has(resolved)) {
    return;
  }

  originalSnapshots.set(resolved, Object.freeze({
    content: snapshot?.content ?? null,
    savedAt: Date.now(),
  }));
}

/**
 * Reverts one tracked file back to the original snapshot captured before the session edited it.
 *
 * @param filePath File path to revert.
 * @returns Revert result describing success or failure.
 */
export function revertFile(filePath: string): RevertResult {
  const resolved = path.resolve(filePath);
  const snapshot = originalSnapshots.get(resolved);
  if (!snapshot) {
    return Object.freeze({
      success: false,
      reason: `File "${filePath}" is not tracked in this session.`,
    });
  }

  try {
    if (snapshot.content === null) {
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
      sessionFiles.delete(resolved);
      originalSnapshots.delete(resolved);
      return Object.freeze({
        success: true,
        wasNew: true,
        filePath: resolved,
      });
    }

    fs.writeFileSync(resolved, snapshot.content, 'utf-8');
    sessionFiles.delete(resolved);
    originalSnapshots.delete(resolved);
    return Object.freeze({
      success: true,
      wasNew: false,
      filePath: resolved,
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      reason: `Failed to revert ${filePath}: ${String(error)}`,
    });
  }
}

/**
 * Returns tracked files that still exist on disk, ordered by modification time.
 *
 * @returns Session files sorted by their last recorded modification time.
 */
export function getSessionFiles(): readonly TrackedFile[] {
  return Object.freeze(
    [...sessionFiles.values()]
      .filter((tracked) => fs.existsSync(tracked.filePath))
      .sort((left, right) => left.modifiedAt - right.modifiedAt),
  );
}

/**
 * Builds a unified diff between the original and current file contents.
 *
 * @param filePath File path whose diff is being formatted.
 * @param originalContent Original snapshot content.
 * @param currentContent Current on-disk content.
 * @returns Unified diff text.
 */
function buildUnifiedDiff(filePath: string, originalContent: string, currentContent: string): string {
  const originalLines = originalContent.split('\n');
  const currentLines = currentContent.split('\n');

  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < currentLines.length &&
    originalLines[prefix] === currentLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < currentLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] === currentLines[currentLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const originalChanged = originalLines.slice(prefix, originalLines.length - suffix);
  const currentChanged = currentLines.slice(prefix, currentLines.length - suffix);
  const oldStart = prefix + 1;
  const newStart = prefix + 1;
  const oldCount = originalChanged.length;
  const newCount = currentChanged.length;

  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...originalChanged.map((line) => `-${line}`),
    ...currentChanged.map((line) => `+${line}`),
  ].join('\n');
}

/**
 * Counts added and deleted lines from two text snapshots.
 *
 * @param originalContent Original snapshot content.
 * @param currentContent Current content.
 * @returns Added/deleted line counts.
 */
function countLineStats(originalContent: string | null, currentContent: string | null): Readonly<{ addedLines: number; deletedLines: number }> {
  if (originalContent === null && currentContent !== null) {
    return Object.freeze({
      addedLines: currentContent.split('\n').length,
      deletedLines: 0,
    });
  }

  if (originalContent !== null && currentContent === null) {
    return Object.freeze({
      addedLines: 0,
      deletedLines: originalContent.split('\n').length,
    });
  }

  const originalLines = (originalContent ?? '').split('\n');
  const currentLines = (currentContent ?? '').split('\n');

  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < currentLines.length &&
    originalLines[prefix] === currentLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < currentLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] === currentLines[currentLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return Object.freeze({
    deletedLines: Math.max(0, originalLines.length - prefix - suffix),
    addedLines: Math.max(0, currentLines.length - prefix - suffix),
  });
}

/**
 * Summarizes all tracked workspace changes for UI panels, review, and validation.
 *
 * @returns Aggregate session change summary.
 */
export function getSessionChangeSummary(): SessionChangeSummary {
  const files = getSessionFiles().map((tracked) => {
    const originalContent = getOriginalContent(tracked.filePath) ?? null;
    const currentContent = fs.existsSync(tracked.filePath)
      ? fs.readFileSync(tracked.filePath, 'utf-8')
      : null;
    const stats = countLineStats(originalContent, currentContent);
    const relativePath = path.basename(tracked.filePath);
    const diffText =
      originalContent !== null && currentContent !== null
        ? buildUnifiedDiff(relativePath, originalContent, currentContent)
        : originalContent === null
          ? currentContent ?? ''
          : originalContent ?? '';

    return Object.freeze({
      filePath: tracked.filePath,
      language: tracked.language,
      wasNew: tracked.wasNew,
      addedLines: stats.addedLines,
      deletedLines: stats.deletedLines,
      originalContent,
      currentContent,
      diffText,
    });
  });

  return Object.freeze({
    fileCount: files.length,
    createdCount: files.filter((file) => file.wasNew).length,
    addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    deletedLines: files.reduce((sum, file) => sum + file.deletedLines, 0),
    files: Object.freeze(files),
  });
}

/**
 * Reverts every tracked file in the session.
 *
 * @returns Aggregate revert result for the whole session.
 */
export function revertAllSessionFiles(): RevertAllResult {
  const revertedPaths: string[] = [];
  const failedReasons: string[] = [];

  for (const tracked of [...sessionFiles.values()]) {
    const result = revertFile(tracked.filePath);
    if (result.success) {
      revertedPaths.push(result.filePath);
    } else {
      failedReasons.push(result.reason);
    }
  }

  return Object.freeze({
    revertedPaths: Object.freeze(revertedPaths),
    failedReasons: Object.freeze(failedReasons),
  });
}

/**
 * Clears all in-memory session tracking state.
 */
export function clearSession(): void {
  sessionFiles.clear();
  originalSnapshots.clear();
}
