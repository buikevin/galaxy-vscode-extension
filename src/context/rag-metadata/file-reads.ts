/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-25
 * @modify date 2026-04-25
 * @desc File-read trail persistence: logs every read_file invocation per session
 *       so retrieval and prompt assembly can dedupe rereads and prioritize fresh paths.
 */

import { withRagMetadataDatabase } from "./database";

export type FileReadInput = Readonly<{
  workspaceId: string;
  turnId: string;
  filePath: string;
  readMode: string;
  offset: number;
  limit: number;
  mtimeMs: number;
  sizeBytes: number;
  cached: boolean;
}>;

export type FileReadRecord = Readonly<{
  id: number;
  workspaceId: string;
  turnId: string;
  filePath: string;
  readMode: string;
  offset: number;
  limit: number;
  mtimeMs: number;
  sizeBytes: number;
  cached: boolean;
  createdAt: number;
}>;

export function recordFileRead(
  workspacePath: string,
  input: FileReadInput,
): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    db.prepare(
      `
      INSERT INTO file_reads (
        workspace_id,
        turn_id,
        file_path,
        read_mode,
        offset_value,
        limit_value,
        mtime_ms,
        size_bytes,
        cached,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      input.workspaceId,
      input.turnId,
      input.filePath,
      input.readMode,
      input.offset,
      input.limit,
      input.mtimeMs,
      input.sizeBytes,
      input.cached ? 1 : 0,
      Date.now(),
    );
  });
}

function rowToRecord(row: Readonly<Record<string, unknown>>): FileReadRecord {
  return Object.freeze({
    id: Number(row.id),
    workspaceId: String(row.workspace_id),
    turnId: String(row.turn_id),
    filePath: String(row.file_path),
    readMode: String(row.read_mode),
    offset: Number(row.offset_value),
    limit: Number(row.limit_value),
    mtimeMs: Number(row.mtime_ms),
    sizeBytes: Number(row.size_bytes),
    cached: Number(row.cached) === 1,
    createdAt: Number(row.created_at),
  });
}

export function listFileReadsByTurn(
  workspacePath: string,
  turnId: string,
): readonly FileReadRecord[] {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const rows = db
      .prepare(
        `
      SELECT * FROM file_reads WHERE turn_id = ? ORDER BY id ASC
    `,
      )
      .all(turnId) as Array<Readonly<Record<string, unknown>>>;
    return Object.freeze(rows.map(rowToRecord));
  });
}

export function listRecentlyReadFiles(
  workspacePath: string,
  workspaceId: string,
  limit = 50,
): readonly string[] {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const rows = db
      .prepare(
        `
      SELECT file_path, MAX(created_at) AS recent
      FROM file_reads
      WHERE workspace_id = ?
      GROUP BY file_path
      ORDER BY recent DESC
      LIMIT ?
    `,
      )
      .all(workspaceId, limit) as Array<Readonly<{ file_path: string }>>;
    return Object.freeze(rows.map((row) => String(row.file_path)));
  });
}
