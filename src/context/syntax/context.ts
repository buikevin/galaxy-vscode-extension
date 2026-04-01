/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Top-level syntax context orchestration.
 */

import path from 'node:path';
import type { SyntaxFileRecord, SyntaxIndexContext } from '../entities/syntax-index';
import { createEmptySyntaxContext, formatRecord } from './helpers';
import {
  buildDefinitionSymbolCandidates,
  buildManualReadPlan,
  buildPrimarySymbolCandidates,
  buildReferenceSymbolCandidates,
  resolveFocusSymbols,
} from './selection';
import { ensureIndexedFiles } from './store';
import { estimateTokens } from '../compaction';

/**
 * Builds the syntax-aware prompt block for a workspace query.
 */
export async function buildSyntaxIndexContext(opts: {
  workspacePath: string;
  candidateFiles: readonly string[];
  queryText?: string;
}): Promise<SyntaxIndexContext> {
  const workspacePath = path.resolve(opts.workspacePath);
  const indexed = await ensureIndexedFiles(workspacePath, opts.candidateFiles, opts.queryText ?? '');
  const records = indexed.records;
  if (records.length === 0) {
    return createEmptySyntaxContext();
  }

  const primaryRecords = indexed.selection.primaryPaths
    .map((relativePath) => indexed.files[relativePath])
    .filter((record): record is SyntaxFileRecord => Boolean(record));
  const focusSymbols = resolveFocusSymbols(opts.queryText ?? '', primaryRecords, records);
  const primarySymbolCandidates = buildPrimarySymbolCandidates(primaryRecords, focusSymbols);
  const definitionSymbolCandidates = buildDefinitionSymbolCandidates(primaryRecords, indexed.files, focusSymbols);
  const referenceSymbolCandidates = buildReferenceSymbolCandidates(primaryRecords, indexed.files, focusSymbols);
  const manualReadPlan = buildManualReadPlan({
    focusSymbols,
    primaryPaths: indexed.selection.primaryPaths,
    definitionPaths: indexed.selection.definitionPaths,
    referencePaths: indexed.selection.referencePaths,
    primarySymbolCandidates,
    definitionSymbolCandidates,
    referenceSymbolCandidates,
  });

  const lines: string[] = ['[SYNTAX INDEX]'];
  if (focusSymbols.length > 0) {
    lines.push(`Focus symbols: ${focusSymbols.join(', ')}`);
    lines.push('');
  }
  records.forEach((record, index) => {
    if (index > 0 || focusSymbols.length > 0) {
      lines.push('');
    }
    const referencePaths = indexed.selection.referencePaths.filter((candidatePath) => {
      const candidateRecord = records.find((item) => item.relativePath === candidatePath);
      return Boolean(candidateRecord?.resolvedImports.includes(record.relativePath));
    });
    lines.push(...formatRecord({ record, referencePaths, focusSymbols }));
  });

  const content = lines.join('\n').trim();
  const priorityPaths = Object.freeze(
    [...new Set([
      ...indexed.selection.selectedPaths,
      ...primarySymbolCandidates.map((candidate) => candidate.filePath),
      ...definitionSymbolCandidates.map((candidate) => candidate.filePath),
      ...referenceSymbolCandidates.map((candidate) => candidate.filePath),
      ...indexed.selection.definitionPaths,
      ...indexed.selection.referencePaths,
    ])],
  );

  return Object.freeze({
    content,
    tokens: estimateTokens(content),
    entryCount: records.length,
    records: Object.freeze(
      records.map((record) =>
        Object.freeze({
          relativePath: record.relativePath,
          exports: record.exports,
          imports: record.imports,
          resolvedImports: record.resolvedImports,
          symbols: record.symbols,
        }),
      ),
    ),
    primaryPaths: indexed.selection.primaryPaths,
    definitionPaths: indexed.selection.definitionPaths,
    referencePaths: indexed.selection.referencePaths,
    priorityPaths,
    focusSymbols,
    primarySymbolCandidates,
    definitionSymbolCandidates,
    referenceSymbolCandidates,
    manualReadPlan,
  });
}
