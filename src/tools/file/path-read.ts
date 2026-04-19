/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Path resolution and read/list/grep helpers for VS Code file tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveAttachmentStoredPath } from '../../attachments/attachment-store';
import { getProjectStorageInfo } from '../../context/project-store';
import { getCachedReadResult, storeReadCache } from '../../context/rag-metadata/read-cache';
import { GREP_INCLUDE_EXTS, MAX_GREP_HITS, MAX_LIST_DIR_DEPTH, MAX_LIST_DIR_ENTRIES } from './constants';
import type { GrepToolOptions, ListDirToolOptions, ReadFileToolOptions, ToolResult } from '../entities/file-tools';

const LIST_DIR_SUMMARY_ENTRY_LIMIT = 40;

function shouldSkipDirectoryEntry(entry: fs.Dirent): boolean {
  return entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out';
}

function compareDirectoryEntries(left: fs.Dirent, right: fs.Dirent): number {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function readVisibleDirectoryEntries(dirPath: string): fs.Dirent[] {
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => !shouldSkipDirectoryEntry(entry))
    .sort(compareDirectoryEntries);
}

function formatDirectoryEntryName(entry: fs.Dirent): string {
  return `${entry.name}${entry.isDirectory() ? '/' : ''}`;
}

/**
 * Converts an absolute workspace path into a short display path.
 *
 * @param filePath Absolute file path.
 * @param workspaceRoot Absolute workspace root.
 * @returns Relative display path when possible.
 */
export function toDisplayPath(filePath: string, workspaceRoot: string): string {
  return path.relative(workspaceRoot, filePath) || path.basename(filePath);
}

/**
 * Returns whether a candidate path stays inside the workspace root.
 *
 * @param targetPath Absolute path to validate.
 * @param workspaceRoot Absolute workspace root.
 * @returns True when the path does not escape the workspace.
 */
export function isWithinWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Normalizes one lookup string for fuzzy filename matching.
 *
 * @param value Raw file or path fragment.
 * @returns Lowercased alphanumeric lookup key.
 */
function normalizeLookupKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\\/g, '/')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Computes edit distance between two normalized lookup keys.
 *
 * @param left Left lookup key.
 * @param right Right lookup key.
 * @returns Levenshtein distance between the two strings.
 */
function computeEditDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    for (let index = 0; index <= right.length; index += 1) {
      previous[index] = current[index]!;
    }
  }

  return previous[right.length]!;
}

/**
 * Computes the shared prefix length of two lookup keys.
 *
 * @param left Left lookup key.
 * @param right Right lookup key.
 * @returns Number of matching prefix characters.
 */
function computeCommonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

/**
 * Searches the workspace for the closest filename match when the requested path does not exist.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided path or basename.
 * @returns Best matching absolute path or null when the match is ambiguous.
 */
function findWorkspacePathByApproximateName(workspaceRoot: string, rawPath: string): string | null {
  const targetBase = path.basename(rawPath);
  const targetKey = normalizeLookupKey(targetBase);
  if (!targetKey) {
    return null;
  }

  const skipDirs = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    '.turbo',
    'target',
    '.galaxy',
  ]);

  const stack = [workspaceRoot];
  const candidates: Array<Readonly<{ filePath: string; score: number }>> = [];
  let visited = 0;

  while (stack.length > 0 && visited < 6_000) {
    const currentDir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          stack.push(entryPath);
        }
        continue;
      }
      visited += 1;
      const baseKey = normalizeLookupKey(entry.name);
      const relKey = normalizeLookupKey(path.relative(workspaceRoot, entryPath));
      if (!baseKey && !relKey) {
        continue;
      }

      let score = 0;
      for (const candidate of [baseKey, relKey]) {
        if (!candidate) {
          continue;
        }
        if (candidate === targetKey) {
          score = Math.max(score, 100);
          continue;
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

      if (score >= 64) {
        candidates.push(Object.freeze({ filePath: entryPath, score }));
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));
  const [bestMatch, secondMatch] = candidates;
  if (!bestMatch) {
    return null;
  }
  if (secondMatch && bestMatch.score - secondMatch.score < 8) {
    return null;
  }
  return bestMatch.filePath;
}

/**
 * Resolves a workspace-relative path while enforcing workspace boundaries.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided path.
 * @returns Absolute path inside the workspace.
 */
export function resolveWorkspacePath(workspaceRoot: string, rawPath: string): string {
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);

  if (!isWithinWorkspace(candidate, workspaceRoot)) {
    throw new Error(`Path must stay inside the workspace: ${rawPath}`);
  }

  return candidate;
}

/**
 * Resolves a readable file path from workspace files, attachment storage, or fuzzy filename fallback.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided path.
 * @returns Absolute readable path.
 */
export function resolveReadablePath(workspaceRoot: string, rawPath: string): string {
  try {
    const workspacePath = resolveWorkspacePath(workspaceRoot, rawPath);
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }
  } catch {
  }

  const attachmentPath = resolveAttachmentStoredPath(workspaceRoot, rawPath);
  if (attachmentPath) {
    return attachmentPath;
  }

  const fallbackWorkspacePath = findWorkspacePathByApproximateName(workspaceRoot, rawPath);
  if (fallbackWorkspacePath) {
    return fallbackWorkspacePath;
  }

  const projectStorage = getProjectStorageInfo(workspaceRoot);
  const normalizedRawPath = path.resolve(rawPath);
  if (
    normalizedRawPath.startsWith(projectStorage.attachmentsDirPath) &&
    fs.existsSync(normalizedRawPath)
  ) {
    return normalizedRawPath;
  }

  throw new Error(`Unable to resolve readable path: ${rawPath}`);
}

function collectTextFiles(dirPath: string, results: string[], depth = 0): void {
  if (depth > 8) {
    return;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectTextFiles(fullPath, results, depth + 1);
      continue;
    }

    if (GREP_INCLUDE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
}

/**
 * Searches one file for regex hits and returns line-context bundles.
 *
 * @param filePath Absolute file path to inspect.
 * @param regex Compiled regex used for matching.
 * @param contextLines Number of context lines to include around each hit.
 * @returns Structured grep hits for the file.
 */
function grepInFile(
  filePath: string,
  regex: RegExp,
  contextLines: number,
): Array<Readonly<{ file: string; lineNo: number; line: string; context: string[] }>> {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const hits: Array<Readonly<{ file: string; lineNo: number; line: string; context: string[] }>> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (regex.test(line)) {
      const start = Math.max(0, index - contextLines);
      const end = Math.min(lines.length - 1, index + contextLines);
      const context: string[] = [];
      for (let contextIndex = start; contextIndex <= end; contextIndex += 1) {
        const prefix = contextIndex === index ? '>' : ' ';
        context.push(`${prefix} ${contextIndex + 1}: ${lines[contextIndex] ?? ''}`);
      }
      hits.push(Object.freeze({ file: filePath, lineNo: index + 1, line, context }));
    }
  }
  return hits;
}

/**
 * Builds a global regex from the raw grep pattern.
 *
 * @param pattern Raw regex pattern string.
 * @returns Compiled regex instance.
 */
function createRegex(pattern: string): RegExp {
  return new RegExp(pattern, 'g');
}

/**
 * Reads one file or directory listing from the workspace, with cache support for file reads.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided target path.
 * @param options Optional pagination settings for file reads.
 * @returns Tool result containing file text or directory entries.
 */
export function readFileTool(workspaceRoot: string, rawPath: string, options?: ReadFileToolOptions): ToolResult {
  try {
    const resolved = resolveReadablePath(workspaceRoot, rawPath);
    if (!fs.existsSync(resolved)) {
      return Object.freeze({ success: false, content: '', error: `File not found: ${rawPath}` });
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true }).map((entry) =>
        `${entry.name}${entry.isDirectory() ? '/' : ''}`,
      );
      return Object.freeze({
        success: true,
        content: entries.join('\n'),
        meta: Object.freeze({ directoryPath: resolved, entryCount: entries.length }),
      });
    }

    const offset = Math.max(0, Number(options?.offset ?? 0));
    const maxLines = Math.max(1, Number(options?.maxLines ?? 400));
    const cached = getCachedReadResult(workspaceRoot, {
      filePath: resolved,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      readMode: 'file_lines',
      offset,
      limit: maxLines,
    });
    if (cached) {
      return Object.freeze({
        success: true,
        content: cached.content,
        ...(cached.meta ? { meta: Object.freeze({ ...cached.meta, cacheHit: true }) } : {}),
      });
    }

    const raw = fs.readFileSync(resolved, 'utf-8');
    const lines = raw.split('\n');
    const slice = lines.slice(offset, offset + maxLines);
    const content = slice.join('\n');
    const truncated = lines.length > offset + maxLines;
    const finalContent = truncated ? `${content}\n[... ${lines.length - offset - maxLines} more lines]` : content;
    const meta = Object.freeze({
      filePath: resolved,
      readMode: offset > 0 || maxLines < lines.length ? 'partial' : 'full',
      startLine: offset + 1,
      endLine: offset + slice.length,
      totalLines: lines.length,
      truncated,
      cacheHit: false,
    });

    storeReadCache(workspaceRoot, {
      filePath: resolved,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      readMode: 'file_lines',
      offset,
      limit: maxLines,
      content: finalContent,
      metaJson: JSON.stringify(meta),
    });

    return Object.freeze({ success: true, content: finalContent, meta });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}

/**
 * Searches files under a workspace path for the requested pattern.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param pattern Raw regex pattern string.
 * @param rawPath User-provided file or directory path.
 * @param options Optional grep settings.
 * @returns Tool result containing summarized grep hits.
 */
export function grepTool(
  workspaceRoot: string,
  pattern: string,
  rawPath: string,
  options?: GrepToolOptions,
): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath || '.');
    if (!fs.existsSync(resolved)) {
      return Object.freeze({ success: false, content: '', error: `Path not found: ${rawPath}` });
    }

    const regex = createRegex(pattern);
    const files: string[] = [];
    if (fs.statSync(resolved).isDirectory()) {
      collectTextFiles(resolved, files);
    } else {
      files.push(resolved);
    }

    const contextLines = Math.max(0, Number(options?.contextLines ?? 2));
    const hits = files.flatMap((filePath) => grepInFile(filePath, regex, contextLines)).slice(0, MAX_GREP_HITS);
    if (hits.length === 0) {
      return Object.freeze({
        success: true,
        content: '(no matches)',
        meta: Object.freeze({ pattern, targetPath: resolved, matches: 0 }),
      });
    }

    const content = hits.map((hit) => `${toDisplayPath(hit.file, workspaceRoot)}:${hit.lineNo}\n${hit.context.join('\n')}`).join('\n\n');
    return Object.freeze({
      success: true,
      content,
      meta: Object.freeze({ pattern, targetPath: resolved, matches: hits.length }),
    });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}

/**
 * Lists directory entries beneath one workspace directory.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided directory path.
 * @param options Optional depth settings.
 * @returns Tool result containing a compact tree listing.
 */
export function listDirTool(workspaceRoot: string, rawPath: string, options?: ListDirToolOptions): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath || '.');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return Object.freeze({ success: false, content: '', error: `Directory not found: ${rawPath}` });
    }

    const lines: string[] = [];
    const entries: Array<Readonly<{ name: string; path: string; kind: 'file' | 'dir' }>> = [];
    const depth = Number(options?.depth ?? 0);
    const normalizedDepth = Math.min(MAX_LIST_DIR_DEPTH, Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0)));
    const topLevelEntries = readVisibleDirectoryEntries(resolved);

    const topLevelSummary = normalizedDepth > 0 && topLevelEntries.length > 0
      ? (() => {
          const visibleEntries = topLevelEntries
            .slice(0, LIST_DIR_SUMMARY_ENTRY_LIMIT)
            .map(formatDirectoryEntryName)
            .join(', ');
          const remainingCount = topLevelEntries.length - LIST_DIR_SUMMARY_ENTRY_LIMIT;
          return remainingCount > 0
            ? `Top-level entries: ${visibleEntries}, ... (+${remainingCount} more)`
            : `Top-level entries: ${visibleEntries}`;
        })()
      : '';

    const walk = (dirPath: string, prefix = '', currentDepth = 0): void => {
      const dirEntries = readVisibleDirectoryEntries(dirPath);
      for (const entry of dirEntries) {
        if (entries.length >= MAX_LIST_DIR_ENTRIES) {
          return;
        }
        const fullPath = path.join(dirPath, entry.name);
        const kind = entry.isDirectory() ? 'dir' : 'file';
        lines.push(`${prefix}${entry.name}${kind === 'dir' ? '/' : ''}`);
        entries.push(Object.freeze({ name: entry.name, path: fullPath, kind }));
        if (kind === 'dir' && currentDepth < normalizedDepth) {
          walk(fullPath, `${prefix}  `, currentDepth + 1);
        }
      }
    };

    walk(resolved);

    const truncated = entries.length >= MAX_LIST_DIR_ENTRIES;
    const contentParts = [
      ...(topLevelSummary ? [topLevelSummary, ''] : []),
      lines.join('\n') || '(empty directory)',
      ...(truncated
        ? ['', `... [truncated after ${MAX_LIST_DIR_ENTRIES} entries; narrow the path or reduce depth]`]
        : []),
    ];

    return Object.freeze({
      success: true,
      content: contentParts.join('\n'),
      meta: Object.freeze({
        directoryPath: resolved,
        entryCount: entries.length,
        depth: normalizedDepth,
        truncated,
        entries: Object.freeze(entries),
      }),
    });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}

/**
 * Reads the first N lines of a file.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided file path.
 * @param lines Maximum number of lines to return.
 * @returns Tool result containing the head of the file.
 */
export function headTool(workspaceRoot: string, rawPath: string, lines = 50): ToolResult {
  return readFileTool(workspaceRoot, rawPath, { maxLines: Math.max(1, lines), offset: 0 });
}

/**
 * Reads the last N lines of a file.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided file path.
 * @param lines Maximum number of lines to return.
 * @returns Tool result containing the tail of the file.
 */
export function tailTool(workspaceRoot: string, rawPath: string, lines = 50): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    const raw = fs.readFileSync(resolved, 'utf-8');
    const allLines = raw.split('\n');
    const lineCount = Math.max(1, lines);
    const result = allLines.slice(Math.max(0, allLines.length - lineCount)).join('\n');
    return Object.freeze({
      success: true,
      content: result,
      meta: Object.freeze({
        filePath: resolved,
        readMode: 'tail',
        startLine: Math.max(1, allLines.length - lineCount + 1),
        endLine: allLines.length,
        totalLines: allLines.length,
        truncated: allLines.length > lineCount,
      }),
    });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}
