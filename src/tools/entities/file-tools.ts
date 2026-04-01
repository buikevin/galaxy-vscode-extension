/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Shared tool-layer entities for VS Code file tools.
 */

import type { GalaxyConfig } from '../../shared/config';
import type { ExtensionToolGroup, ExtensionToolItem } from '../../shared/protocol';

export type ToolResult = Readonly<{
  /** Whether the tool completed successfully. */
  success: boolean;
  /** Main textual payload returned to the model. */
  content: string;
  /** Optional error message when the tool fails. */
  error?: string;
  /** Optional structured metadata for downstream consumers. */
  meta?: Readonly<Record<string, unknown>>;
}>;

export type ToolCall = Readonly<{
  /** Tool runtime name. */
  name: string;
  /** Raw tool parameters as provided by the model. */
  params: Record<string, unknown>;
}>;

export type ToolDefinition = Readonly<{
  /** Tool runtime name. */
  name: string;
  /** Human-readable tool description. */
  description: string;
  /** JSON-schema-like parameter definition. */
  parameters: Readonly<Record<string, unknown>>;
}>;

export type RevealRange = Readonly<{
  /** 1-based starting line to reveal. */
  startLine: number;
  /** 1-based ending line to reveal. */
  endLine: number;
}>;

export type FileToolContext = Readonly<{
  /** Absolute workspace root for path resolution. */
  workspaceRoot: string;
  /** Effective Galaxy configuration for the workspace. */
  config: GalaxyConfig;
  /** Reveals a file and optional range in the editor. */
  revealFile: (filePath: string, range?: RevealRange) => Promise<void>;
  /** Refreshes cached workspace files. */
  refreshWorkspaceFiles: () => Promise<void>;
  /** Opens a tracked diff for a file. */
  openTrackedDiff?: (filePath: string) => Promise<ToolResult>;
  /** Shows current problems for a file or workspace. */
  showProblems?: (filePath?: string) => Promise<ToolResult>;
  /** Uses workspace search with optional filters. */
  workspaceSearch?: (
    query: string,
    options?: Readonly<{
      includes?: string;
      maxResults?: number;
      isRegex?: boolean;
      isCaseSensitive?: boolean;
      matchWholeWord?: boolean;
    }>,
  ) => Promise<ToolResult>;
  /** Finds references using the editor provider. */
  findReferences?: (
    filePath: string,
    options?: Readonly<{
      line?: number;
      character?: number;
      symbol?: string;
      maxResults?: number;
    }>,
  ) => Promise<ToolResult>;
  /** Executes an extension command by id. */
  executeExtensionCommand?: (commandId: string, title: string, extensionId: string) => Promise<ToolResult>;
  /** Invokes a language-model-backed extension tool. */
  invokeLanguageModelTool?: (
    toolName: string,
    title: string,
    extensionId: string,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<ToolResult>;
  /** Searches discoverable extension tools. */
  searchExtensionTools?: (query: string, maxResults?: number) => Promise<ToolResult>;
  /** Activates selected extension tools. */
  activateExtensionTools?: (toolKeys: readonly string[]) => Promise<ToolResult>;
  /** Returns the latest persisted test failure. */
  getLatestTestFailure?: () => Promise<ToolResult>;
  /** Returns the latest persisted review findings. */
  getLatestReviewFindings?: () => Promise<ToolResult>;
  /** Returns the next unresolved review finding. */
  getNextReviewFinding?: () => Promise<ToolResult>;
  /** Dismisses one persisted review finding. */
  dismissReviewFinding?: (findingId: string) => Promise<ToolResult>;
  /** Signals that a managed project command started. */
  onProjectCommandStart?: (payload: Readonly<{ toolCallId: string; commandText: string; cwd: string; startedAt: number }>) => Promise<void> | void;
  /** Streams project-command output chunks. */
  onProjectCommandChunk?: (payload: Readonly<{ toolCallId: string; chunk: string }>) => Promise<void> | void;
  /** Signals project-command completion metadata. */
  onProjectCommandEnd?: (payload: Readonly<{ toolCallId: string; exitCode: number; success: boolean; durationMs: number; background?: boolean }>) => Promise<void> | void;
  /** Reports final project-command output. */
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

export type DiscoveredExtensionTool = Readonly<{
  /** Tool group that owns the extension tool. */
  group: ExtensionToolGroup;
  /** Concrete extension tool item. */
  tool: ExtensionToolItem;
}>;

export type LineEditSnapshot = Readonly<{
  /** Exact content previously read for the target range. */
  expectedRangeContent?: string;
  /** Whether expectedRangeContent was explicitly provided by the caller. */
  expectedRangeContentProvided?: boolean;
  /** Exact line expected immediately before the target range. */
  anchorBefore?: string;
  /** Exact line expected immediately after the target range. */
  anchorAfter?: string;
}>;

export type EditFileRangeRequest = Readonly<{
  /** 1-based starting line to replace. */
  startLine: number;
  /** 1-based ending line to replace. */
  endLine: number;
  /** Replacement content for the target range. */
  newContent: string;
  /** Total line count from the last trusted read. */
  expectedTotalLines?: number;
  /** Exact content previously read for the target range. */
  expectedRangeContent?: string;
  /** Exact line expected immediately before the target range. */
  anchorBefore?: string;
  /** Exact line expected immediately after the target range. */
  anchorAfter?: string;
}>;

export type InsertFileAtLineRequest = Readonly<{
  /** 1-based line number before which content will be inserted. */
  line: number;
  /** Content to insert at the requested position. */
  contentToInsert: string;
  /** Total line count from the last trusted read. */
  expectedTotalLines?: number;
  /** Exact line expected immediately before the insertion point. */
  anchorBefore?: string;
  /** Exact line expected immediately after the insertion point. */
  anchorAfter?: string;
}>;

export type MultiEditFileRange = Readonly<{
  /** 1-based starting line to replace. */
  start_line: number;
  /** 1-based ending line to replace. */
  end_line: number;
  /** Replacement content for the target range. */
  new_content: string;
  /** Exact content previously read for the target range. */
  expected_range_content?: string;
  /** Exact line expected immediately before the target range. */
  anchor_before?: string;
  /** Exact line expected immediately after the target range. */
  anchor_after?: string;
}>;

export type WebSearchToolOptions = Readonly<{
  /** Maximum number of search hits to request from Tavily. */
  maxResults?: number;
  /** Search depth requested from Tavily. */
  searchDepth?: 'basic' | 'advanced';
  /** Whether Tavily should include an answer summary. */
  includeAnswer?: boolean;
  /** Whether Tavily should include raw page content. */
  includeRawContent?: boolean;
  /** Domain allowlist applied to the search. */
  includeDomains?: string[];
  /** Domain denylist applied to the search. */
  excludeDomains?: string[];
  /** Relative freshness window for the search. */
  timeRange?: 'day' | 'week' | 'month' | 'year';
}>;

export type WebMapToolOptions = Readonly<{
  /** Maximum number of URLs to map. */
  limit?: number;
  /** Maximum crawl depth from the seed URL. */
  maxDepth?: number;
  /** Maximum breadth per crawl level. */
  maxBreadth?: number;
  /** Extra crawl instructions sent to Tavily. */
  instructions?: string;
  /** Path allowlist applied during mapping. */
  selectPaths?: string[];
  /** Domain allowlist applied during mapping. */
  selectDomains?: string[];
  /** Path denylist applied during mapping. */
  excludePaths?: string[];
  /** Domain denylist applied during mapping. */
  excludeDomains?: string[];
  /** Whether the crawl may leave the original domain. */
  allowExternal?: boolean;
}>;

export type WebExtractToolOptions = Readonly<{
  /** Extraction depth requested from Tavily. */
  extractDepth?: 'basic' | 'advanced';
  /** Desired content format for extracted pages. */
  format?: 'text' | 'markdown';
  /** Semantic query used to bias extraction. */
  query?: string;
  /** Whether extracted image references should be included. */
  includeImages?: boolean;
  /** Maximum characters to keep per extracted URL. */
  maxCharsPerUrl?: number;
}>;

export type WebCrawlToolOptions = Readonly<{
  /** Maximum crawl depth from the starting URL. */
  maxDepth?: number;
  /** Maximum breadth per crawl level. */
  maxBreadth?: number;
  /** Maximum number of pages to crawl. */
  limit?: number;
  /** Extra crawl instructions sent to Tavily. */
  instructions?: string;
  /** Extraction depth for crawled pages. */
  extractDepth?: 'basic' | 'advanced';
  /** Path allowlist applied during crawl. */
  selectPaths?: string[];
  /** Domain allowlist applied during crawl. */
  selectDomains?: string[];
  /** Path denylist applied during crawl. */
  excludePaths?: string[];
  /** Domain denylist applied during crawl. */
  excludeDomains?: string[];
  /** Whether the crawl may leave the original domain. */
  allowExternal?: boolean;
  /** Whether extracted image references should be included. */
  includeImages?: boolean;
  /** Desired content format for crawled pages. */
  format?: 'text' | 'markdown';
  /** Maximum characters to keep per crawled page. */
  maxCharsPerPage?: number;
}>;

export type ReadFileToolOptions = Readonly<{
  /** Zero-based line offset to start reading from. */
  offset?: number;
  /** Maximum number of lines to return. */
  maxLines?: number;
}>;

export type ReadDocumentToolOptions = Readonly<{
  /** Maximum number of decoded characters returned from the document read. */
  maxChars?: number;
  /** Character offset used for sequential document pagination. */
  offset?: number;
  /** Semantic query used to retrieve relevant snippets instead of raw text. */
  query?: string;
}>;

export type GrepToolOptions = Readonly<{
  /** Number of surrounding context lines to include for each match. */
  contextLines?: number;
}>;

export type ListDirToolOptions = Readonly<{
  /** Maximum traversal depth relative to the requested directory. */
  depth?: number;
}>;
