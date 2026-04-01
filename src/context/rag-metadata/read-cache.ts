/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Read-cache persistence helpers for decoded documents and file reads.
 */

import type { ReadCacheRecord } from '../entities/rag-metadata';
import { withRagMetadataDatabase } from './database';

/**
 * Returns a cached read result when the file snapshot and read window still match.
 */
export function getCachedReadResult(
  workspacePath: string,
  opts: Readonly<{
    filePath: string;
    mtimeMs: number;
    sizeBytes: number;
    readMode: string;
    offset: number;
    limit: number;
  }>,
): Readonly<{ content: string; meta?: Readonly<Record<string, unknown>> }> | null {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const row = db.prepare(`
      SELECT content, meta_json
      FROM read_cache
      WHERE file_path = ?
        AND mtime_ms = ?
        AND size_bytes = ?
        AND read_mode = ?
        AND offset_value = ?
        AND limit_value = ?
      LIMIT 1
    `).get(
      opts.filePath,
      opts.mtimeMs,
      opts.sizeBytes,
      opts.readMode,
      opts.offset,
      opts.limit,
    ) as { content: string; meta_json: string | null } | undefined;

    if (!row) {
      return null;
    }

    let parsedMeta: Readonly<Record<string, unknown>> | undefined;
    if (row.meta_json) {
      try {
        parsedMeta = Object.freeze(JSON.parse(row.meta_json) as Record<string, unknown>);
      } catch {
        parsedMeta = undefined;
      }
    }

    return Object.freeze({
      content: row.content,
      ...(parsedMeta ? { meta: parsedMeta } : {}),
    });
  });
}

/**
 * Stores or refreshes one cached read result for a specific file snapshot.
 */
export function storeReadCache(workspacePath: string, record: ReadCacheRecord): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    db.prepare(`
      INSERT INTO read_cache (
        file_path, mtime_ms, size_bytes, read_mode, offset_value, limit_value, content, meta_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, mtime_ms, size_bytes, read_mode, offset_value, limit_value) DO UPDATE SET
        content = excluded.content,
        meta_json = excluded.meta_json,
        updated_at = excluded.updated_at
    `).run(
      record.filePath,
      record.mtimeMs,
      record.sizeBytes,
      record.readMode,
      record.offset,
      record.limit,
      record.content,
      record.metaJson ?? null,
      Date.now(),
    );

    db.prepare(`
      DELETE FROM read_cache
      WHERE file_path = ?
        AND (mtime_ms != ? OR size_bytes != ?)
    `).run(record.filePath, record.mtimeMs, record.sizeBytes);
  });
}
