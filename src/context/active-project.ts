/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Detects nested project roots so retrieval and workflow graph refresh can target the real active project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectStorageInfo } from './project-store';

const PROJECT_ROOT_MARKER_NAMES = Object.freeze([
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'pubspec.yaml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
]);

/**
 * Returns true when a candidate path stays inside the workspace boundary.
 *
 * @param workspacePath Absolute workspace root.
 * @param candidatePath Absolute candidate path to validate.
 * @returns `true` when the candidate remains inside the workspace.
 */
function isWithinWorkspace(workspacePath: string, candidatePath: string): boolean {
  const relativePath = path.relative(workspacePath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * Resolves an absolute or workspace-relative path against the opened workspace root.
 *
 * @param workspacePath Absolute opened workspace root path.
 * @param filePath Absolute or workspace-relative file path.
 * @returns Absolute in-workspace file path or `null` when the path escapes the workspace.
 */
function resolveWorkspaceAbsolutePath(workspacePath: string, filePath: string): string | null {
  const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspacePath, filePath);
  return isWithinWorkspace(workspacePath, absolutePath) ? absolutePath : null;
}

/**
 * Returns true when the directory contains a known project-root marker file.
 *
 * @param directoryPath Absolute directory path to inspect.
 * @returns `true` when at least one project marker exists inside the directory.
 */
function hasProjectRootMarker(directoryPath: string): boolean {
  return PROJECT_ROOT_MARKER_NAMES.some((markerName) => fs.existsSync(path.join(directoryPath, markerName)));
}

/**
 * Normalizes a candidate active-project path and removes redundant workspace-root values.
 *
 * @param workspacePath Absolute opened workspace root path.
 * @param activeProjectPath Candidate nested project root path.
 * @returns Normalized nested project root or `undefined` when it is invalid or equal to the workspace root.
 */
export function normalizeActiveProjectPath(workspacePath: string, activeProjectPath?: string): string | undefined {
  if (!activeProjectPath || !activeProjectPath.trim()) {
    return undefined;
  }

  const resolvedWorkspacePath = path.resolve(workspacePath);
  const resolvedProjectPath = path.resolve(activeProjectPath);
  if (!isWithinWorkspace(resolvedWorkspacePath, resolvedProjectPath)) {
    return undefined;
  }
  if (resolvedProjectPath === resolvedWorkspacePath) {
    return undefined;
  }
  return resolvedProjectPath;
}

/**
 * Finds the nearest project root that owns a given file path.
 *
 * @param workspacePath Absolute opened workspace root path.
 * @param filePath Absolute or workspace-relative file path.
 * @returns Absolute detected project root or `null` when no project marker is found.
 */
function findNearestProjectRoot(workspacePath: string, filePath: string): string | null {
  const absolutePath = resolveWorkspaceAbsolutePath(workspacePath, filePath);
  if (!absolutePath) {
    return null;
  }

  let currentPath = absolutePath;
  if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) {
    currentPath = path.dirname(currentPath);
  }

  const resolvedWorkspacePath = path.resolve(workspacePath);
  while (isWithinWorkspace(resolvedWorkspacePath, currentPath)) {
    if (hasProjectRootMarker(currentPath)) {
      return path.resolve(currentPath);
    }
    if (currentPath === resolvedWorkspacePath) {
      break;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return hasProjectRootMarker(resolvedWorkspacePath) ? resolvedWorkspacePath : null;
}

/**
 * Detects the most likely nested project root from a set of touched or changed files.
 *
 * @param workspacePath Absolute opened workspace root path.
 * @param filePaths Absolute or workspace-relative file paths associated with the current task.
 * @returns Absolute project root path or `null` when no rooted project can be inferred.
 */
export function detectActiveProjectPath(workspacePath: string, filePaths: readonly string[]): string | null {
  const candidateScores = new Map<string, Readonly<{ hits: number; depth: number }>>();

  filePaths.forEach((filePath) => {
    const candidatePath = findNearestProjectRoot(workspacePath, filePath);
    if (!candidatePath) {
      return;
    }
    const relativeDepth = path.relative(workspacePath, candidatePath).split(path.sep).filter(Boolean).length;
    const previous = candidateScores.get(candidatePath);
    candidateScores.set(candidatePath, Object.freeze({
      hits: (previous?.hits ?? 0) + 1,
      depth: relativeDepth,
    }));
  });

  const bestCandidate = [...candidateScores.entries()]
    .sort((left, right) => {
      const byHits = right[1].hits - left[1].hits;
      if (byHits !== 0) {
        return byHits;
      }
      return right[1].depth - left[1].depth;
    })[0]?.[0];

  return bestCandidate ?? null;
}

/**
 * Loads recent changed-file hints from the latest background command context, when available.
 *
 * @param workspacePath Absolute opened workspace root path.
 * @returns Changed files captured by the latest command context.
 */
export function loadCommandContextChangedFiles(workspacePath: string): readonly string[] {
  const commandContextPath = getProjectStorageInfo(workspacePath).commandContextPath;
  if (!fs.existsSync(commandContextPath)) {
    return Object.freeze([]);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(commandContextPath, 'utf-8')) as Record<string, unknown>;
    const changedFiles = parsed.changedFiles;
    if (!Array.isArray(changedFiles)) {
      return Object.freeze([]);
    }
    return Object.freeze(changedFiles.filter((filePath): filePath is string => typeof filePath === 'string'));
  } catch {
    return Object.freeze([]);
  }
}

/**
 * Detects the active nested project from the latest command context file.
 *
 * @param workspacePath Absolute opened workspace root path.
 * @returns Absolute detected project root or `null` when command context has no useful signal.
 */
export function detectActiveProjectPathFromCommandContext(workspacePath: string): string | null {
  return detectActiveProjectPath(workspacePath, loadCommandContextChangedFiles(workspacePath));
}

/**
 * Resolves the effective project scope used by workflow graph and hybrid retrieval.
 *
 * @param opts Opened workspace root, persisted active project, and optional current-turn file hints.
 * @returns Absolute project root path that should own retrieval and workflow state.
 */
export function resolveEffectiveProjectPath(opts: {
  workspacePath: string;
  activeProjectPath?: string;
  candidateFilePaths?: readonly string[];
}): string {
  const resolvedWorkspacePath = path.resolve(opts.workspacePath);
  const candidateFilePaths = opts.candidateFilePaths ?? Object.freeze([]);

  if (candidateFilePaths.length > 0) {
    const detectedProjectPath = detectActiveProjectPath(resolvedWorkspacePath, candidateFilePaths);
    if (detectedProjectPath) {
      return detectedProjectPath;
    }
    return resolvedWorkspacePath;
  }

  const normalizedActiveProjectPath = normalizeActiveProjectPath(resolvedWorkspacePath, opts.activeProjectPath);
  if (normalizedActiveProjectPath) {
    return normalizedActiveProjectPath;
  }

  return detectActiveProjectPathFromCommandContext(resolvedWorkspacePath) ?? resolvedWorkspacePath;
}

/**
 * Converts raw workspace-relative paths into paths relative to the effective project scope.
 *
 * @param workspacePath Absolute opened workspace root path.
 * @param projectPath Absolute effective project root path.
 * @param filePaths Absolute or workspace-relative file paths to remap.
 * @returns Stable project-relative file paths that stay inside the effective project root.
 */
export function mapPathsToProjectScope(
  workspacePath: string,
  projectPath: string,
  filePaths: readonly string[],
): readonly string[] {
  const mapped = filePaths
    .map((filePath) => {
      const absolutePath = resolveWorkspaceAbsolutePath(workspacePath, filePath);
      if (!absolutePath || !isWithinWorkspace(projectPath, absolutePath)) {
        return null;
      }
      const relativePath = path.relative(projectPath, absolutePath);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
      }
      return relativePath.split(path.sep).join('/');
    })
    .filter((filePath): filePath is string => Boolean(filePath));

  return Object.freeze([...new Set(mapped)]);
}
