/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Internal helper functions for syntax-aware context path and symbol selection.
 */

import path from 'node:path';
import type { SyntaxFileRecord, SyntaxSymbolRecord } from '../entities/syntax-index';
import { MAX_PRIMARY_CONTEXT_FILES } from './constants';
import { extractQueryIdentifiers } from './helpers';

export function buildRecordReferenceMap(
  indexedFiles: Readonly<Record<string, SyntaxFileRecord>>,
): ReadonlyMap<string, readonly string[]> {
  const references = new Map<string, string[]>();
  Object.values(indexedFiles).forEach((record) => {
    record.resolvedImports.forEach((targetPath) => {
      if (!(targetPath in indexedFiles)) {
        return;
      }
      const current = references.get(targetPath) ?? [];
      if (!current.includes(record.relativePath)) {
        current.push(record.relativePath);
      }
      references.set(targetPath, current);
    });
  });
  return references as ReadonlyMap<string, readonly string[]>;
}

export function scoreRecordForPrimarySelection(opts: {
  record: SyntaxFileRecord;
  queryIdentifiers: readonly string[];
  candidatePath: string;
  candidateIndex: number;
  referenceMap: ReadonlyMap<string, readonly string[]>;
}): number {
  const lowerPath = opts.record.relativePath.toLowerCase();
  const basename = path.basename(opts.record.relativePath).toLowerCase();
  const candidateLower = opts.candidatePath.toLowerCase();
  let score = Math.max(0, 18 - opts.candidateIndex * 3);

  if (opts.record.relativePath === opts.candidatePath) {
    score += 14;
  } else if (lowerPath.includes(candidateLower) || candidateLower.includes(lowerPath)) {
    score += 8;
  }

  opts.queryIdentifiers.forEach((identifier) => {
    if (basename === identifier || basename.startsWith(`${identifier}.`) || basename.includes(`${identifier}.`)) {
      score += 8;
      return;
    }
    if (lowerPath.includes(`/${identifier}/`) || lowerPath.endsWith(`/${identifier}`)) {
      score += 6;
      return;
    }
    if (lowerPath.includes(identifier)) {
      score += 4;
    }
    if (
      opts.record.symbols.some((symbol) => symbol.name.toLowerCase() === identifier) ||
      opts.record.exports.some((item) => item.toLowerCase() === identifier)
    ) {
      score += 7;
      return;
    }
    if (
      opts.record.symbols.some((symbol) => symbol.name.toLowerCase().includes(identifier)) ||
      opts.record.exports.some((item) => item.toLowerCase().includes(identifier)) ||
      opts.record.imports.some((item) => item.toLowerCase().includes(identifier))
    ) {
      score += 3;
    }
  });

  score += Math.min(opts.record.resolvedImports.length, 3);
  score += Math.min((opts.referenceMap.get(opts.record.relativePath) ?? []).length, 3);
  return score;
}

export function rankPrimaryPaths(opts: {
  candidateFiles: readonly string[];
  indexedFiles: Readonly<Record<string, SyntaxFileRecord>>;
  queryText: string;
}): readonly string[] {
  const queryIdentifiers = extractQueryIdentifiers(opts.queryText).map((item) => item.toLowerCase());
  const referenceMap = buildRecordReferenceMap(opts.indexedFiles);
  const ranked = opts.candidateFiles
    .map((candidatePath, index) => {
      const record = opts.indexedFiles[candidatePath];
      if (!record) {
        return null;
      }
      return Object.freeze({
        relativePath: candidatePath,
        score: scoreRecordForPrimarySelection({
          record,
          queryIdentifiers,
          candidatePath,
          candidateIndex: index,
          referenceMap,
        }),
      });
    })
    .filter((entry): entry is Readonly<{ relativePath: string; score: number }> => Boolean(entry))
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

  return Object.freeze(ranked.slice(0, MAX_PRIMARY_CONTEXT_FILES).map((entry) => entry.relativePath));
}

export function buildSymbolLookup(records: readonly SyntaxFileRecord[]): Readonly<{
  exact: Readonly<Map<string, string>>;
  insensitive: Readonly<Map<string, string>>;
}> {
  const exact = new Map<string, string>();
  const insensitive = new Map<string, string>();

  records.forEach((record) => {
    record.symbols.forEach((symbol) => {
      if (!exact.has(symbol.name)) {
        exact.set(symbol.name, symbol.name);
      }
      const lower = symbol.name.toLowerCase();
      if (!insensitive.has(lower)) {
        insensitive.set(lower, symbol.name);
      }
    });
    record.resolvedImportRecords.forEach((importRecord) => {
      importRecord.bindings.forEach((binding) => {
        [binding.localName, binding.importedName]
          .filter((name) => name && name !== 'default' && name !== '*')
          .forEach((name) => {
            if (!exact.has(name)) {
              exact.set(name, name);
            }
            const lower = name.toLowerCase();
            if (!insensitive.has(lower)) {
              insensitive.set(lower, name);
            }
          });
      });
    });
  });

  return Object.freeze({
    exact: exact as Readonly<Map<string, string>>,
    insensitive: insensitive as Readonly<Map<string, string>>,
  });
}

export function findSymbolInRecord(record: SyntaxFileRecord, candidateNames: readonly string[]): SyntaxSymbolRecord | null {
  for (const candidate of candidateNames) {
    const exact = record.symbols.find((symbol) => symbol.name === candidate);
    if (exact) {
      return exact;
    }
  }

  for (const candidate of candidateNames) {
    const lower = candidate.toLowerCase();
    const loose = record.symbols.find((symbol) => symbol.name.toLowerCase() === lower);
    if (loose) {
      return loose;
    }
  }

  return null;
}
