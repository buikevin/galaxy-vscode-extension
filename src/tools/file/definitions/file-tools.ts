/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc File and web tool schema definitions for the VS Code runtime.
 */

import type { ToolDefinition } from '../../entities/file-tools';

export const FILE_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
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
    name: 'find_test_files',
    description: 'Find likely related test files for a source file, or likely source files for a test file.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Source or test file path inside the workspace' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'get_latest_test_failure',
    description: 'Get the latest persisted test failure from the current workspace, if one exists.',
    parameters: Object.freeze({ type: 'object', properties: Object.freeze({}), required: Object.freeze([]) }),
  }),
  Object.freeze({
    name: 'get_latest_review_findings',
    description: 'Get the latest persisted code review findings from the current workspace, if they exist.',
    parameters: Object.freeze({ type: 'object', properties: Object.freeze({}), required: Object.freeze([]) }),
  }),
  Object.freeze({
    name: 'get_next_review_finding',
    description: 'Get the next open review finding from the latest persisted review results.',
    parameters: Object.freeze({ type: 'object', properties: Object.freeze({}), required: Object.freeze([]) }),
  }),
  Object.freeze({
    name: 'dismiss_review_finding',
    description: 'Dismiss one persisted review finding by id after you have handled or rejected it.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        finding_id: Object.freeze({ type: 'string', description: 'Exact id of the review finding to dismiss' }),
      }),
      required: Object.freeze(['finding_id']),
    }),
  }),
  Object.freeze({
    name: 'write_file',
    description: 'Create a new file. This tool refuses to overwrite an existing file.',
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
    name: 'insert_file_at_line',
    description: 'Insert content before a specific line in an existing file. Prefer this for adding imports, props, or small blocks without rewriting a whole range. This now requires expected_total_lines plus anchor_before and/or anchor_after from a recent read_file result.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
        line: Object.freeze({ type: 'number', description: '1-based line number before which the new content will be inserted' }),
        content: Object.freeze({ type: 'string', description: 'Content to insert' }),
        expected_total_lines: Object.freeze({ type: 'number', description: 'Total line count from the most recent read_file result for this file. Use it to avoid inserting into a stale snapshot.' }),
        anchor_before: Object.freeze({ type: 'string', description: 'Exact content of the line immediately before the insertion point from a recent read_file result.' }),
        anchor_after: Object.freeze({ type: 'string', description: 'Exact content of the line currently at the insertion point from a recent read_file result.' }),
      }),
      required: Object.freeze(['path', 'line', 'content', 'expected_total_lines']),
    }),
  }),
  Object.freeze({
    name: 'edit_file_range',
    description: 'Edit a specific line range in a file by replacing lines start_line through end_line with new_content. This now requires expected_total_lines plus exact expected_range_content or nearby anchors from a recent read_file result.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
        start_line: Object.freeze({ type: 'number', description: '1-based start line, inclusive' }),
        end_line: Object.freeze({ type: 'number', description: '1-based end line, inclusive' }),
        new_content: Object.freeze({ type: 'string', description: 'Replacement content for the target line range' }),
        expected_total_lines: Object.freeze({ type: 'number', description: 'Total line count from the most recent read_file result for this file. Use it to avoid editing stale line ranges.' }),
        expected_range_content: Object.freeze({ type: 'string', description: 'Exact existing content currently in lines start_line through end_line from a recent read_file result.' }),
        anchor_before: Object.freeze({ type: 'string', description: 'Exact content of the line immediately before start_line from a recent read_file result.' }),
        anchor_after: Object.freeze({ type: 'string', description: 'Exact content of the line immediately after end_line from a recent read_file result.' }),
      }),
      required: Object.freeze(['path', 'start_line', 'end_line', 'new_content', 'expected_total_lines']),
    }),
  }),
  Object.freeze({
    name: 'multi_edit_file_ranges',
    description: 'Apply multiple targeted line-range edits to one existing file in a single call. This now requires expected_total_lines, and each edit should include exact expected content or anchors from a recent read_file result.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'File path inside the workspace' }),
        expected_total_lines: Object.freeze({ type: 'number', description: 'Total line count from the most recent read_file result for this file. Use it to avoid editing stale line ranges.' }),
        edits: Object.freeze({
          type: 'array',
          description: 'Non-overlapping range edits, based on the current file line numbers.',
          items: Object.freeze({
            type: 'object',
            properties: Object.freeze({
              start_line: Object.freeze({ type: 'number', description: '1-based start line, inclusive' }),
              end_line: Object.freeze({ type: 'number', description: '1-based end line, inclusive' }),
              new_content: Object.freeze({ type: 'string', description: 'Replacement content for that range' }),
              expected_range_content: Object.freeze({ type: 'string', description: 'Exact existing content in that range from a recent read_file result.' }),
              anchor_before: Object.freeze({ type: 'string', description: 'Exact content of the line immediately before this range from a recent read_file result.' }),
              anchor_after: Object.freeze({ type: 'string', description: 'Exact content of the line immediately after this range from a recent read_file result.' }),
            }),
            required: Object.freeze(['start_line', 'end_line', 'new_content']),
          }),
        }),
      }),
      required: Object.freeze(['path', 'edits', 'expected_total_lines']),
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
    description: 'Read and extract structured content from a document file. Supports PDF, DOCX/DOC, XLSX/XLS/XLSM/XLSB, CSV, MD, and TXT. Use offset/maxChars for sequential reading, or query for semantic snippets relevant to the current question.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Path to the document file inside the workspace or an attached copied file' }),
        maxChars: Object.freeze({ type: 'number', description: 'Maximum characters to return for this chunk (default 20000)' }),
        offset: Object.freeze({ type: 'number', description: 'Character offset for chunked document reading (default 0)' }),
        query: Object.freeze({ type: 'string', description: 'Optional semantic retrieval query. When provided, the tool returns the most relevant snippets instead of the next sequential chunk.' }),
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
