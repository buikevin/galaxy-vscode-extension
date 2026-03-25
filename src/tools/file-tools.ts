import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { tavily } from '@tavily/core';
import type { GalaxyConfig } from '../config/types';
import { resolveAttachmentStoredPath } from '../attachments/attachment-store';
import { getProjectStorageInfo } from '../context/project-store';
import { getCachedReadResult, storeReadCache } from '../context/rag-metadata-store';
import { captureOriginal, trackFileWrite } from '../runtime/session-tracker';
import {
  galaxyDesignAddTool,
  galaxyDesignInitTool,
  galaxyDesignProjectInfoTool,
  galaxyDesignRegistryTool,
} from './galaxy-design-tools';
import { runProjectCommandTool } from './project-command-tools';
import { readDocumentFile } from './document-reader';

export type ToolResult = Readonly<{
  success: boolean;
  content: string;
  error?: string;
  meta?: Readonly<Record<string, unknown>>;
}>;

export type ToolCall = Readonly<{
  name: string;
  params: Record<string, unknown>;
}>;

export type ToolDefinition = Readonly<{
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export type RevealRange = Readonly<{
  startLine: number;
  endLine: number;
}>;

export type FileToolContext = Readonly<{
  workspaceRoot: string;
  config: GalaxyConfig;
  revealFile: (filePath: string, range?: RevealRange) => Promise<void>;
  refreshWorkspaceFiles: () => Promise<void>;
  onProjectCommandStart?: (payload: Readonly<{ toolCallId: string; commandText: string; cwd: string; startedAt: number }>) => Promise<void> | void;
  onProjectCommandChunk?: (payload: Readonly<{ toolCallId: string; chunk: string }>) => Promise<void> | void;
  onProjectCommandEnd?: (payload: Readonly<{ toolCallId: string; exitCode: number; success: boolean; durationMs: number; background?: boolean }>) => Promise<void> | void;
  onProjectCommandComplete?: (payload: Readonly<{
    toolCallId: string;
    commandText: string;
    cwd: string;
    exitCode: number;
    success: boolean;
    durationMs: number;
    output: string;
    background: boolean;
  }>) => Promise<void> | void;
}>;

const GREP_INCLUDE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.css',
  '.scss',
  '.html',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.sh',
  '.bash',
  '.zsh',
  '.yaml',
  '.yml',
  '.toml',
  '.dart',
]);

const MAX_LIST_DIR_ENTRIES = 100;
const MAX_LIST_DIR_DEPTH = 8;
const MAX_GREP_HITS = 60;
const TAVILY_API_KEY = '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';

let tavilyClient: ReturnType<typeof tavily> | null = null;
let tavilyClientKey = '';

function getTavilyClient(config: GalaxyConfig): { client?: ReturnType<typeof tavily>; error?: string } {
  try {
    const apiKey = TAVILY_API_KEY || process.env.TAVILY_API_KEY || '';
    if (!apiKey) {
      return { error: 'Tavily API key is not configured.' };
    }

    if (!tavilyClient || tavilyClientKey !== apiKey) {
      tavilyClient = tavily({ apiKey });
      tavilyClientKey = apiKey;
    }

    return { client: tavilyClient };
  } catch (error) {
    return { error: String(error) };
  }
}

function truncateText(text: string, maxChars = 2_000): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function formatSearchResults(results: Array<{ title?: string; url?: string; content?: string }>, maxItems = 5): string {
  if (results.length === 0) {
    return '(no results)';
  }

  const lines: string[] = [];
  for (const [index, result] of results.slice(0, maxItems).entries()) {
    lines.push(`${index + 1}. ${result.title ?? '(untitled)'} — ${result.url ?? ''}`.trim());
    if (result.content) {
      lines.push(`   ${truncateText(result.content.replace(/\s+/g, ' '), 300)}`);
    }
  }

  return lines.join('\n');
}

function formatUrlResults(urls: readonly string[], maxItems = 20): string {
  if (urls.length === 0) {
    return '(no results)';
  }

  return urls.slice(0, maxItems).map((url, index) => `${index + 1}. ${url}`).join('\n');
}

async function searchWebTool(
  config: GalaxyConfig,
  query: string,
  options?: {
    maxResults?: number;
    searchDepth?: 'basic' | 'advanced';
    includeAnswer?: boolean;
    includeRawContent?: boolean;
    includeDomains?: string[];
    excludeDomains?: string[];
    timeRange?: 'day' | 'week' | 'month' | 'year';
  },
): Promise<ToolResult> {
  const { client, error } = getTavilyClient(config);
  if (!client) {
    return Object.freeze({
      success: false,
      content: '',
      error: error ?? 'Tavily client unavailable.',
    });
  }

  try {
    const data = await client.search(query, {
      ...(typeof options?.maxResults === 'number' ? { maxResults: options.maxResults } : {}),
      ...(options?.searchDepth ? { searchDepth: options.searchDepth } : {}),
      ...(typeof options?.includeAnswer === 'boolean' ? { includeAnswer: options.includeAnswer } : {}),
      ...(typeof options?.includeRawContent === 'boolean'
        ? { includeRawContent: options.includeRawContent ? 'text' : false }
        : {}),
      ...(options?.includeDomains?.length ? { includeDomains: options.includeDomains } : {}),
      ...(options?.excludeDomains?.length ? { excludeDomains: options.excludeDomains } : {}),
      ...(options?.timeRange ? { timeRange: options.timeRange } : {}),
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    const answer = typeof data?.answer === 'string' ? data.answer : '';
    const header = answer ? `Answer: ${truncateText(answer, 800)}\n\n` : '';
    const content = `${header}Results:\n${formatSearchResults(
      results.map((item: any) => ({
        title: typeof item?.title === 'string' ? item.title : undefined,
        url: typeof item?.url === 'string' ? item.url : undefined,
        content: typeof item?.content === 'string' ? item.content : undefined,
      })),
      options?.maxResults ?? 5,
    )}`;

    return Object.freeze({
      success: true,
      content,
      meta: Object.freeze({
        query,
        urls: Object.freeze(results.map((item: any) => String(item?.url ?? '')).filter(Boolean)),
        resultCount: results.length,
        reportKind: 'web_search',
        truncated: content.length > 500,
      }),
    });
  } catch (searchError) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(searchError),
    });
  }
}

async function mapWebTool(
  config: GalaxyConfig,
  url: string,
  options?: {
    limit?: number;
    maxDepth?: number;
    maxBreadth?: number;
    instructions?: string;
    selectPaths?: string[];
    selectDomains?: string[];
    excludePaths?: string[];
    excludeDomains?: string[];
    allowExternal?: boolean;
  },
): Promise<ToolResult> {
  if (!url) {
    return Object.freeze({
      success: false,
      content: '',
      error: 'No URL provided.',
    });
  }

  const { client, error } = getTavilyClient(config);
  if (!client) {
    return Object.freeze({
      success: false,
      content: '',
      error: error ?? 'Tavily client unavailable.',
    });
  }

  try {
    const data = await client.map(url, {
      ...(typeof options?.limit === 'number' ? { limit: options.limit } : {}),
      ...(typeof options?.maxDepth === 'number' ? { maxDepth: options.maxDepth } : {}),
      ...(typeof options?.maxBreadth === 'number' ? { maxBreadth: options.maxBreadth } : {}),
      ...(options?.instructions ? { instructions: options.instructions } : {}),
      ...(options?.selectPaths?.length ? { selectPaths: options.selectPaths } : {}),
      ...(options?.selectDomains?.length ? { selectDomains: options.selectDomains } : {}),
      ...(options?.excludePaths?.length ? { excludePaths: options.excludePaths } : {}),
      ...(options?.excludeDomains?.length ? { excludeDomains: options.excludeDomains } : {}),
      ...(typeof options?.allowExternal === 'boolean' ? { allowExternal: options.allowExternal } : {}),
    });

    const results = Array.isArray(data?.results)
      ? data.results.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const baseUrl = typeof data?.baseUrl === 'string' && data.baseUrl.trim() ? data.baseUrl : url;
    const displayLimit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
    const content = `Base URL: ${baseUrl}\n\nURLs:\n${formatUrlResults(results, displayLimit)}`;

    return Object.freeze({
      success: true,
      content,
      meta: Object.freeze({
        urls: Object.freeze(results),
        baseUrl,
        resultCount: results.length,
        reportKind: 'web_map',
        truncated: results.length > displayLimit || content.length > 500,
      }),
    });
  } catch (mapError) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(mapError),
    });
  }
}

async function extractWebTool(
  config: GalaxyConfig,
  urls: readonly string[],
  options?: {
    extractDepth?: 'basic' | 'advanced';
    format?: 'text' | 'markdown';
    query?: string;
    includeImages?: boolean;
    maxCharsPerUrl?: number;
  },
): Promise<ToolResult> {
  if (urls.length === 0) {
    return Object.freeze({
      success: false,
      content: '',
      error: 'No URLs provided.',
    });
  }

  const { client, error } = getTavilyClient(config);
  if (!client) {
    return Object.freeze({
      success: false,
      content: '',
      error: error ?? 'Tavily client unavailable.',
    });
  }

  try {
    const data = await client.extract([...urls], {
      ...(options?.extractDepth ? { extractDepth: options.extractDepth } : {}),
      ...(options?.format ? { format: options.format } : {}),
      ...(options?.query ? { query: options.query } : {}),
      ...(typeof options?.includeImages === 'boolean' ? { includeImages: options.includeImages } : {}),
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    const failed = Array.isArray(data?.failedResults) ? data.failedResults : [];
    const maxCharsPerUrl = options?.maxCharsPerUrl ?? 3_000;

    const lines: string[] = [];
    for (const result of results) {
      lines.push(`URL: ${String(result?.url ?? '')}`.trim());
      if (typeof result?.title === 'string' && result.title.trim()) {
        lines.push(`Title: ${result.title}`);
      }
      const rawContent = typeof result?.rawContent === 'string' ? result.rawContent : '';
      if (rawContent) {
        lines.push(truncateText(rawContent, maxCharsPerUrl));
      }
      lines.push('');
    }

    if (failed.length > 0) {
      lines.push('Failed:');
      for (const item of failed) {
        lines.push(`- ${String(item?.url ?? '')} (${String(item?.error ?? 'unknown error')})`.trim());
      }
    }

    const content = lines.join('\n').trim();
    return Object.freeze({
      success: true,
      content,
      meta: Object.freeze({
        query: options?.query ?? '',
        urls: Object.freeze([...urls]),
        resultCount: results.length,
        reportKind: 'web_extract',
        truncated: content.length > 500,
      }),
    });
  } catch (extractError) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(extractError),
    });
  }
}

async function crawlWebTool(
  config: GalaxyConfig,
  url: string,
  options?: {
    maxDepth?: number;
    maxBreadth?: number;
    limit?: number;
    instructions?: string;
    extractDepth?: 'basic' | 'advanced';
    selectPaths?: string[];
    selectDomains?: string[];
    excludePaths?: string[];
    excludeDomains?: string[];
    allowExternal?: boolean;
    includeImages?: boolean;
    format?: 'text' | 'markdown';
    maxCharsPerPage?: number;
  },
): Promise<ToolResult> {
  if (!url) {
    return Object.freeze({
      success: false,
      content: '',
      error: 'No URL provided.',
    });
  }

  const { client, error } = getTavilyClient(config);
  if (!client) {
    return Object.freeze({
      success: false,
      content: '',
      error: error ?? 'Tavily client unavailable.',
    });
  }

  try {
    const data = await client.crawl(url, {
      ...(typeof options?.maxDepth === 'number' ? { maxDepth: options.maxDepth } : {}),
      ...(typeof options?.maxBreadth === 'number' ? { maxBreadth: options.maxBreadth } : {}),
      ...(typeof options?.limit === 'number' ? { limit: options.limit } : {}),
      ...(options?.instructions ? { instructions: options.instructions } : {}),
      ...(options?.extractDepth ? { extractDepth: options.extractDepth } : {}),
      ...(options?.selectPaths?.length ? { selectPaths: options.selectPaths } : {}),
      ...(options?.selectDomains?.length ? { selectDomains: options.selectDomains } : {}),
      ...(options?.excludePaths?.length ? { excludePaths: options.excludePaths } : {}),
      ...(options?.excludeDomains?.length ? { excludeDomains: options.excludeDomains } : {}),
      ...(typeof options?.allowExternal === 'boolean' ? { allowExternal: options.allowExternal } : {}),
      ...(typeof options?.includeImages === 'boolean' ? { includeImages: options.includeImages } : {}),
      ...(options?.format ? { format: options.format } : {}),
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    const maxCharsPerPage = options?.maxCharsPerPage ?? 3_000;
    const baseUrl = typeof data?.baseUrl === 'string' && data.baseUrl.trim() ? data.baseUrl : url;

    const lines: string[] = [`Base URL: ${baseUrl}`, ''];
    for (const result of results) {
      const resultUrl = typeof result?.url === 'string' ? result.url : '';
      if (resultUrl) {
        lines.push(`URL: ${resultUrl}`);
      }
      const rawContent = typeof result?.rawContent === 'string' ? result.rawContent : '';
      if (rawContent) {
        lines.push(truncateText(rawContent, maxCharsPerPage));
      }
      lines.push('');
    }

    const content = lines.join('\n').trim();
    return Object.freeze({
      success: true,
      content,
      meta: Object.freeze({
        urls: Object.freeze(results.map((item: any) => String(item?.url ?? '')).filter(Boolean)),
        baseUrl,
        resultCount: results.length,
        reportKind: 'web_crawl',
        truncated: content.length > 500,
      }),
    });
  } catch (crawlError) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(crawlError),
    });
  }
}

function toDisplayPath(filePath: string, workspaceRoot: string): string {
  return path.relative(workspaceRoot, filePath) || path.basename(filePath);
}

function isWithinWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeLookupKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\\/g, '/')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase()
    .trim();
}

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
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j]!;
    }
  }

  return previous[b.length]!;
}

function computeCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

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

  candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
  const [bestMatch, secondMatch] = candidates;
  if (!bestMatch) {
    return null;
  }
  if (secondMatch && bestMatch.score - secondMatch.score < 8) {
    return null;
  }
  return bestMatch.filePath;
}

function resolveWorkspacePath(workspaceRoot: string, rawPath: string): string {
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);

  if (!isWithinWorkspace(candidate, workspaceRoot)) {
    throw new Error(`Path must stay inside the workspace: ${rawPath}`);
  }

  return candidate;
}

function resolveReadablePath(workspaceRoot: string, rawPath: string): string {
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
    normalizedRawPath === path.resolve(projectStorage.commandContextPath)
    || rawPath === 'context.json'
    || rawPath === path.basename(projectStorage.commandContextPath)
  ) {
    if (fs.existsSync(projectStorage.commandContextPath)) {
      return projectStorage.commandContextPath;
    }
  }

  throw new Error(`Path must stay inside the workspace or match an attached file: ${rawPath}`);
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length;
}

function buildUnifiedDiff(filePath: string, originalContent: string, currentContent: string): {
  content: string;
  changedRange?: RevealRange;
} {
  if (originalContent === currentContent) {
    return {
      content: `📄 ${filePath} [no changes]`,
    };
  }

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

  const diffLines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...originalChanged.map((line) => `-${line}`),
    ...currentChanged.map((line) => `+${line}`),
  ];

  return {
    content: diffLines.join('\n'),
    changedRange: {
      startLine: newStart,
      endLine: Math.max(newStart, newStart + Math.max(newCount, 1) - 1),
    },
  };
}

function collectTextFiles(dirPath: string, results: string[], depth = 0): void {
  if (depth > 8 || results.length >= MAX_GREP_HITS) {
    return;
  }

  let entries: fs.Dirent[];
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

    if (results.length >= MAX_GREP_HITS) {
      return;
    }
  }
}

function grepInFile(
  filePath: string,
  regex: RegExp,
  contextLines: number,
): Array<Readonly<{ file: string; lineNo: number; line: string; context: readonly string[] }>> {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = raw.split('\n');
  const hits: Array<Readonly<{ file: string; lineNo: number; line: string; context: readonly string[] }>> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    regex.lastIndex = 0;
    if (!regex.test(line)) {
      continue;
    }

    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    const context: string[] = [];
    for (let pointer = start; pointer <= end; pointer += 1) {
      const prefix = pointer === index ? '>' : ' ';
      context.push(`${prefix} ${pointer + 1}: ${lines[pointer] ?? ''}`);
    }

    hits.push(Object.freeze({
      file: filePath,
      lineNo: index + 1,
      line,
      context: Object.freeze(context),
    }));

    if (hits.length >= MAX_GREP_HITS) {
      break;
    }
  }

  return hits;
}

function createRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'g');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  }
}

function readFileTool(workspaceRoot: string, rawPath: string, options?: { maxLines?: number; offset?: number }): ToolResult {
  try {
    const resolved = resolveReadablePath(workspaceRoot, rawPath);
    if (!fs.existsSync(resolved)) {
      return Object.freeze({
        success: false,
        content: '',
        error: `File not found: ${rawPath}`,
      });
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true }).map((entry) =>
        `${entry.name}${entry.isDirectory() ? '/' : ''}`,
      );
      return Object.freeze({
        success: true,
        content: entries.join('\n'),
        meta: Object.freeze({
          directoryPath: resolved,
          entryCount: entries.length,
        }),
      });
    }

    const offset = Math.max(0, Number(options?.offset ?? 0));
    const maxLines = Math.max(1, Number(options?.maxLines ?? 200));
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

    return Object.freeze({
      success: true,
      content: finalContent,
      meta,
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(error),
    });
  }
}

function writeFileTool(workspaceRoot: string, rawPath: string, content: string): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    const existedBefore = fs.existsSync(resolved);
    captureOriginal(resolved);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    trackFileWrite(resolved);

    return Object.freeze({
      success: true,
      content: `Written ${Buffer.byteLength(content, 'utf-8')} bytes to ${toDisplayPath(resolved, workspaceRoot)}`,
      meta: Object.freeze({
        filePath: resolved,
        operation: existedBefore ? 'overwrite' : 'create',
        existedBefore,
        lineCount: countLines(content),
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(error),
    });
  }
}

function editFileTool(
  workspaceRoot: string,
  rawPath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    if (!fs.existsSync(resolved)) {
      return Object.freeze({
        success: false,
        content: '',
        error: `File not found: ${rawPath}`,
      });
    }

    captureOriginal(resolved);
    const original = fs.readFileSync(resolved, 'utf-8');
    if (!original.includes(oldString)) {
      return Object.freeze({
        success: false,
        content: '',
        error: `old_string not found in ${rawPath}. It must match exactly, including whitespace.`,
      });
    }

    const occurrences = original.split(oldString).length - 1;
    if (occurrences > 1 && !replaceAll) {
      return Object.freeze({
        success: false,
        content: '',
        error: `old_string appears ${occurrences} times in ${rawPath}. Use replace_all=true or provide more context.`,
      });
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);

    fs.writeFileSync(resolved, updated, 'utf-8');
    trackFileWrite(resolved);

    const originalLines = original.split('\n');
    const updatedLines = updated.split('\n');
    const changedAt = originalLines.findIndex((line, index) => line !== updatedLines[index]);
    const changedLineCount = Math.max(oldString.split('\n').length, newString.split('\n').length, 1);
    const changedRange = changedAt >= 0
      ? Object.freeze([{ startLine: changedAt + 1, endLine: changedAt + changedLineCount }])
      : Object.freeze([]);

    return Object.freeze({
      success: true,
      content: `Edited ${toDisplayPath(resolved, workspaceRoot)}${changedAt >= 0 ? ` starting at line ${changedAt + 1}` : ''}`,
      meta: Object.freeze({
        filePath: resolved,
        operation: 'edit',
        existedBefore: true,
        replaceAll,
        occurrencesChanged: replaceAll ? occurrences : 1,
        changedLineRanges: changedRange,
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(error),
    });
  }
}

function editFileRangeTool(
  workspaceRoot: string,
  rawPath: string,
  startLine: number,
  endLine: number,
  newContent: string,
): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    if (!fs.existsSync(resolved)) {
      return Object.freeze({
        success: false,
        content: '',
        error: `File not found: ${rawPath}`,
      });
    }

    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
      return Object.freeze({
        success: false,
        content: '',
        error: `Invalid line range for ${rawPath}. start_line and end_line must be 1-based and end_line >= start_line.`,
      });
    }

    captureOriginal(resolved);
    const original = fs.readFileSync(resolved, 'utf-8');
    const originalLines = original.split('\n');

    if (startLine > originalLines.length + 1) {
      return Object.freeze({
        success: false,
        content: '',
        error: `start_line ${startLine} is outside ${rawPath} (${originalLines.length} lines).`,
      });
    }

    const replacementLines = newContent.split('\n');
    const updatedLines = [
      ...originalLines.slice(0, startLine - 1),
      ...replacementLines,
      ...originalLines.slice(endLine),
    ];
    const updated = updatedLines.join('\n');

    fs.writeFileSync(resolved, updated, 'utf-8');
    trackFileWrite(resolved);

    return Object.freeze({
      success: true,
      content: `Edited ${toDisplayPath(resolved, workspaceRoot)} lines ${startLine}-${endLine}`,
      meta: Object.freeze({
        filePath: resolved,
        operation: 'edit',
        existedBefore: true,
        changedLineRanges: Object.freeze([
          Object.freeze({
            startLine,
            endLine: Math.max(startLine, startLine + replacementLines.length - 1),
          }),
        ]),
        rangeEdit: true,
        startLine,
        endLine,
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(error),
    });
  }
}

function grepTool(workspaceRoot: string, pattern: string, rawPath: string, contextLines = 2): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath || '.');
    if (!fs.existsSync(resolved)) {
      return Object.freeze({
        success: false,
        content: '',
        error: `Path not found: ${rawPath}`,
      });
    }

    const regex = createRegex(pattern);
    const files: string[] = [];
    if (fs.statSync(resolved).isDirectory()) {
      collectTextFiles(resolved, files);
    } else {
      files.push(resolved);
    }

    const hits = files.flatMap((filePath) => grepInFile(filePath, regex, contextLines)).slice(0, MAX_GREP_HITS);
    if (hits.length === 0) {
      return Object.freeze({
        success: true,
        content: `(no matches)`,
        meta: Object.freeze({
          pattern,
          targetPath: resolved,
          matches: 0,
        }),
      });
    }

    const content = hits.map((hit) => {
      const label = toDisplayPath(hit.file, workspaceRoot);
      return `${label}:${hit.lineNo}\n${hit.context.join('\n')}`;
    }).join('\n\n');

    return Object.freeze({
      success: true,
      content,
      meta: Object.freeze({
        pattern,
        targetPath: resolved,
        matches: hits.length,
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(error),
    });
  }
}

function listDirTool(workspaceRoot: string, rawPath: string, depth = 0): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath || '.');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return Object.freeze({
        success: false,
        content: '',
        error: `Directory not found: ${rawPath}`,
      });
    }

    const lines: string[] = [];
    const entries: Array<Readonly<{ name: string; path: string; kind: 'file' | 'dir' }>> = [];
    const normalizedDepth = Math.min(
      MAX_LIST_DIR_DEPTH,
      Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0)),
    );

    const walk = (dirPath: string, prefix = '', currentDepth = 0): void => {
      const dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') {
          continue;
        }

        if (entries.length >= MAX_LIST_DIR_ENTRIES) {
          return;
        }

        const fullPath = path.join(dirPath, entry.name);
        const kind = entry.isDirectory() ? 'dir' : 'file';
        lines.push(`${prefix}${entry.name}${kind === 'dir' ? '/' : ''}`);
        entries.push(Object.freeze({
          name: entry.name,
          path: fullPath,
          kind,
        }));

        if (kind === 'dir' && currentDepth < normalizedDepth) {
          walk(fullPath, `${prefix}  `, currentDepth + 1);
        }
      }
    };

    walk(resolved);

    return Object.freeze({
      success: true,
      content: lines.join('\n') || '(empty directory)',
      meta: Object.freeze({
        directoryPath: resolved,
        entryCount: entries.length,
        depth: normalizedDepth,
        truncated: entries.length >= MAX_LIST_DIR_ENTRIES,
        entries: Object.freeze(entries),
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(error),
    });
  }
}

function headTool(workspaceRoot: string, rawPath: string, lines = 50): ToolResult {
  return readFileTool(workspaceRoot, rawPath, { maxLines: Math.max(1, lines), offset: 0 });
}

function tailTool(workspaceRoot: string, rawPath: string, lines = 50): ToolResult {
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
    return Object.freeze({
      success: false,
      content: '',
      error: String(error),
    });
  }
}

async function readDocumentTool(
  workspaceRoot: string,
  rawPath: string,
  options?: Readonly<{ maxChars?: number; offset?: number }>,
): Promise<ToolResult> {
  try {
    const resolved = resolveReadablePath(workspaceRoot, rawPath);
    const stat = fs.statSync(resolved);
    const maxChars = Math.max(1, Number(options?.maxChars ?? 20_000));
    const offset = Math.max(0, Number(options?.offset ?? 0));
    const cached = getCachedReadResult(workspaceRoot, {
      filePath: resolved,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      readMode: 'document_chars',
      offset,
      limit: maxChars,
    });
    if (cached) {
      return Object.freeze({
        success: true,
        content: cached.content,
        ...(cached.meta ? { meta: Object.freeze({ ...cached.meta, cacheHit: true }) } : {}),
      });
    }

    const result = await readDocumentFile(resolved, options);
    const meta = Object.freeze({
      filePath: resolved,
      readMode: 'document',
      format: result.format ?? path.extname(resolved).slice(1).toUpperCase(),
      ...(typeof result.pageCount === 'number' ? { pageCount: result.pageCount } : {}),
      ...(typeof result.totalChars === 'number' ? { totalChars: result.totalChars } : {}),
      ...(typeof result.returnedChars === 'number' ? { returnedChars: result.returnedChars } : {}),
      ...(typeof result.offset === 'number' ? { offset: result.offset } : {}),
      ...(typeof result.nextOffset === 'number' ? { nextOffset: result.nextOffset } : {}),
      ...(typeof result.hasMore === 'boolean' ? { hasMore: result.hasMore } : {}),
      truncated: Boolean(result.truncated ?? false),
      cacheHit: false,
    });
    if (result.success) {
      storeReadCache(workspaceRoot, {
        filePath: resolved,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        readMode: 'document_chars',
        offset,
        limit: maxChars,
        content: result.content,
        metaJson: JSON.stringify(meta),
      });
    }
    return Object.freeze({
      success: result.success,
      content: result.content,
      ...(result.error ? { error: result.error } : {}),
      meta,
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: '',
      error: String(error),
    });
  }
}

export function validateCodeTool(filePath: string): ToolResult {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return Object.freeze({
      success: false,
      content: '',
      error: `File not found: ${filePath}`,
    });
  }

  const ext = path.extname(resolved).toLowerCase();

  function findTsConfig(dirPath: string): string | null {
    const candidate = path.join(dirPath, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      return dirPath;
    }
    const parent = path.dirname(dirPath);
    if (parent === dirPath) {
      return null;
    }
    return findTsConfig(parent);
  }

  try {
    if (ext === '.ts' || ext === '.tsx') {
      const projectDir = findTsConfig(path.dirname(resolved));
      if (!projectDir) {
        return Object.freeze({
          success: false,
          content: '',
          error: 'No tsconfig.json found in parent directories.',
          meta: Object.freeze({
            filePath: resolved,
            reportKind: 'validation',
            issuesCount: 1,
          }),
        });
      }

      try {
        execSync('npx tsc --noEmit 2>&1', {
          cwd: projectDir,
          encoding: 'utf-8',
          timeout: 30_000,
        });
        return Object.freeze({
          success: true,
          content: `No TypeScript errors in ${filePath}`,
          meta: Object.freeze({
            filePath: resolved,
            reportKind: 'validation',
            issuesCount: 0,
          }),
        });
      } catch (error) {
        const output =
          error instanceof Error && 'stdout' in error
            ? String((error as NodeJS.ErrnoException & { stdout?: string }).stdout ?? '')
            : String(error);
        const relPath = path.relative(projectDir, resolved);
        const lines = output.split('\n').filter(Boolean);
        const relevant = lines.filter((line) => line.includes(relPath) || /^\s+/.test(line));
        const report = relevant.length > 0 ? relevant.join('\n') : lines.join('\n');
        return Object.freeze({
          success: false,
          content: report,
          error: `TypeScript errors found in ${filePath}`,
          meta: Object.freeze({
            filePath: resolved,
            reportKind: 'validation',
            issuesCount: report.split('\n').filter(Boolean).length,
          }),
        });
      }
    }

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      execSync(`node --check "${resolved}" 2>&1`, {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return Object.freeze({
        success: true,
        content: `No syntax errors in ${filePath}`,
        meta: Object.freeze({
          filePath: resolved,
          reportKind: 'validation',
          issuesCount: 0,
        }),
      });
    }

    if (ext === '.json') {
      JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      return Object.freeze({
        success: true,
        content: `Valid JSON: ${filePath}`,
        meta: Object.freeze({
          filePath: resolved,
          reportKind: 'validation',
          issuesCount: 0,
        }),
      });
    }

    if (ext === '.py') {
      execSync(`python -m py_compile "${resolved}" 2>&1`, {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return Object.freeze({
        success: true,
        content: `Python syntax OK: ${filePath}`,
        meta: Object.freeze({
          filePath: resolved,
          reportKind: 'validation',
          issuesCount: 0,
        }),
      });
    }

    if (ext === '.sh' || ext === '.bash') {
      execSync(`bash -n "${resolved}" 2>&1`, {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return Object.freeze({
        success: true,
        content: `Shell syntax OK: ${filePath}`,
        meta: Object.freeze({
          filePath: resolved,
          reportKind: 'validation',
          issuesCount: 0,
        }),
      });
    }

    if (ext === '.zsh') {
      execSync(`zsh -n "${resolved}" 2>&1`, {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return Object.freeze({
        success: true,
        content: `Zsh syntax OK: ${filePath}`,
        meta: Object.freeze({
          filePath: resolved,
          reportKind: 'validation',
          issuesCount: 0,
        }),
      });
    }

    if (ext === '.php') {
      execSync(`php -l "${resolved}" 2>&1`, {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return Object.freeze({
        success: true,
        content: `PHP syntax OK: ${filePath}`,
        meta: Object.freeze({
          filePath: resolved,
          reportKind: 'validation',
          issuesCount: 0,
        }),
      });
    }

    if (ext === '.rb') {
      execSync(`ruby -c "${resolved}" 2>&1`, {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return Object.freeze({
        success: true,
        content: `Ruby syntax OK: ${filePath}`,
        meta: Object.freeze({
          filePath: resolved,
          reportKind: 'validation',
          issuesCount: 0,
        }),
      });
    }

    return Object.freeze({
      success: true,
      content: `File exists and is readable: ${filePath}`,
      meta: Object.freeze({
        filePath: resolved,
        reportKind: 'validation',
        issuesCount: 0,
      }),
    });
  } catch (error) {
    const message =
      error instanceof Error && 'stdout' in error
        ? String((error as NodeJS.ErrnoException & { stdout?: string }).stdout ?? error.message)
        : String(error);
    return Object.freeze({
      success: false,
      content: message,
      error: `Validation failed: ${filePath}`,
      meta: Object.freeze({
        filePath: resolved,
        reportKind: 'validation',
        issuesCount: message.split('\n').filter(Boolean).length,
      }),
    });
  }
}

function p(call: ToolCall, key: string, fallback = ''): string {
  return String(call.params[key] ?? fallback).trim();
}

export function normalizeToolName(raw: string): string {
  const lowered = String(raw ?? '').toLowerCase().trim();
  const base = lowered.split(/[./]/).pop() ?? lowered;
  const normalized = base.replace(/[-\s]+/g, '_').replace(/[^a-z0-9_]/g, '');

  switch (normalized) {
    case 'readfile':
      return 'read_file';
    case 'writefile':
      return 'write_file';
    case 'editfile':
      return 'edit_file';
    case 'listdir':
      return 'list_dir';
    case 'runprojectcommand':
      return 'run_project_command';
    case 'searchweb':
      return 'search_web';
    case 'extractweb':
      return 'extract_web';
    case 'mapweb':
      return 'map_web';
    case 'crawlweb':
      return 'crawl_web';
    case 'validatecode':
      return 'validate_code';
    case 'requestcodereview':
      return 'request_code_review';
    case 'galaxydesignprojectinfo':
      return 'galaxy_design_project_info';
    case 'galaxydesignregistry':
      return 'galaxy_design_registry';
    case 'galaxydesigninit':
      return 'galaxy_design_init';
    case 'galaxydesignadd':
      return 'galaxy_design_add';
    case 'search':
      return 'grep';
    default:
      return normalized;
  }
}

export async function executeToolAsync(call: ToolCall, toolContext: FileToolContext): Promise<ToolResult> {
  const toolName = normalizeToolName(call.name);

  switch (toolName) {
    case 'read_file':
      return readFileTool(toolContext.workspaceRoot, p(call, 'path'), {
        maxLines: Number(call.params.maxLines ?? 200),
        offset: Number(call.params.offset ?? 0),
      });
    case 'write_file': {
      const result = writeFileTool(toolContext.workspaceRoot, p(call, 'path'), String(call.params.content ?? ''));
      if (result.success && typeof result.meta?.filePath === 'string') {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case 'edit_file': {
      const result = editFileTool(
        toolContext.workspaceRoot,
        p(call, 'path'),
        String(call.params.old_string ?? ''),
        String(call.params.new_string ?? ''),
        Boolean(call.params.replace_all ?? false),
      );
      if (result.success && typeof result.meta?.filePath === 'string') {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case 'edit_file_range': {
      const result = editFileRangeTool(
        toolContext.workspaceRoot,
        p(call, 'path'),
        Number(call.params.start_line ?? 0),
        Number(call.params.end_line ?? 0),
        String(call.params.new_content ?? ''),
      );
      if (result.success && typeof result.meta?.filePath === 'string') {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case 'grep':
      return grepTool(toolContext.workspaceRoot, p(call, 'pattern'), p(call, 'path', '.'), Number(call.params.contextLines ?? 2));
    case 'list_dir':
      return listDirTool(
        toolContext.workspaceRoot,
        p(call, 'path', '.'),
        Number(call.params.depth ?? 0),
      );
    case 'head':
      return headTool(toolContext.workspaceRoot, p(call, 'path'), Number(call.params.lines ?? 50));
    case 'tail':
      return tailTool(toolContext.workspaceRoot, p(call, 'path'), Number(call.params.lines ?? 50));
    case 'read_document':
      return readDocumentTool(toolContext.workspaceRoot, p(call, 'path'), {
        maxChars: Number(call.params.maxChars ?? 20_000),
        offset: Number(call.params.offset ?? 0),
      });
    case 'search_web':
      return searchWebTool(toolContext.config, p(call, 'query'), (() => {
        const timeRange = String(call.params.timeRange ?? '').trim();
        return {
          maxResults: Number(call.params.maxResults ?? 5),
          searchDepth: String(call.params.searchDepth ?? 'basic') as 'basic' | 'advanced',
          includeAnswer: Boolean(call.params.includeAnswer ?? false),
          includeRawContent: Boolean(call.params.includeRawContent ?? false),
          includeDomains: Array.isArray(call.params.includeDomains) ? call.params.includeDomains as string[] : undefined,
          excludeDomains: Array.isArray(call.params.excludeDomains) ? call.params.excludeDomains as string[] : undefined,
          ...(timeRange ? { timeRange: timeRange as 'day' | 'week' | 'month' | 'year' } : {}),
        };
      })());
    case 'extract_web':
      return extractWebTool(
        toolContext.config,
        Array.isArray(call.params.urls) ? call.params.urls as string[] : [],
        {
          extractDepth: String(call.params.extractDepth ?? 'basic') as 'basic' | 'advanced',
          format: String(call.params.format ?? 'text') as 'text' | 'markdown',
          query: p(call, 'query'),
          includeImages: Boolean(call.params.includeImages ?? false),
          maxCharsPerUrl: Number(call.params.maxCharsPerUrl ?? 3_000),
        },
      );
    case 'map_web':
      return mapWebTool(toolContext.config, p(call, 'url'), {
        limit: Number(call.params.limit ?? 20),
        maxDepth: Number(call.params.maxDepth ?? 2),
        maxBreadth: Number(call.params.maxBreadth ?? 20),
        instructions: p(call, 'instructions'),
        selectPaths: Array.isArray(call.params.selectPaths) ? call.params.selectPaths as string[] : undefined,
        selectDomains: Array.isArray(call.params.selectDomains) ? call.params.selectDomains as string[] : undefined,
        excludePaths: Array.isArray(call.params.excludePaths) ? call.params.excludePaths as string[] : undefined,
        excludeDomains: Array.isArray(call.params.excludeDomains) ? call.params.excludeDomains as string[] : undefined,
        allowExternal: Boolean(call.params.allowExternal ?? false),
      });
    case 'crawl_web':
      return crawlWebTool(toolContext.config, p(call, 'url'), {
        maxDepth: Number(call.params.maxDepth ?? 2),
        maxBreadth: Number(call.params.maxBreadth ?? 20),
        limit: Number(call.params.limit ?? 10),
        instructions: p(call, 'instructions'),
        extractDepth: String(call.params.extractDepth ?? 'basic') as 'basic' | 'advanced',
        selectPaths: Array.isArray(call.params.selectPaths) ? call.params.selectPaths as string[] : undefined,
        selectDomains: Array.isArray(call.params.selectDomains) ? call.params.selectDomains as string[] : undefined,
        excludePaths: Array.isArray(call.params.excludePaths) ? call.params.excludePaths as string[] : undefined,
        excludeDomains: Array.isArray(call.params.excludeDomains) ? call.params.excludeDomains as string[] : undefined,
        allowExternal: Boolean(call.params.allowExternal ?? false),
        includeImages: Boolean(call.params.includeImages ?? false),
        format: String(call.params.format ?? 'text') as 'text' | 'markdown',
        maxCharsPerPage: Number(call.params.maxCharsPerPage ?? 3_000),
      });
    case 'validate_code':
      try {
        return validateCodeTool(resolveWorkspacePath(toolContext.workspaceRoot, p(call, 'path')));
      } catch (error) {
        return Object.freeze({
          success: false,
          content: '',
          error: String(error),
        });
      }
    case 'run_project_command':
      return runProjectCommandTool(
        toolContext.workspaceRoot,
        p(call, 'command', p(call, 'commandId')),
        {
          cwd: p(call, 'cwd'),
          maxChars: Number(call.params.maxChars ?? 8_000),
          stream: typeof call.params.toolCallId === 'string'
            ? {
                onStart: async ({ commandText, cwd, startedAt }) => {
                  await toolContext.onProjectCommandStart?.({
                    toolCallId: call.params.toolCallId as string,
                    commandText,
                    cwd,
                    startedAt,
                  });
                },
                onChunk: async ({ chunk }) => {
                  await toolContext.onProjectCommandChunk?.({
                    toolCallId: call.params.toolCallId as string,
                    chunk,
                  });
                },
                onEnd: async ({ exitCode, success, durationMs, background }) => {
                  await toolContext.onProjectCommandEnd?.({
                    toolCallId: call.params.toolCallId as string,
                    exitCode,
                    success,
                    durationMs,
                    ...(background ? { background } : {}),
                  });
                },
                onComplete: async ({ commandText, cwd, exitCode, success, durationMs, output, background }) => {
                  await toolContext.onProjectCommandComplete?.({
                    toolCallId: call.params.toolCallId as string,
                    commandText,
                    cwd,
                    exitCode,
                    success,
                    durationMs,
                    output,
                    background,
                  });
                },
              }
            : undefined,
        },
      );
    case 'galaxy_design_project_info':
      return galaxyDesignProjectInfoTool(toolContext.workspaceRoot, p(call, 'path'));
    case 'galaxy_design_registry':
      return galaxyDesignRegistryTool(toolContext.workspaceRoot, {
        framework: p(call, 'framework'),
        component: p(call, 'component'),
        group: p(call, 'group'),
        query: p(call, 'query'),
        path: p(call, 'path'),
      });
    case 'galaxy_design_init': {
      const result = await galaxyDesignInitTool(toolContext.workspaceRoot, p(call, 'path'));
      if (result.success) {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    case 'galaxy_design_add': {
      const result = await galaxyDesignAddTool(
        toolContext.workspaceRoot,
        Array.isArray(call.params.components) ? (call.params.components as string[]) : p(call, 'components'),
        p(call, 'path'),
      );
      if (result.success) {
        await toolContext.refreshWorkspaceFiles();
      }
      return result;
    }
    default:
      return Object.freeze({
        success: false,
        content: '',
        error: `Unknown tool: ${call.name}`,
      });
  }
}

export function getToolFilePath(call: ToolCall): string {
  return p(call, 'path');
}

export function isCodeWriteTool(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized === 'write_file' || normalized === 'edit_file' || normalized === 'edit_file_range';
}

const FILE_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'read_file',
    description: 'Read file content, optionally with maxLines and offset to avoid loading the whole file.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File or directory path inside the workspace' }),
        maxLines: Object.freeze({ type: 'number', description: 'Maximum number of lines to read (default 200)' }),
        offset: Object.freeze({ type: 'number', description: 'Start line offset, 0-based' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'write_file',
    description: 'Write or overwrite an entire file. Prefer this for new files or full rewrites.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
        content: Object.freeze({ type: 'string', description: 'Full file content to write' }),
      }),
      required: Object.freeze(['path', 'content']),
    }),
  }),
  Object.freeze({
    name: 'edit_file',
    description: 'Edit a specific part of a file by replacing old_string with new_string. Prefer this over write_file for targeted changes.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
        old_string: Object.freeze({ type: 'string', description: 'Exact text to find' }),
        new_string: Object.freeze({ type: 'string', description: 'Replacement text' }),
        replace_all: Object.freeze({ type: 'boolean', description: 'Replace all matches instead of one exact match' }),
      }),
      required: Object.freeze(['path', 'old_string', 'new_string']),
    }),
  }),
  Object.freeze({
    name: 'edit_file_range',
    description: 'Edit a specific line range in a file by replacing lines start_line through end_line with new_content. Prefer this when you know the target line range from a recent read_file result.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
        start_line: Object.freeze({ type: 'number', description: '1-based start line, inclusive' }),
        end_line: Object.freeze({ type: 'number', description: '1-based end line, inclusive' }),
        new_content: Object.freeze({ type: 'string', description: 'Replacement content for the target line range' }),
      }),
      required: Object.freeze(['path', 'start_line', 'end_line', 'new_content']),
    }),
  }),
  Object.freeze({
    name: 'grep',
    description: 'Search for a pattern in a file or directory using just-in-time retrieval.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        pattern: Object.freeze({ type: 'string', description: 'Regex or literal pattern to search' }),
        path: Object.freeze({ type: 'string', description: 'File or directory path inside the workspace' }),
        contextLines: Object.freeze({ type: 'number', description: 'Context lines around each match (default 2)' }),
      }),
      required: Object.freeze(['pattern', 'path']),
    }),
  }),
  Object.freeze({
    name: 'list_dir',
    description: 'List the workspace directory structure for a target path. This is shallow by default; increase depth only when needed.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Directory path inside the workspace' }),
        depth: Object.freeze({ type: 'number', description: 'Directory traversal depth, where 0 lists only the target directory (default 0)' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'head',
    description: 'Read the first N lines of a file.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
        lines: Object.freeze({ type: 'number', description: 'Number of lines to read (default 50)' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'tail',
    description: 'Read the last N lines of a file.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
        lines: Object.freeze({ type: 'number', description: 'Number of lines to read (default 50)' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'read_document',
    description: 'Read and extract structured content from a document file. Supports PDF, DOCX/DOC, XLSX/XLS/XLSM/XLSB, CSV, MD, and TXT. Use offset/maxChars for long documents.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Path to the document file inside the workspace or an attached copied file' }),
        maxChars: Object.freeze({ type: 'number', description: 'Maximum characters to return for this chunk (default 20000)' }),
        offset: Object.freeze({ type: 'number', description: 'Character offset for chunked document reading (default 0)' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'search_web',
    description: 'Search the web with Tavily and return ranked results. Use this to discover relevant URLs and summaries.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        query: Object.freeze({ type: 'string', description: 'Search query' }),
        maxResults: Object.freeze({ type: 'number', description: 'Maximum number of results to return (default 5)' }),
        searchDepth: Object.freeze({ type: 'string', description: 'Search depth: basic or advanced' }),
        includeAnswer: Object.freeze({ type: 'boolean', description: 'Include a model-generated answer if available' }),
        includeRawContent: Object.freeze({ type: 'boolean', description: 'Include raw content snippets when available' }),
        includeDomains: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Restrict results to these domains' }),
        excludeDomains: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Exclude these domains from results' }),
        timeRange: Object.freeze({ type: 'string', description: 'Optional time range: day, week, month, year' }),
      }),
      required: Object.freeze(['query']),
    }),
  }),
  Object.freeze({
    name: 'extract_web',
    description: 'Extract readable content from one or more URLs with Tavily. Use this after search_web when you need the page content itself.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        urls: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'URLs to extract' }),
        extractDepth: Object.freeze({ type: 'string', description: 'Extraction depth: basic or advanced' }),
        format: Object.freeze({ type: 'string', description: 'Output format: text or markdown' }),
        query: Object.freeze({ type: 'string', description: 'Optional query to focus extraction' }),
        includeImages: Object.freeze({ type: 'boolean', description: 'Include images when available' }),
        maxCharsPerUrl: Object.freeze({ type: 'number', description: 'Maximum characters per URL in tool output (default 3000)' }),
      }),
      required: Object.freeze(['urls']),
    }),
  }),
  Object.freeze({
    name: 'map_web',
    description: 'Map a website with Tavily and return discovered URLs. Use this before crawl_web when you need to inspect a docs site structure.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        url: Object.freeze({ type: 'string', description: 'Base URL to map' }),
        limit: Object.freeze({ type: 'number', description: 'Maximum number of URLs to return (default 20)' }),
        maxDepth: Object.freeze({ type: 'number', description: 'Maximum crawl depth while mapping (default 2)' }),
        maxBreadth: Object.freeze({ type: 'number', description: 'Maximum breadth per level while mapping (default 20)' }),
        instructions: Object.freeze({ type: 'string', description: 'Optional instructions to bias URL discovery' }),
        selectPaths: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Only include these path patterns when mapping' }),
        selectDomains: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Only include these domains when mapping' }),
        excludePaths: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Exclude these path patterns when mapping' }),
        excludeDomains: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Exclude these domains when mapping' }),
        allowExternal: Object.freeze({ type: 'boolean', description: 'Allow mapping URLs outside the starting domain' }),
      }),
      required: Object.freeze(['url']),
    }),
  }),
  Object.freeze({
    name: 'crawl_web',
    description: 'Crawl a website with Tavily and extract readable content from multiple pages. Use this for programming docs after map_web or when a docs site is already known.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        url: Object.freeze({ type: 'string', description: 'Base URL to crawl' }),
        maxDepth: Object.freeze({ type: 'number', description: 'Maximum crawl depth (default 2)' }),
        maxBreadth: Object.freeze({ type: 'number', description: 'Maximum breadth per level (default 20)' }),
        limit: Object.freeze({ type: 'number', description: 'Maximum number of pages to crawl (default 10)' }),
        instructions: Object.freeze({ type: 'string', description: 'Optional instructions to bias crawling' }),
        extractDepth: Object.freeze({ type: 'string', description: 'Extraction depth: basic or advanced' }),
        selectPaths: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Only include these path patterns when crawling' }),
        selectDomains: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Only include these domains when crawling' }),
        excludePaths: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Exclude these path patterns when crawling' }),
        excludeDomains: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Exclude these domains when crawling' }),
        allowExternal: Object.freeze({ type: 'boolean', description: 'Allow crawling URLs outside the starting domain' }),
        includeImages: Object.freeze({ type: 'boolean', description: 'Include image references when available' }),
        format: Object.freeze({ type: 'string', description: 'Output format: text or markdown' }),
        maxCharsPerPage: Object.freeze({ type: 'number', description: 'Maximum characters per crawled page in tool output (default 3000)' }),
      }),
      required: Object.freeze(['url']),
    }),
  }),
]);

const ACTION_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'run_project_command',
    description: 'Run a workspace command for build, test, lint, git, filesystem setup, or other project actions. Execution depends on local command permissions.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        command: Object.freeze({ type: 'string', description: 'Exact command to run in the workspace shell' }),
        cwd: Object.freeze({ type: 'string', description: 'Optional working directory inside the workspace' }),
        maxChars: Object.freeze({ type: 'number', description: 'Maximum output characters to return, default 8000' }),
      }),
      required: Object.freeze(['command']),
    }),
  }),
]);

const QUALITY_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'validate_code',
    description: 'Run a lightweight single-file validation fallback. Use this when you need an explicit check for one file.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'request_code_review',
    description: 'Ask the internal Code Reviewer sub-agent to review files changed in this session. Use near the end after your edits are ready.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
      required: Object.freeze([]),
    }),
  }),
]);

const GALAXY_DESIGN_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'galaxy_design_project_info',
    description: 'Detect the target project framework, package manager, and whether Galaxy Design is already initialized.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Optional target project path inside the workspace' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'galaxy_design_registry',
    description: 'Inspect published Galaxy Design registries to understand available components and dependencies.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        framework: Object.freeze({ type: 'string', description: 'Optional framework filter' }),
        component: Object.freeze({ type: 'string', description: 'Exact component name to inspect' }),
        group: Object.freeze({ type: 'string', description: 'Component group to inspect' }),
        query: Object.freeze({ type: 'string', description: 'Search query across Galaxy Design registries' }),
        path: Object.freeze({ type: 'string', description: 'Optional target project path inside the workspace' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'galaxy_design_init',
    description: 'Initialize Galaxy Design in a detected project. This may require approval.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Optional target project path inside the workspace' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'galaxy_design_add',
    description: 'Add Galaxy Design components to an initialized project. This may require approval.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        components: Object.freeze({
          type: 'array',
          items: Object.freeze({ type: 'string' }),
          description: 'Galaxy Design component names to add',
        }),
        path: Object.freeze({ type: 'string', description: 'Optional target project path inside the workspace' }),
      }),
      required: Object.freeze(['components']),
    }),
  }),
]);

export function isToolEnabled(toolName: string, config: GalaxyConfig): boolean {
  const normalized = normalizeToolName(toolName);
  switch (normalized) {
    case 'run_project_command':
      return config.toolSafety.enableProjectCommandTool;
    case 'validate_code':
      return config.quality.test;
    case 'request_code_review':
      return config.quality.review;
    default:
      return true;
  }
}

export function getEnabledToolDefinitions(config: GalaxyConfig): readonly ToolDefinition[] {
  const qualityTools = QUALITY_TOOL_DEFINITIONS.filter((definition) => isToolEnabled(definition.name, config));
  return Object.freeze([
    ...FILE_TOOL_DEFINITIONS,
    ...ACTION_TOOL_DEFINITIONS.filter((definition) => definition.name === 'run_project_command' && isToolEnabled(definition.name, config)),
    ...qualityTools,
    ...GALAXY_DESIGN_TOOL_DEFINITIONS,
  ]);
}
