/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Tavily-backed web helpers for VS Code file tools.
 */

import { tavily } from '@tavily/core';
import type { GalaxyConfig } from '../../shared/config';
import { TAVILY_API_KEY } from './constants';
import type {
  ToolResult,
  WebCrawlToolOptions,
  WebExtractToolOptions,
  WebMapToolOptions,
  WebSearchToolOptions,
} from '../entities/file-tools';

let tavilyClient: ReturnType<typeof tavily> | null = null;
let tavilyClientKey = '';

/**
 * Returns a cached Tavily client for the active workspace configuration.
 *
 * @param config Current Galaxy configuration for the workspace.
 * @returns A ready-to-use Tavily client or a user-facing error.
 */
function getTavilyClient(config: GalaxyConfig): { client?: ReturnType<typeof tavily>; error?: string } {
  void config;
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

/**
 * Truncates large web payloads to a safe size for model consumption.
 *
 * @param text Source text to truncate.
 * @param maxChars Maximum number of characters to preserve.
 * @returns Truncated text with a suffix when data was removed.
 */
export function truncateText(text: string, maxChars = 2_000): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

/**
 * Formats Tavily search hits into a compact ranked list.
 *
 * @param results Search results returned by Tavily.
 * @param maxItems Maximum number of items to display.
 * @returns Human-readable ranked search output.
 */
export function formatSearchResults(
  results: Array<{ title?: string; url?: string; content?: string }>,
  maxItems = 5,
): string {
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

/**
 * Formats a list of mapped URLs into a numbered list.
 *
 * @param urls URLs returned by Tavily map or crawl operations.
 * @param maxItems Maximum number of URLs to display.
 * @returns Human-readable ranked URL list.
 */
function formatUrlResults(urls: readonly string[], maxItems = 20): string {
  if (urls.length === 0) {
    return '(no results)';
  }

  return urls.slice(0, maxItems).map((url, index) => `${index + 1}. ${url}`).join('\n');
}

/**
 * Runs a web search through Tavily and formats the response for the model.
 *
 * @param config Current Galaxy configuration for the workspace.
 * @param query Search query text.
 * @param options Optional Tavily search controls.
 * @returns Tool result containing formatted search content.
 */
export async function searchWebTool(
  config: GalaxyConfig,
  query: string,
  options?: WebSearchToolOptions,
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

/**
 * Maps URLs reachable from a starting page and returns the discovered list.
 *
 * @param config Current Galaxy configuration for the workspace.
 * @param url Seed URL used for mapping.
 * @param options Optional Tavily map controls.
 * @returns Tool result containing discovered URLs.
 */
export async function mapWebTool(
  config: GalaxyConfig,
  url: string,
  options?: WebMapToolOptions,
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

/**
 * Extracts readable content from one or more URLs using Tavily.
 *
 * @param config Current Galaxy configuration for the workspace.
 * @param urls URLs to extract content from.
 * @param options Optional Tavily extract controls.
 * @returns Tool result containing extracted page content.
 */
export async function extractWebTool(
  config: GalaxyConfig,
  urls: readonly string[],
  options?: WebExtractToolOptions,
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

/**
 * Crawls a website and returns truncated content for discovered pages.
 *
 * @param config Current Galaxy configuration for the workspace.
 * @param url Seed URL used for the crawl.
 * @param options Optional Tavily crawl controls.
 * @returns Tool result containing crawled page excerpts.
 */
export async function crawlWebTool(
  config: GalaxyConfig,
  url: string,
  options?: WebCrawlToolOptions,
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
