/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Native VS Code tool schema definitions.
 */

import type { ToolDefinition } from '../../entities/file-tools';

export const VSCODE_NATIVE_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'vscode_open_diff',
    description: 'Open the tracked diff for a workspace file in the native VS Code diff editor.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Workspace file path to open in native diff' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'vscode_start_frontend_preview',
    description: 'Start a local frontend preview by auto-discovering the best workspace app, launching its dev server, and opening the localhost preview panel.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        query: Object.freeze({ type: 'string', description: 'Optional project, package, or relative path hint used to choose the frontend app to preview' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'vscode_show_problems',
    description: 'Show the native Problems panel and return a compact summary of diagnostics, optionally filtered to one file.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Optional workspace file path to filter diagnostics' }),
      }),
      required: Object.freeze([]),
    }),
  }),
  Object.freeze({
    name: 'vscode_workspace_search',
    description: 'Use native VS Code workspace text search and return a compact summary of matches.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        query: Object.freeze({ type: 'string', description: 'Search query' }),
        includes: Object.freeze({ type: 'string', description: 'Optional include glob, for example src/**/*.ts' }),
        maxResults: Object.freeze({ type: 'number', description: 'Maximum number of matches to summarize (default 20)' }),
        isRegex: Object.freeze({ type: 'boolean', description: 'Treat query as regex' }),
        isCaseSensitive: Object.freeze({ type: 'boolean', description: 'Use case-sensitive search' }),
        matchWholeWord: Object.freeze({ type: 'boolean', description: 'Match whole words only' }),
      }),
      required: Object.freeze(['query']),
    }),
  }),
  Object.freeze({
    name: 'vscode_find_references',
    description: 'Use the native VS Code references provider for a symbol in a file, based on line/character or a best-effort symbol match.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: Object.freeze({ type: 'string', description: 'Workspace file path containing the symbol' }),
        line: Object.freeze({ type: 'number', description: '1-based line number for the symbol position' }),
        character: Object.freeze({ type: 'number', description: '1-based character for the symbol position' }),
        symbol: Object.freeze({ type: 'string', description: 'Optional symbol text to locate when line/character is unavailable' }),
        maxResults: Object.freeze({ type: 'number', description: 'Maximum references to summarize (default 20)' }),
      }),
      required: Object.freeze(['path']),
    }),
  }),
  Object.freeze({
    name: 'search_extension_tools',
    description: 'Search the locally installed VS Code extension tool catalog. Use this when you need a domain-specific extension tool such as prisma, python, git, nx, or similar.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        query: Object.freeze({ type: 'string', description: 'Domain or keyword to search for, for example prisma, python, git, nx' }),
        maxResults: Object.freeze({ type: 'number', description: 'Maximum number of extension groups to return (default 8)' }),
      }),
      required: Object.freeze(['query']),
    }),
  }),
  Object.freeze({
    name: 'activate_extension_tools',
    description: 'Activate specific discovered extension tools by their tool keys so they become available in the runtime tool schema for later turns.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        tool_keys: Object.freeze({
          type: 'array',
          items: Object.freeze({ type: 'string' }),
          description: 'Exact tool keys returned by search_extension_tools',
        }),
      }),
      required: Object.freeze(['tool_keys']),
    }),
  }),
]);
