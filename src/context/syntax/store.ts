/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Persistence and indexing orchestration helpers for the syntax index.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureProjectStorage, getProjectStorageInfo } from '../project-store';
import { syncSyntaxMetadata } from '../rag-metadata/metadata-sync';
import type { SyntaxFileRecord, SyntaxIndexStore } from '../entities/syntax-index';
import { IGNORED_SEGMENTS, MAX_CONTEXT_FILES, MAX_SCAN_DIRS, MAX_SCAN_FILES, MAX_SEED_FILES, SYNTAX_INDEX_VERSION } from './constants';
import { compareDirNames, createEmptyStore, isSupportedSourceFile, normalizeRelativePath, resolveWorkspaceRelativePath } from './helpers';
import { buildContextPaths } from './selection';
import { loadTypeScriptProjectConfig, parseSourceFile } from './typescript-parser';

/**
 * Loads the persisted syntax index store from disk.
 */
export function loadStore(workspacePath: string): SyntaxIndexStore {
  const projectStorage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(projectStorage);
  if (!fs.existsSync(projectStorage.syntaxIndexPath)) {
    return createEmptyStore(workspacePath);
  }
  try {
    const raw = fs.readFileSync(projectStorage.syntaxIndexPath, 'utf-8');
    const parsed = JSON.parse(raw) as SyntaxIndexStore;
    if (parsed.version !== SYNTAX_INDEX_VERSION || parsed.workspacePath !== workspacePath) {
      return createEmptyStore(workspacePath);
    }
    return Object.freeze({
      version: parsed.version,
      workspacePath: parsed.workspacePath,
      updatedAt: parsed.updatedAt,
      files: Object.freeze({ ...(parsed.files ?? {}) }),
    });
  } catch {
    return createEmptyStore(workspacePath);
  }
}

/**
 * Saves the syntax index store and mirrors lightweight metadata to SQLite.
 */
export function saveStore(workspacePath: string, store: SyntaxIndexStore): void {
  const projectStorage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(projectStorage);
  fs.writeFileSync(projectStorage.syntaxIndexPath, JSON.stringify(store, null, 2), 'utf-8');
  syncSyntaxMetadata(
    workspacePath,
    Object.values(store.files).map((record) =>
      Object.freeze({
        relativePath: record.relativePath,
        language: record.language,
        mtimeMs: record.mtimeMs,
        imports: record.imports,
        exports: record.exports,
        symbols: record.symbols,
      }),
    ),
  );
}

/**
 * Collects a bounded set of seed files that should stay warm in the syntax index.
 */
function collectWorkspaceSeedFiles(workspacePath: string, store: SyntaxIndexStore): readonly string[] {
  const queue: string[] = [workspacePath];
  const discovered: Array<Readonly<{ relativePath: string; mtimeMs: number; missing: boolean }>> = [];
  let scannedDirs = 0;
  let scannedFiles = 0;

  while (queue.length > 0 && scannedDirs < MAX_SCAN_DIRS && scannedFiles < MAX_SCAN_FILES) {
    const dirPath = queue.shift()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    scannedDirs += 1;
    const directories = entries.filter((entry) => entry.isDirectory()).sort((a, b) => compareDirNames(a.name, b.name));
    const files = entries.filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));

    for (const directory of directories) {
      const nextPath = path.join(dirPath, directory.name);
      const relativePath = path.relative(workspacePath, nextPath);
      const normalized = normalizeRelativePath(relativePath);
      if (!normalized || normalized.startsWith('..')) {
        continue;
      }
      if (normalized.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) {
        continue;
      }
      queue.push(nextPath);
    }

    for (const file of files) {
      if (scannedFiles >= MAX_SCAN_FILES) {
        break;
      }
      const fullPath = path.join(dirPath, file.name);
      const relativePath = resolveWorkspaceRelativePath(workspacePath, fullPath);
      if (!relativePath || !isSupportedSourceFile(relativePath)) {
        continue;
      }
      scannedFiles += 1;
      try {
        const stat = fs.statSync(fullPath);
        const current = store.files[relativePath];
        discovered.push(Object.freeze({
          relativePath,
          mtimeMs: stat.mtimeMs,
          missing: !current || current.mtimeMs !== stat.mtimeMs,
        }));
      } catch {
        continue;
      }
    }
  }

  return Object.freeze(
    discovered
      .sort((a, b) => (a.missing !== b.missing ? (a.missing ? -1 : 1) : a.relativePath.localeCompare(b.relativePath)))
      .slice(0, MAX_SEED_FILES)
      .map((entry) => entry.relativePath),
  );
}

/**
 * Ensures candidate files are indexed and returns the selected syntax records.
 */
export async function ensureIndexedFiles(
  workspacePath: string,
  candidateFiles: readonly string[],
  queryText: string,
): Promise<Readonly<{
  files: Readonly<Record<string, SyntaxFileRecord>>;
  records: readonly SyntaxFileRecord[];
  selection: Readonly<{
    primaryPaths: readonly string[];
    selectedPaths: readonly string[];
    definitionPaths: readonly string[];
    referencePaths: readonly string[];
  }>;
}>> {
  const normalizedCandidates = Object.freeze(
    [...new Set(candidateFiles)]
      .map((filePath) => resolveWorkspaceRelativePath(workspacePath, filePath))
      .filter((filePath): filePath is string => Boolean(filePath && isSupportedSourceFile(filePath)))
      .slice(0, MAX_CONTEXT_FILES),
  );

  const store = loadStore(workspacePath);
  const seedFiles = collectWorkspaceSeedFiles(workspacePath, store);
  const indexingTargets = Object.freeze([...new Set([...normalizedCandidates, ...seedFiles])]);
  if (indexingTargets.length === 0) {
    return Object.freeze({
      files: Object.freeze({}),
      records: Object.freeze([]),
      selection: Object.freeze({
        primaryPaths: Object.freeze([]),
        selectedPaths: Object.freeze([]),
        definitionPaths: Object.freeze([]),
        referencePaths: Object.freeze([]),
      }),
    });
  }

  const projectConfig = loadTypeScriptProjectConfig(workspacePath);
  const nextFiles: Record<string, SyntaxFileRecord> = { ...store.files };
  let changed = false;

  for (const relativePath of indexingTargets) {
    const absolutePath = path.join(workspacePath, relativePath);
    if (!fs.existsSync(absolutePath)) {
      if (relativePath in nextFiles) {
        delete nextFiles[relativePath];
        changed = true;
      }
      continue;
    }

    const stat = fs.statSync(absolutePath);
    const current = nextFiles[relativePath];
    if (!current || current.mtimeMs !== stat.mtimeMs) {
      const parsed = await parseSourceFile(workspacePath, relativePath, projectConfig);
      if (parsed) {
        nextFiles[relativePath] = parsed;
        changed = true;
      } else if (current) {
        delete nextFiles[relativePath];
        changed = true;
      }
    }
  }

  if (changed) {
    saveStore(
      workspacePath,
      Object.freeze({
        version: SYNTAX_INDEX_VERSION,
        workspacePath,
        updatedAt: Date.now(),
        files: Object.freeze(nextFiles),
      }),
    );
  }

  if (normalizedCandidates.length === 0) {
    return Object.freeze({
      files: Object.freeze(nextFiles),
      records: Object.freeze([]),
      selection: Object.freeze({
        primaryPaths: Object.freeze([]),
        selectedPaths: Object.freeze([]),
        definitionPaths: Object.freeze([]),
        referencePaths: Object.freeze([]),
      }),
    });
  }

  const selection = buildContextPaths(normalizedCandidates, nextFiles, queryText);
  return Object.freeze({
    files: Object.freeze(nextFiles),
    records: Object.freeze(
      selection.selectedPaths
        .map((relativePath) => nextFiles[relativePath])
        .filter((record): record is SyntaxFileRecord => Boolean(record)),
    ),
    selection,
  });
}
