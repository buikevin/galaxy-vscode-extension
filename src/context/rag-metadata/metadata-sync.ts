/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Synchronization helpers for syntax, semantic, and tool evidence metadata.
 */

import type { SemanticMetadataChunk, SyntaxMetadataRecord, ToolEvidenceMetadata } from '../entities/rag-metadata';
import { withRagMetadataDatabase } from './database';
import { tokenizeQuery } from './helpers';

/**
 * Replaces syntax metadata tables with the latest workspace snapshot.
 */
export function syncSyntaxMetadata(
  workspacePath: string,
  records: readonly SyntaxMetadataRecord[],
): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    const now = Date.now();
    const filePaths = records.map((record) => record.relativePath);
    const deleteFiles = db.prepare(
      filePaths.length > 0
        ? `DELETE FROM syntax_files WHERE relative_path NOT IN (${filePaths.map(() => '?').join(',')})`
        : 'DELETE FROM syntax_files',
    );
    const deleteSymbols = db.prepare(
      filePaths.length > 0
        ? `DELETE FROM syntax_symbols WHERE relative_path NOT IN (${filePaths.map(() => '?').join(',')})`
        : 'DELETE FROM syntax_symbols',
    );
    if (filePaths.length > 0) {
      deleteFiles.run(...filePaths);
      deleteSymbols.run(...filePaths);
    } else {
      deleteFiles.run();
      deleteSymbols.run();
    }

    const upsertFile = db.prepare(`
      INSERT INTO syntax_files (relative_path, language, mtime_ms, import_count, export_count, symbol_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relative_path) DO UPDATE SET
        language = excluded.language,
        mtime_ms = excluded.mtime_ms,
        import_count = excluded.import_count,
        export_count = excluded.export_count,
        symbol_count = excluded.symbol_count,
        updated_at = excluded.updated_at
    `);
    const deleteFileSymbols = db.prepare('DELETE FROM syntax_symbols WHERE relative_path = ?');
    const insertSymbol = db.prepare(`
      INSERT INTO syntax_symbols (relative_path, name, name_lower, kind, exported, line, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    records.forEach((record) => {
      upsertFile.run(
        record.relativePath,
        record.language,
        record.mtimeMs,
        record.imports.length,
        record.exports.length,
        record.symbols.length,
        now,
      );
      deleteFileSymbols.run(record.relativePath);
      record.symbols.forEach((symbol) => {
        insertSymbol.run(
          record.relativePath,
          symbol.name,
          symbol.name.toLowerCase(),
          symbol.kind,
          symbol.exported ? 1 : 0,
          symbol.line,
          symbol.signature,
        );
      });
    });
  });
}

/**
 * Replaces semantic chunk metadata rows with the latest semantic index snapshot.
 */
export function syncSemanticMetadata(
  workspacePath: string,
  chunks: readonly SemanticMetadataChunk[],
): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    const chunkIds = chunks.map((chunk) => chunk.id);
    const deleteStmt = db.prepare(
      chunkIds.length > 0
        ? `DELETE FROM semantic_chunks WHERE id NOT IN (${chunkIds.map(() => '?').join(',')})`
        : 'DELETE FROM semantic_chunks',
    );
    if (chunkIds.length > 0) {
      deleteStmt.run(...chunkIds);
    } else {
      deleteStmt.run();
    }

    const upsertChunk = db.prepare(`
      INSERT INTO semantic_chunks (
        id, file_path, kind, title, title_lower, symbol_name, symbol_name_lower,
        exported, start_line, end_line, description, description_source, mtime_ms, embedding_model, indexed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        kind = excluded.kind,
        title = excluded.title,
        title_lower = excluded.title_lower,
        symbol_name = excluded.symbol_name,
        symbol_name_lower = excluded.symbol_name_lower,
        exported = excluded.exported,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        description = excluded.description,
        description_source = excluded.description_source,
        mtime_ms = excluded.mtime_ms,
        embedding_model = excluded.embedding_model,
        indexed_at = excluded.indexed_at
    `);

    chunks.forEach((chunk) => {
      upsertChunk.run(
        chunk.id,
        chunk.filePath,
        chunk.kind,
        chunk.title,
        chunk.title.toLowerCase(),
        chunk.symbolName ?? null,
        chunk.symbolName?.toLowerCase() ?? null,
        chunk.exported ? 1 : 0,
        chunk.startLine ?? null,
        chunk.endLine ?? null,
        chunk.description ?? null,
        chunk.descriptionSource ?? null,
        chunk.mtimeMs,
        chunk.embeddingModel ?? null,
        chunk.indexedAt,
      );
    });
  });
}

/**
 * Upserts structured metadata for one tool evidence item.
 */
export function appendToolEvidenceMetadata(workspacePath: string, evidence: ToolEvidenceMetadata): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    db.prepare(`
      INSERT INTO tool_evidence_meta (evidence_id, tool_name, success, stale, captured_at, summary, target_path, turn_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        tool_name = excluded.tool_name,
        success = excluded.success,
        stale = excluded.stale,
        captured_at = excluded.captured_at,
        summary = excluded.summary,
        target_path = excluded.target_path,
        turn_id = excluded.turn_id
    `).run(
      evidence.evidenceId,
      evidence.toolName,
      evidence.success ? 1 : 0,
      evidence.stale ? 1 : 0,
      evidence.capturedAt,
      evidence.summary,
      evidence.targetPath ?? null,
      evidence.turnId,
    );
  });
}

/**
 * Clears all cached tool evidence metadata for the workspace.
 */
export function clearToolEvidenceMetadata(workspacePath: string): void {
  withRagMetadataDatabase(workspacePath, (db) => {
    db.exec(`DELETE FROM tool_evidence_meta;`);
  });
}

/**
 * Queries file-path hints from SQLite metadata using lightweight lexical ranking.
 */
export function queryRagHintPaths(
  workspacePath: string,
  queryText: string,
  limit = 6,
): readonly string[] {
  const tokens = tokenizeQuery(queryText);
  if (tokens.length === 0) {
    return Object.freeze([]);
  }

  return withRagMetadataDatabase(workspacePath, (db) => {
    const scores = new Map<string, number>();
    const bump = (filePath: string, amount: number): void => {
      scores.set(filePath, (scores.get(filePath) ?? 0) + amount);
    };

    const symbolStmt = db.prepare(`
      SELECT relative_path, name_lower, exported
      FROM syntax_symbols
      WHERE name_lower LIKE ?
      LIMIT 24
    `);
    const fileStmt = db.prepare(`
      SELECT relative_path
      FROM syntax_files
      WHERE lower(relative_path) LIKE ?
      LIMIT 24
    `);
    const chunkStmt = db.prepare(`
      SELECT file_path, title_lower, symbol_name_lower
      FROM semantic_chunks
      WHERE title_lower LIKE ? OR symbol_name_lower LIKE ?
      LIMIT 24
    `);
    const evidenceStmt = db.prepare(`
      SELECT target_path, tool_name, summary, captured_at
      FROM tool_evidence_meta
      WHERE success = 1
        AND stale = 0
        AND target_path IS NOT NULL
        AND (lower(target_path) LIKE ? OR lower(summary) LIKE ?)
      ORDER BY captured_at DESC
      LIMIT 24
    `);

    tokens.forEach((token) => {
      const like = `%${token}%`;
      for (const row of symbolStmt.all(like) as Array<{ relative_path: string; name_lower: string; exported: number }>) {
        bump(row.relative_path, row.name_lower === token ? 10 : row.exported ? 7 : 5);
      }
      for (const row of fileStmt.all(like) as Array<{ relative_path: string }>) {
        bump(row.relative_path, 4);
      }
      for (const row of chunkStmt.all(like, like) as Array<{ file_path: string; title_lower: string; symbol_name_lower: string | null }>) {
        const exactSymbol = row.symbol_name_lower === token;
        const exactTitle = row.title_lower === token;
        bump(row.file_path, exactSymbol ? 8 : exactTitle ? 6 : 3);
      }
      for (const row of evidenceStmt.all(like, like) as Array<{ target_path: string; tool_name: string; summary: string; captured_at: number }>) {
        const ageMs = Date.now() - row.captured_at;
        const recencyBoost = ageMs <= 5 * 60_000
          ? 10
          : ageMs <= 60 * 60_000
            ? 7
            : ageMs <= 24 * 60 * 60_000
              ? 4
              : 2;
        const pathLower = row.target_path.toLowerCase();
        const summaryLower = row.summary.toLowerCase();
        const exactPath = pathLower.endsWith(`/${token}`) || pathLower.endsWith(`\\${token}`) || pathLower === token;
        const summaryHit = summaryLower.includes(token);
        const toolBoost = row.tool_name === 'read_file' || row.tool_name === 'edit_file' || row.tool_name === 'edit_file_range' || row.tool_name === 'write_file'
          ? 2
          : 0;
        bump(row.target_path, recencyBoost + (exactPath ? 4 : summaryHit ? 2 : 0) + toolBoost);
      }
    });

    return Object.freeze(
      [...scores.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([filePath]) => filePath),
    );
  });
}
