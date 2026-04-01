/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-04-01
 * @desc Selection and ranking helpers for syntax-aware prompt context.
 */

import type {
  SyntaxFileRecord,
} from '../entities/syntax-index';
import { MAX_CONTEXT_FILES, MAX_FOCUS_SYMBOLS, MAX_RELATED_CONTEXT_FILES } from './constants';
import { addUniqueSymbolName, extractQueryIdentifiers } from './helpers';
import {
  buildDefinitionSymbolCandidates,
  buildManualReadPlan,
  buildPrimarySymbolCandidates,
  buildReferenceSymbolCandidates,
} from './selection-candidates';
import {
  buildRecordReferenceMap,
  buildSymbolLookup,
  rankPrimaryPaths,
} from './selection-helpers';

/**
 * Builds the ordered file-path selection for syntax context.
 */
export function buildContextPaths(
  candidateFiles: readonly string[],
  indexedFiles: Readonly<Record<string, SyntaxFileRecord>>,
  queryText: string,
): Readonly<{
  primaryPaths: readonly string[];
  selectedPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
}> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const primaryPaths: string[] = [];
  const definitionPaths: string[] = [];
  const referencePaths: string[] = [];
  const referenceMap = buildRecordReferenceMap(indexedFiles);
  const rankedPrimaryPaths = rankPrimaryPaths({ candidateFiles, indexedFiles, queryText });

  function pushUnique(target: string[], value: string): void {
    if (!target.includes(value)) {
      target.push(value);
    }
  }

  for (const candidate of rankedPrimaryPaths) {
    const record = indexedFiles[candidate];
    if (!record || seen.has(candidate)) {
      continue;
    }
    pushUnique(primaryPaths, candidate);
    seen.add(candidate);
    ordered.push(candidate);
    const references = (referenceMap.get(candidate) ?? []).slice(0, MAX_RELATED_CONTEXT_FILES);

    record.resolvedImports.slice(0, MAX_RELATED_CONTEXT_FILES).forEach((related) => pushUnique(definitionPaths, related));
    references.forEach((related) => pushUnique(referencePaths, related));

    for (const related of record.resolvedImports.slice(0, MAX_RELATED_CONTEXT_FILES)) {
      if (seen.has(related) || !(related in indexedFiles)) {
        continue;
      }
      seen.add(related);
      ordered.push(related);
      if (ordered.length >= MAX_CONTEXT_FILES) {
        return Object.freeze({
          primaryPaths: Object.freeze(primaryPaths),
          selectedPaths: Object.freeze(ordered),
          definitionPaths: Object.freeze(definitionPaths),
          referencePaths: Object.freeze(referencePaths),
        });
      }
    }
    for (const related of references) {
      if (seen.has(related) || !(related in indexedFiles)) {
        continue;
      }
      seen.add(related);
      ordered.push(related);
      if (ordered.length >= MAX_CONTEXT_FILES) {
        return Object.freeze({
          primaryPaths: Object.freeze(primaryPaths),
          selectedPaths: Object.freeze(ordered),
          definitionPaths: Object.freeze(definitionPaths),
          referencePaths: Object.freeze(referencePaths),
        });
      }
    }
    if (ordered.length >= MAX_CONTEXT_FILES) {
      break;
    }
  }

  return Object.freeze({
    primaryPaths: Object.freeze(primaryPaths),
    selectedPaths: Object.freeze(ordered),
    definitionPaths: Object.freeze(definitionPaths),
    referencePaths: Object.freeze(referencePaths),
  });
}

/**
 * Resolves the most relevant focus symbols for a query.
 */
export function resolveFocusSymbols(
  queryText: string,
  primaryRecords: readonly SyntaxFileRecord[],
  selectedRecords: readonly SyntaxFileRecord[],
): readonly string[] {
  const lookup = buildSymbolLookup(selectedRecords);
  const focusSymbols: string[] = [];
  const queryIdentifiers = extractQueryIdentifiers(queryText);

  queryIdentifiers.forEach((identifier) => {
    const exactMatch = lookup.exact.get(identifier);
    if (exactMatch) {
      addUniqueSymbolName(focusSymbols, exactMatch);
      return;
    }
    const caseInsensitiveMatch = lookup.insensitive.get(identifier.toLowerCase());
    if (caseInsensitiveMatch) {
      addUniqueSymbolName(focusSymbols, caseInsensitiveMatch);
    }
  });

  if (focusSymbols.length > 0) {
    return Object.freeze(focusSymbols.slice(0, MAX_FOCUS_SYMBOLS));
  }
  if (queryIdentifiers.length > 0) {
    return Object.freeze([]);
  }

  primaryRecords.forEach((record) => {
    record.symbols.filter((symbol) => symbol.exported).slice(0, 2).forEach((symbol) => addUniqueSymbolName(focusSymbols, symbol.name));
    if (focusSymbols.length >= MAX_FOCUS_SYMBOLS) {
      return;
    }
    record.symbols.slice(0, 2).forEach((symbol) => addUniqueSymbolName(focusSymbols, symbol.name));
  });

  return Object.freeze(focusSymbols.slice(0, MAX_FOCUS_SYMBOLS));
}

export {
  buildDefinitionSymbolCandidates,
  buildManualReadPlan,
  buildPrimarySymbolCandidates,
  buildReferenceSymbolCandidates,
};
