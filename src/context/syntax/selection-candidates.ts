/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Candidate and manual-read-plan builders used by syntax context selection.
 */

import type {
  ManualReadPlanStep,
  SyntaxFileRecord,
  SyntaxSymbolCandidate,
} from '../entities/syntax-index';
import { MAX_SYMBOL_CANDIDATES } from './constants';
import { findSymbolInRecord } from './selection-helpers';

/**
 * Builds primary symbol candidates from primary records and focus symbols.
 */
export function buildPrimarySymbolCandidates(
  primaryRecords: readonly SyntaxFileRecord[],
  focusSymbols: readonly string[],
): readonly SyntaxSymbolCandidate[] {
  const focusSet = new Set(focusSymbols);
  const candidates: SyntaxSymbolCandidate[] = [];

  primaryRecords.forEach((record) => {
    const matched = focusSet.size > 0
      ? record.symbols.filter((symbol) => focusSet.has(symbol.name))
      : record.symbols.filter((symbol) => symbol.exported).slice(0, 2);
    const fallback = matched.length > 0 ? matched : record.symbols.slice(0, 2);
    fallback.forEach((symbol) => {
      candidates.push(Object.freeze({
        relation: 'primary',
        symbolName: symbol.name,
        filePath: record.relativePath,
        line: symbol.line,
        description: `${symbol.signature} @ ${record.relativePath}:${symbol.line}`,
      }));
    });
  });

  return Object.freeze(
    [...new Map(candidates.map((candidate) => [`${candidate.filePath}:${candidate.symbolName}:${candidate.line ?? 0}`, candidate])).values()]
      .sort((a, b) => {
        const aFocus = focusSymbols.includes(a.symbolName) ? 1 : 0;
        const bFocus = focusSymbols.includes(b.symbolName) ? 1 : 0;
        return bFocus - aFocus || a.filePath.localeCompare(b.filePath) || (a.line ?? 0) - (b.line ?? 0);
      })
      .slice(0, MAX_SYMBOL_CANDIDATES),
  );
}

/**
 * Builds definition candidates by following resolved imports from primary files.
 */
export function buildDefinitionSymbolCandidates(
  primaryRecords: readonly SyntaxFileRecord[],
  indexedFiles: Readonly<Record<string, SyntaxFileRecord>>,
  focusSymbols: readonly string[],
): readonly SyntaxSymbolCandidate[] {
  const focusSet = new Set(focusSymbols);
  const candidates: SyntaxSymbolCandidate[] = [];

  primaryRecords.forEach((record) => {
    record.resolvedImportRecords.forEach((importRecord) => {
      const targetRecord = indexedFiles[importRecord.relativePath];
      if (!targetRecord) {
        return;
      }
      importRecord.bindings.forEach((binding) => {
        const matchesFocus = focusSet.size === 0 || focusSet.has(binding.localName) || focusSet.has(binding.importedName);
        if (!matchesFocus) {
          return;
        }
        const targetSymbol = findSymbolInRecord(targetRecord, [binding.importedName, binding.localName]);
        if (!targetSymbol) {
          return;
        }
        candidates.push(Object.freeze({
          relation: 'definition',
          symbolName: targetSymbol.name,
          filePath: targetRecord.relativePath,
          line: targetSymbol.line,
          description:
            `${targetSymbol.signature} @ ${targetRecord.relativePath}:${targetSymbol.line}` +
            ` imported by ${record.relativePath}` +
            (binding.localName !== targetSymbol.name ? ` as ${binding.localName}` : ''),
        }));
      });
    });
  });

  return Object.freeze(
    [...new Map(candidates.map((candidate) => [`${candidate.filePath}:${candidate.symbolName}:${candidate.line ?? 0}`, candidate])).values()]
      .sort((a, b) => {
        const aFocus = focusSymbols.includes(a.symbolName) ? 1 : 0;
        const bFocus = focusSymbols.includes(b.symbolName) ? 1 : 0;
        return bFocus - aFocus || a.filePath.localeCompare(b.filePath) || (a.line ?? 0) - (b.line ?? 0);
      })
      .slice(0, MAX_SYMBOL_CANDIDATES),
  );
}

/**
 * Builds reference candidates by finding files that import primary symbols.
 */
export function buildReferenceSymbolCandidates(
  primaryRecords: readonly SyntaxFileRecord[],
  indexedFiles: Readonly<Record<string, SyntaxFileRecord>>,
  focusSymbols: readonly string[],
): readonly SyntaxSymbolCandidate[] {
  const primaryPathSet = new Set(primaryRecords.map((record) => record.relativePath));
  const primarySymbolNames = new Set(
    primaryRecords.flatMap((record) =>
      record.symbols.filter((symbol) => symbol.exported || focusSymbols.includes(symbol.name)).map((symbol) => symbol.name),
    ),
  );
  const focusSet = new Set(focusSymbols);
  const candidates: SyntaxSymbolCandidate[] = [];

  Object.values(indexedFiles).forEach((record) => {
    if (primaryPathSet.has(record.relativePath)) {
      return;
    }
    record.resolvedImportRecords.forEach((importRecord) => {
      if (!primaryPathSet.has(importRecord.relativePath)) {
        return;
      }
      const targetRecord = indexedFiles[importRecord.relativePath];
      if (!targetRecord) {
        return;
      }
      importRecord.bindings.forEach((binding) => {
        const targetSymbol = findSymbolInRecord(targetRecord, [binding.importedName, binding.localName]);
        const symbolName = targetSymbol?.name ?? binding.importedName;
        const matchesFocus =
          focusSet.size === 0
            ? primarySymbolNames.has(symbolName) || primarySymbolNames.has(binding.localName)
            : focusSet.has(symbolName) || focusSet.has(binding.localName);
        if (!matchesFocus) {
          return;
        }
        candidates.push(Object.freeze({
          relation: 'reference',
          symbolName,
          filePath: record.relativePath,
          line: importRecord.line,
          description:
            `${record.relativePath}:${importRecord.line} imports ${binding.localName}` +
            ` from ${targetRecord.relativePath}` +
            (targetSymbol && binding.localName !== targetSymbol.name ? ` (export ${targetSymbol.name})` : ''),
        }));
      });
    });
  });

  return Object.freeze(
    [...new Map(candidates.map((candidate) => [`${candidate.filePath}:${candidate.symbolName}:${candidate.line ?? 0}`, candidate])).values()]
      .slice(0, MAX_SYMBOL_CANDIDATES),
  );
}

/**
 * Builds a targeted manual read plan from syntax candidates.
 */
export function buildManualReadPlan(opts: {
  focusSymbols: readonly string[];
  primaryPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
  primarySymbolCandidates: readonly SyntaxSymbolCandidate[];
  definitionSymbolCandidates: readonly SyntaxSymbolCandidate[];
  referenceSymbolCandidates: readonly SyntaxSymbolCandidate[];
}): readonly ManualReadPlanStep[] {
  const steps: ManualReadPlanStep[] = [];

  function pushStep(step: ManualReadPlanStep): void {
    const key = `${step.tool}:${step.targetPath}:${step.symbolName ?? ''}:${step.line ?? 0}:${step.pattern ?? ''}`;
    if (steps.some((existing) => `${existing.tool}:${existing.targetPath}:${existing.symbolName ?? ''}:${existing.line ?? 0}:${existing.pattern ?? ''}` === key)) {
      return;
    }
    steps.push(step);
  }

  if (opts.focusSymbols.length === 0) {
    return Object.freeze([]);
  }

  opts.primarySymbolCandidates.slice(0, 2).forEach((candidate) => {
    pushStep(Object.freeze({
      tool: 'read_file',
      targetPath: candidate.filePath,
      symbolName: candidate.symbolName,
      ...(typeof candidate.line === 'number' ? { line: candidate.line } : {}),
      reason: `Inspect primary symbol ${candidate.symbolName}`,
    }));
  });
  opts.definitionSymbolCandidates.slice(0, 2).forEach((candidate) => {
    pushStep(Object.freeze({
      tool: 'read_file',
      targetPath: candidate.filePath,
      symbolName: candidate.symbolName,
      ...(typeof candidate.line === 'number' ? { line: candidate.line } : {}),
      reason: `Inspect definition candidate ${candidate.symbolName}`,
    }));
  });
  opts.referenceSymbolCandidates.slice(0, 2).forEach((candidate) => {
    pushStep(Object.freeze({
      tool: typeof candidate.line === 'number' ? 'read_file' : 'grep',
      targetPath: candidate.filePath,
      symbolName: candidate.symbolName,
      ...(typeof candidate.line === 'number' ? { line: candidate.line } : {}),
      ...(candidate.symbolName ? { pattern: candidate.symbolName } : {}),
      reason: `Verify downstream usage of ${candidate.symbolName}`,
    }));
  });
  if (opts.focusSymbols.length > 0) {
    const grepPattern = opts.focusSymbols.slice(0, 3).join('|');
    [...new Set([...opts.primaryPaths, ...opts.definitionPaths, ...opts.referencePaths])]
      .slice(0, 3)
      .forEach((targetPath) => {
        pushStep(Object.freeze({
          tool: 'grep',
          targetPath,
          pattern: grepPattern,
          reason: `Search for focus symbols in ${targetPath}`,
        }));
      });
  }
  return Object.freeze(steps.slice(0, 8));
}
