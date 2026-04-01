/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-04-01
 * @desc TypeScript-centric parsing helpers used by the syntax index.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import type {
  SyntaxFileRecord,
  SyntaxImportBindingRecord,
  SyntaxResolvedImportRecord,
} from '../entities/syntax-index';
import type { TypeScriptProjectConfig } from '../entities/syntax-typescript';
import { parseTreeSitterSourceFile } from '../tree-sitter-parser';
import { MAX_FILE_BYTES, MAX_IMPORTS_PER_FILE } from './constants';
import { isSupportedSourceFile, resolveWorkspaceRelativePath } from './helpers';
import {
  collectExports,
  collectImportBindings,
  collectSymbols,
  getScriptKind,
  inferLanguage,
} from './typescript-parser-helpers';

/**
 * Loads the project tsconfig used for import resolution.
 */
export function loadTypeScriptProjectConfig(workspacePath: string): TypeScriptProjectConfig {
  const fallbackOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const configPath = ts.findConfigFile(workspacePath, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    return Object.freeze({ options: fallbackOptions });
  }
  try {
    const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
    if (rawConfig.error) {
      return Object.freeze({ options: fallbackOptions });
    }
    const parsed = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, path.dirname(configPath));
    return Object.freeze({
      options: {
        ...fallbackOptions,
        ...parsed.options,
        allowJs: parsed.options.allowJs ?? true,
      },
    });
  } catch {
    return Object.freeze({ options: fallbackOptions });
  }
}

/**
 * Resolves import entries to workspace files with the TypeScript compiler.
 */
function resolveImportRecordsWithCompiler(
  workspacePath: string,
  containingFile: string,
  importEntries: readonly Readonly<{ specifier: string; line: number; bindings: readonly SyntaxImportBindingRecord[] }>[],
  projectConfig: TypeScriptProjectConfig,
): readonly SyntaxResolvedImportRecord[] {
  const resolved = new Map<string, SyntaxResolvedImportRecord>();
  for (const importEntry of importEntries) {
    const result = ts.resolveModuleName(importEntry.specifier, containingFile, projectConfig.options, ts.sys);
    const resolvedFile = result.resolvedModule?.resolvedFileName;
    if (!resolvedFile) {
      continue;
    }
    const relativePath = resolveWorkspaceRelativePath(workspacePath, resolvedFile);
    if (!relativePath || !isSupportedSourceFile(relativePath)) {
      continue;
    }
    const existing = resolved.get(relativePath);
    if (!existing) {
      resolved.set(relativePath, Object.freeze({
        specifier: importEntry.specifier,
        relativePath,
        line: importEntry.line,
        bindings: Object.freeze([...importEntry.bindings]),
      }));
      continue;
    }
    const mergedBindings = Object.freeze(
      [...new Map(
        [...existing.bindings, ...importEntry.bindings].map((binding) => [
          `${binding.importedName}:${binding.localName}:${binding.line}:${binding.typeOnly}`,
          binding,
        ]),
      ).values()],
    );
    resolved.set(relativePath, Object.freeze({ ...existing, bindings: mergedBindings }));
  }
  return Object.freeze([...resolved.values()].slice(0, MAX_IMPORTS_PER_FILE));
}

/**
 * Parses one source file into a syntax file record.
 */
export async function parseSourceFile(
  workspacePath: string,
  relativePath: string,
  projectConfig: TypeScriptProjectConfig,
): Promise<SyntaxFileRecord | null> {
  const absolutePath = path.join(workspacePath, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    return null;
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  if (relativePath.endsWith('.py') || relativePath.endsWith('.go') || relativePath.endsWith('.rs') || relativePath.endsWith('.java')) {
    return await parseTreeSitterSourceFile({
      relativePath,
      content,
      mtimeMs: stat.mtimeMs,
    });
  }

  const sourceFile = ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true, getScriptKind(relativePath));
  const importEntries = collectImportBindings(sourceFile);
  const resolvedImportRecords = resolveImportRecordsWithCompiler(workspacePath, absolutePath, importEntries, projectConfig);

  return Object.freeze({
    relativePath,
    language: inferLanguage(relativePath),
    mtimeMs: stat.mtimeMs,
    imports: Object.freeze(importEntries.map((entry) => entry.specifier)),
    resolvedImports: Object.freeze(resolvedImportRecords.map((entry) => entry.relativePath)),
    resolvedImportRecords,
    exports: collectExports(sourceFile),
    symbols: collectSymbols(sourceFile),
    indexedAt: Date.now(),
  });
}
