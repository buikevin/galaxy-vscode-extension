/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Document read helpers for VS Code file tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { queryDocumentSemanticSnippets } from '../../context/document-semantic-store';
import { getCachedReadResult, storeReadCache } from '../../context/rag-metadata/read-cache';
import { readDocumentFile } from '../document-reader';
import { resolveReadablePath } from './path-read';
import type { ReadDocumentToolOptions, ToolResult } from '../entities/file-tools';

/**
 * Reads a workspace document either sequentially or through semantic snippet retrieval.
 *
 * @param workspaceRoot Absolute workspace root used for path resolution and cache keys.
 * @param rawPath User-provided document path.
 * @param options Document read options for pagination or semantic lookup.
 * @returns Tool result containing either semantic snippets or raw decoded text.
 */
export async function readDocumentTool(
  workspaceRoot: string,
  rawPath: string,
  options?: ReadDocumentToolOptions,
): Promise<ToolResult> {
  try {
    const resolved = resolveReadablePath(workspaceRoot, rawPath);
    const stat = fs.statSync(resolved);
    const maxChars = Math.max(1, Number(options?.maxChars ?? 20_000));
    const offset = Math.max(0, Number(options?.offset ?? 0));
    const query = String(options?.query ?? '').trim();
    const semanticMode = query.length > 0 && offset <= 0;
    if (semanticMode) {
      const semantic = await queryDocumentSemanticSnippets({
        workspacePath: workspaceRoot,
        filePath: resolved,
        queryText: query,
        limit: 3,
      });
      if (semantic.snippets.length > 0) {
        return Object.freeze({
          success: true,
          content: [
            '[DOCUMENT SEMANTIC SNIPPETS]',
            `Path: ${resolved}`,
            semantic.format ? `Format: ${semantic.format}` : '',
            typeof semantic.pageCount === 'number' ? `Page count: ${semantic.pageCount}` : '',
            '',
            ...semantic.snippets.map((snippet, index) => `[Snippet ${index + 1}] ${snippet}`),
            '',
            'If you need the exact full wording or sequential context, call read_document again with maxChars/offset and without query.',
          ].filter(Boolean).join('\n'),
          meta: Object.freeze({
            filePath: resolved,
            readMode: 'document_semantic',
            query,
            ...(semantic.format ? { format: semantic.format } : {}),
            ...(typeof semantic.pageCount === 'number' ? { pageCount: semantic.pageCount } : {}),
            cacheHit: false,
          }),
        });
      }
    }

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
