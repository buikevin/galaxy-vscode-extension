/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-25
 * @modify date 2026-04-25
 * @desc Edit ledger persistence: records every file mutation with before/after snapshots
 *       so the agent can revert changes and audit edit chains within a session.
 */

import { createHash } from "node:crypto";
import { withRagMetadataDatabase } from "./database";

export type CodeEditInput = Readonly<{
  workspaceId: string;
  turnId: string;
  toolName: string;
  filePath: string;
  rangeStartLine?: number | null;
  rangeEndLine?: number | null;
  beforeContent: string;
  afterContent: string;
  parentEditId?: number | null;
}>;

export type CodeEditRecord = Readonly<{
  id: number;
  workspaceId: string;
  turnId: string;
  toolName: string;
  filePath: string;
  rangeStartLine: number | null;
  rangeEndLine: number | null;
  beforeHash: string;
  afterHash: string;
  beforeBlob: string | null;
  afterBlob: string | null;
  parentEditId: number | null;
  revertedAt: number | null;
  createdAt: number;
}>;

const BLOB_PERSIST_THRESHOLD_BYTES = 200_000;

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function pickBlob(content: string): string | null {
  if (content.length === 0) {
    return "";
  }
  return Buffer.byteLength(content, "utf8") <= BLOB_PERSIST_THRESHOLD_BYTES
    ? content
    : null;
}

export function recordCodeEdit(
  workspacePath: string,
  input: CodeEditInput,
): number {
  const beforeHash = hashContent(input.beforeContent);
  const afterHash = hashContent(input.afterContent);
  const beforeBlob = pickBlob(input.beforeContent);
  const afterBlob = pickBlob(input.afterContent);

  return withRagMetadataDatabase(workspacePath, (db) => {
    const result = db
      .prepare(
        `
      INSERT INTO code_edits (
        workspace_id,
        turn_id,
        tool_name,
        file_path,
        range_start_line,
        range_end_line,
        before_hash,
        after_hash,
        before_blob,
        after_blob,
        parent_edit_id,
        reverted_at,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `,
      )
      .run(
        input.workspaceId,
        input.turnId,
        input.toolName,
        input.filePath,
        input.rangeStartLine ?? null,
        input.rangeEndLine ?? null,
        beforeHash,
        afterHash,
        beforeBlob,
        afterBlob,
        input.parentEditId ?? null,
        Date.now(),
      );
    return Number(result.lastInsertRowid);
  });
}

export function markCodeEditReverted(workspacePath: string, id: number): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    db.prepare(
      `UPDATE code_edits SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL`,
    ).run(Date.now(), id);
  });
}

function rowToRecord(row: Readonly<Record<string, unknown>>): CodeEditRecord {
  return Object.freeze({
    id: Number(row.id),
    workspaceId: String(row.workspace_id),
    turnId: String(row.turn_id),
    toolName: String(row.tool_name),
    filePath: String(row.file_path),
    rangeStartLine:
      row.range_start_line === null ? null : Number(row.range_start_line),
    rangeEndLine:
      row.range_end_line === null ? null : Number(row.range_end_line),
    beforeHash: String(row.before_hash),
    afterHash: String(row.after_hash),
    beforeBlob: row.before_blob === null ? null : String(row.before_blob),
    afterBlob: row.after_blob === null ? null : String(row.after_blob),
    parentEditId:
      row.parent_edit_id === null ? null : Number(row.parent_edit_id),
    revertedAt: row.reverted_at === null ? null : Number(row.reverted_at),
    createdAt: Number(row.created_at),
  });
}

export function listCodeEditsByTurn(
  workspacePath: string,
  turnId: string,
): readonly CodeEditRecord[] {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const rows = db
      .prepare(
        `
      SELECT * FROM code_edits WHERE turn_id = ? ORDER BY id ASC
    `,
      )
      .all(turnId) as Array<Readonly<Record<string, unknown>>>;
    return Object.freeze(rows.map(rowToRecord));
  });
}

export function listCodeEditsByWorkspace(
  workspacePath: string,
  workspaceId: string,
  limit = 100,
): readonly CodeEditRecord[] {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const rows = db
      .prepare(
        `
      SELECT * FROM code_edits WHERE workspace_id = ? ORDER BY id DESC LIMIT ?
    `,
      )
      .all(workspaceId, limit) as Array<Readonly<Record<string, unknown>>>;
    return Object.freeze(rows.map(rowToRecord));
  });
}

export function getCodeEditById(
  workspacePath: string,
  id: number,
): CodeEditRecord | null {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const row = db
      .prepare(`SELECT * FROM code_edits WHERE id = ? LIMIT 1`)
      .get(id) as Readonly<Record<string, unknown>> | undefined;
    return row ? rowToRecord(row) : null;
  });
}
