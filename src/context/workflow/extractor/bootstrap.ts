/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-07
 * @modify date 2026-05-07
 * @desc One-shot workflow graph bootstrap that primes the per-file index from previous sessions and entry-point manifests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getProjectStorageInfo } from '../../project-store';
import { withRagMetadataDatabase } from '../../rag-metadata/database';
import { isSupportedSourceFile, resolveWorkspaceRelativePath } from './files';
import { noteFileTouchedForGraph } from './touch-queue';

/**
 * Maximum number of manifest-derived entry-point files to prime per workspace.
 * Bootstrap stays cheap; the touch queue keeps growing the graph as the agent reads more files.
 */
const MAX_ENTRYPOINT_FILES = 50;

/** Heuristic entry-point directories that frequently contain routes/controllers/components. */
const ENTRYPOINT_DIRECTORIES: readonly string[] = Object.freeze([
  'src',
  'app',
  'lib',
  'pages',
  'routes',
  'controllers',
  'components',
  'features',
  'modules',
  'api',
  'server',
  'backend',
  'frontend',
]);

/**
 * Outcome describing how many files were enqueued from each bootstrap source.
 */
export type BootstrapWorkflowGraphResult = Readonly<{
  /** Files enqueued because the previous session had cached read content for them. */
  fromReadCache: number;
  /** Files enqueued because the previous session recorded read events. */
  fromFileReads: number;
  /** Files enqueued from heuristic entry-point manifest scanning. */
  fromEntryPoints: number;
}>;

/**
 * Primes the workflow graph touch queue from previous-session SQLite ledgers and entry-point scanning.
 *
 * Always non-blocking: even if the workspace has zero prior state, the function returns quickly
 * after enqueuing a small set of plausible entry-point files. Errors are swallowed so a corrupted
 * ledger never prevents extension activation or CLI startup.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Counts indicating how many files were enqueued from each source.
 */
export function bootstrapWorkflowGraph(workspacePath: string): BootstrapWorkflowGraphResult {
  const enqueued = new Set<string>();
  let fromReadCache = 0;
  let fromFileReads = 0;
  let fromEntryPoints = 0;

  try {
    const storage = getProjectStorageInfo(workspacePath);
    if (fs.existsSync(storage.ragMetadataDbPath)) {
      const previousFiles = collectPreviousSessionFiles(workspacePath);
      previousFiles.cachedReads.forEach((relPath) => {
        if (enqueueIfNew(workspacePath, relPath, enqueued)) {
          fromReadCache += 1;
        }
      });
      previousFiles.fileReads.forEach((relPath) => {
        if (enqueueIfNew(workspacePath, relPath, enqueued)) {
          fromFileReads += 1;
        }
      });
    }
  } catch {
    /* never throw on corrupted previous state */
  }

  try {
    const entryPoints = scanEntryPointFiles(workspacePath, MAX_ENTRYPOINT_FILES);
    entryPoints.forEach((relPath) => {
      if (enqueueIfNew(workspacePath, relPath, enqueued)) {
        fromEntryPoints += 1;
      }
    });
  } catch {
    /* never throw on filesystem traversal errors */
  }

  return Object.freeze({ fromReadCache, fromFileReads, fromEntryPoints });
}

/**
 * Enqueues a relative path with the touch queue when it has not been enqueued already in this batch.
 *
 * @param workspacePath Absolute workspace root.
 * @param relativePath Workspace-relative file path.
 * @param enqueued Mutable dedup set tracking already-queued paths.
 * @returns True when the path was newly enqueued.
 */
function enqueueIfNew(workspacePath: string, relativePath: string, enqueued: Set<string>): boolean {
  if (enqueued.has(relativePath)) {
    return false;
  }
  enqueued.add(relativePath);
  noteFileTouchedForGraph(workspacePath, relativePath);
  return true;
}

/**
 * Reads previous-session file paths from the `read_cache` and `file_reads` SQLite tables.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Two ordered arrays of workspace-relative file paths recovered from each ledger.
 */
function collectPreviousSessionFiles(workspacePath: string): {
  cachedReads: readonly string[];
  fileReads: readonly string[];
} {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const cachedRows = db
      .prepare(
        `SELECT DISTINCT file_path FROM read_cache ORDER BY updated_at DESC LIMIT ${MAX_ENTRYPOINT_FILES}`,
      )
      .all() as Array<{ file_path: string }>;
    const fileReadRows = db
      .prepare(
        `SELECT DISTINCT file_path FROM file_reads ORDER BY created_at DESC LIMIT ${MAX_ENTRYPOINT_FILES}`,
      )
      .all() as Array<{ file_path: string }>;
    const filterAndNormalize = (rows: Array<{ file_path: string }>): readonly string[] => {
      const out: string[] = [];
      for (const row of rows) {
        const rel = resolveWorkspaceRelativePath(workspacePath, row.file_path);
        if (rel && isSupportedSourceFile(rel)) {
          out.push(rel);
        }
      }
      return out;
    };
    return {
      cachedReads: filterAndNormalize(cachedRows),
      fileReads: filterAndNormalize(fileReadRows),
    };
  });
}

/**
 * Walks a curated set of entry-point directories to find supported source files for priming.
 *
 * @param workspacePath Absolute workspace root path.
 * @param limit Maximum number of file paths to return overall.
 * @returns Workspace-relative file paths to prime, capped by the limit.
 */
function scanEntryPointFiles(workspacePath: string, limit: number): readonly string[] {
  const results: string[] = [];
  for (const dirName of ENTRYPOINT_DIRECTORIES) {
    if (results.length >= limit) {
      break;
    }
    const dirPath = path.join(workspacePath, dirName);
    let exists = false;
    try {
      exists = fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      continue;
    }
    walkDirectoryForSupportedFiles(workspacePath, dirPath, results, limit);
  }
  if (results.length < limit) {
    let workspaceEntries: string[] = [];
    try {
      workspaceEntries = fs.readdirSync(workspacePath);
    } catch {
      workspaceEntries = [];
    }
    for (const entry of workspaceEntries) {
      if (results.length >= limit) {
        break;
      }
      const rel = resolveWorkspaceRelativePath(workspacePath, path.join(workspacePath, entry));
      if (rel && isSupportedSourceFile(rel) && !results.includes(rel)) {
        results.push(rel);
      }
    }
  }
  return results.slice(0, limit);
}

/** Maximum directory depth scanned during bootstrap to keep the work bounded. */
const MAX_BOOTSTRAP_DEPTH = 4;

/** Directory segments skipped during bootstrap traversal. */
const SKIP_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.galaxy',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

/**
 * Recursively collects supported source files into `results` until the limit is reached.
 *
 * @param workspacePath Absolute workspace root used for relative-path resolution.
 * @param currentDir Directory currently being traversed.
 * @param results Mutable accumulator of workspace-relative paths.
 * @param limit Maximum number of paths to collect across the entire traversal.
 * @param depth Current recursion depth (caller passes 0).
 */
function walkDirectoryForSupportedFiles(
  workspacePath: string,
  currentDir: string,
  results: string[],
  limit: number,
  depth = 0,
): void {
  if (results.length >= limit || depth > MAX_BOOTSTRAP_DEPTH) {
    return;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= limit) {
      return;
    }
    if (SKIP_SEGMENTS.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    const childPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkDirectoryForSupportedFiles(workspacePath, childPath, results, limit, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const rel = resolveWorkspaceRelativePath(workspacePath, childPath);
    if (rel && isSupportedSourceFile(rel) && !results.includes(rel)) {
      results.push(rel);
    }
  }
}
