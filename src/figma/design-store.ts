/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Persist imported Figma payloads, expose attachment metadata, and build prompt-ready context blocks for attached designs.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureProjectStorage, getProjectStorageInfo } from '../context/project-store';
import { FIGMA_CLIPBOARD_PREFIX, FIGMA_CLIPBOARD_SUFFIX } from '../shared/constants';
import type { FigmaDesignDocument, FigmaDesignNode, FigmaImportRecord, FigmaImportRequest } from '../shared/figma';
import type { FigmaAttachment } from '../shared/protocol';
import { buildFigmaAttachmentFromRecord } from './prompt';
import { buildAttachedFigmaContextSection } from './serialization';

/**
 * Counts the total number of nodes in a Figma tree.
 *
 * @param nodes Top-level or child node list.
 * @returns Total recursive node count.
 */
function countNodes(nodes: readonly FigmaDesignNode[] | undefined): number {
  if (!nodes || nodes.length === 0) {
    return 0;
  }

  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

/**
 * Summarizes one imported Figma document for quick transcript and storage metadata.
 *
 * @param document Imported Figma document payload.
 * @returns Short summary string.
 */
function summarizeDocument(document: FigmaDesignDocument): string {
  const selectionCount = document.selection.length;
  const nodeCount = countNodes(document.selection);
  const firstSelection = document.selection[0];
  const firstLabel = firstSelection ? `${firstSelection.name} (${firstSelection.type})` : 'empty selection';
  return `Imported Figma selection ${firstLabel} with ${selectionCount} top-level node${selectionCount === 1 ? '' : 's'} and ${nodeCount} total node${nodeCount === 1 ? '' : 's'}.`;
}

/**
 * Parses one persisted JSONL record line into a Figma import record.
 *
 * @param line Raw JSONL line from storage.
 * @returns Parsed record or `null` when the line is invalid.
 */
function parseRecord(line: string): FigmaImportRecord | null {
  try {
    return JSON.parse(line) as FigmaImportRecord;
  } catch {
    return null;
  }
}

/**
 * Persists one imported Figma payload into the current workspace store.
 *
 * @param workspacePath Workspace root whose storage should receive the import.
 * @param payload Figma import request received from the plugin bridge.
 * @returns Persisted import record.
 */
export function appendFigmaImport(workspacePath: string, payload: FigmaImportRequest): FigmaImportRecord {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);

  const record: FigmaImportRecord = Object.freeze({
    importId: `figma-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId: storage.workspaceId,
    importedAt: Date.now(),
    source: payload.source,
    ...(payload.workspaceHint ? { workspaceHint: payload.workspaceHint } : {}),
    summary: summarizeDocument(payload.document),
    document: payload.document,
  });

  fs.appendFileSync(storage.figmaImportsPath, `${JSON.stringify(record)}\n`, 'utf-8');
  return record;
}

/**
 * Loads recent Figma imports from workspace storage.
 *
 * @param workspacePath Workspace root whose storage should be queried.
 * @param limit Maximum number of recent records to load.
 * @returns Recent persisted import records.
 */
export function loadRecentFigmaImports(workspacePath: string, limit = 10): readonly FigmaImportRecord[] {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  if (!fs.existsSync(storage.figmaImportsPath)) {
    return Object.freeze([]);
  }

  try {
    const lines = fs.readFileSync(storage.figmaImportsPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    return Object.freeze(
      lines
        .slice(-Math.max(1, limit))
        .map(parseRecord)
        .filter((item): item is FigmaImportRecord => item !== null),
    );
  } catch {
    return Object.freeze([]);
  }
}

/**
 * Finds one persisted Figma import by id, or returns the latest import when no id is provided.
 *
 * @param workspacePath Workspace root whose storage should be queried.
 * @param importId Optional import id to resolve.
 * @returns Matching Figma import record or `null` when not found.
 */
export function findFigmaImport(workspacePath: string, importId?: string): FigmaImportRecord | null {
  const recent = loadRecentFigmaImports(workspacePath, 100);
  if (recent.length === 0) {
    return null;
  }

  if (!importId) {
    return recent[recent.length - 1] ?? null;
  }

  return recent.find((record) => record.importId === importId) ?? null;
}

/**
 * Formats a persisted Figma record into a compact user-facing summary block.
 *
 * @param record Persisted import record.
 * @returns Multiline summary string.
 */
export function formatFigmaImportSummary(record: FigmaImportRecord): string {
  const firstSelection = record.document.selection[0];
  const selectionLabel = firstSelection ? `${firstSelection.name} (${firstSelection.type})` : 'empty selection';
  const assetCount = record.document.assets?.length ?? 0;
  return [
    `Import ID: ${record.importId}`,
    `Imported at: ${new Date(record.importedAt).toISOString()}`,
    `Selection root: ${selectionLabel}`,
    `Top-level nodes: ${record.document.selection.length}`,
    `Assets: ${assetCount}`,
    record.summary,
  ].join('\n');
}

/**
 * Builds the clipboard token used to embed a Figma import id into pasted content.
 *
 * @param importId Persisted Figma import id.
 * @returns Clipboard token string.
 */
export function buildFigmaClipboardToken(importId: string): string {
  return `${FIGMA_CLIPBOARD_PREFIX}${importId}${FIGMA_CLIPBOARD_SUFFIX}`;
}

/**
 * Parses all Figma import ids embedded in a text blob.
 *
 * @param text Clipboard or editor text that may contain import tokens.
 * @returns Unique import ids discovered in the text.
 */
export function parseFigmaClipboardImportIds(text: string): readonly string[] {
  const matches = text.match(/\[\[galaxy-code:figma-import:([A-Za-z0-9-]+)\]\]/g) ?? [];
  const ids = matches
    .map((match) => match.slice(FIGMA_CLIPBOARD_PREFIX.length, match.length - FIGMA_CLIPBOARD_SUFFIX.length))
    .filter(Boolean);
  return Object.freeze([...new Set(ids)]);
}
/**
 * Builds one transcript attachment payload for a previously imported Figma design.
 *
 * @param workspacePath Workspace root whose storage should be queried.
 * @param importId Import id to attach.
 * @returns Transcript attachment metadata or `null` when the import no longer exists.
 */
export function buildFigmaAttachment(workspacePath: string, importId: string): FigmaAttachment | null {
  const record = findFigmaImport(workspacePath, importId);
  if (!record) {
    return null;
  }

  return buildFigmaAttachmentFromRecord(record);
}

/**
 * Builds the prompt block for one or more attached Figma imports.
 *
 * @param workspacePath Workspace root whose storage should be queried.
 * @param importIds Import ids attached to the current turn.
 * @returns Prompt-ready attached-design context block.
 */
export function buildAttachedFigmaContextNote(workspacePath: string, importIds: readonly string[]): string {
  const sections = importIds
    .map((importId) => findFigmaImport(workspacePath, importId))
    .filter((record): record is FigmaImportRecord => record !== null)
    .map((record) => buildAttachedFigmaContextSection(record));

  return sections.length > 0 ? `Attached Figma designs:\n${sections.join('\n\n')}` : '';
}
