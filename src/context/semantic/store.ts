/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Persistent semantic store read/write helpers.
 */

import fs from 'node:fs';
import { ensureProjectStorage, getProjectStorageInfo } from '../project-store';
import { syncSemanticMetadata } from '../rag-metadata/metadata-sync';
import type { SemanticIndexStore } from '../entities/semantic-index';
import { SEMANTIC_INDEX_VERSION } from './constants';
import { createEmptyStore } from './helpers';

/**
 * Loads the semantic store snapshot for a workspace.
 */
export function loadStore(workspacePath: string): SemanticIndexStore {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  if (!fs.existsSync(storage.semanticIndexPath)) {
    return createEmptyStore(workspacePath);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(storage.semanticIndexPath, 'utf-8')) as SemanticIndexStore;
    if (raw.version !== SEMANTIC_INDEX_VERSION || raw.workspacePath !== workspacePath) {
      return createEmptyStore(workspacePath);
    }
    return raw;
  } catch {
    return createEmptyStore(workspacePath);
  }
}

/**
 * Persists the semantic store snapshot and mirrors chunk metadata into SQLite.
 */
export function saveStore(workspacePath: string, store: SemanticIndexStore): void {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  fs.writeFileSync(storage.semanticIndexPath, JSON.stringify(store, null, 2), 'utf-8');
  syncSemanticMetadata(
    workspacePath,
    Object.values(store.chunks).map((chunk) =>
      Object.freeze({
        id: chunk.id,
        filePath: chunk.filePath,
        title: chunk.title,
        kind: chunk.kind,
        ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
        ...(typeof chunk.exported === 'boolean' ? { exported: chunk.exported } : {}),
        ...(typeof chunk.startLine === 'number' ? { startLine: chunk.startLine } : {}),
        ...(typeof chunk.endLine === 'number' ? { endLine: chunk.endLine } : {}),
        ...(chunk.description ? { description: chunk.description } : {}),
        ...(chunk.descriptionSource ? { descriptionSource: chunk.descriptionSource } : {}),
        mtimeMs: chunk.mtimeMs,
        ...(chunk.embeddingModel ? { embeddingModel: chunk.embeddingModel } : {}),
        indexedAt: chunk.indexedAt,
      }),
    ),
  );
}
