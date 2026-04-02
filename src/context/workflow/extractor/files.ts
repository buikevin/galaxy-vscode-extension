/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc File-system and TypeScript source helpers for workflow extraction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import type { ImportBinding, TypeScriptProjectConfig } from '../entities/extractor';
import {
  IGNORED_SEGMENTS,
  MAX_SCAN_DIRS,
  MAX_SCAN_FILES,
  SUPPORTED_SOURCE_SUFFIXES,
  TYPESCRIPT_SOURCE_SUFFIXES,
} from '../entities/constants';

/**
 * Normalizes a workspace-relative path to forward slashes.
 *
 * @param filePath Relative or absolute file path that may contain platform separators.
 * @returns Slash-normalized path safe for workflow ids and storage keys.
 */
export function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/**
 * Checks whether a path is a supported TS/JS source file.
 *
 * @param relativePath Workspace-relative path to evaluate.
 * @returns True when the path suffix is supported by any workflow adapter.
 */
export function isSupportedSourceFile(relativePath: string): boolean {
  return SUPPORTED_SOURCE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/**
 * Checks whether a path is a source file handled by the TypeScript generic adapter.
 *
 * @param relativePath Workspace-relative path to evaluate.
 * @returns True when the path suffix belongs to the generic TS/JS adapter.
 */
export function isTypeScriptWorkflowSourceFile(relativePath: string): boolean {
  return TYPESCRIPT_SOURCE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/**
 * Resolves an absolute or workspace-relative file path back to a safe workspace-relative path.
 *
 * @param workspacePath Absolute workspace root used as the trust boundary.
 * @param filePath Absolute or workspace-local file path to normalize.
 * @returns Safe workspace-relative path or null when the target escapes the workspace or hits ignored segments.
 */
export function resolveWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
  const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspacePath, filePath);
  const relativePath = path.relative(workspacePath, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return null;
  }
  return normalized;
}

/**
 * Maps file suffixes to TypeScript parser script kinds.
 *
 * @param filePath Source file path whose suffix determines parser mode.
 * @returns TypeScript parser script kind for the given source file.
 */
export function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

/**
 * Checks whether a syntax node has a specific modifier.
 *
 * @param node Syntax node that may expose modifiers.
 * @param kind Modifier kind to look for.
 * @returns True when the modifier exists on the node.
 */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

/**
 * Loads tsconfig options, falling back to permissive JS-aware defaults.
 *
 * @param workspacePath Absolute workspace root whose tsconfig should be loaded.
 * @returns Normalized project config with safe fallback compiler options.
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
 * Returns a 1-based start line number for a node.
 *
 * @param sourceFile Parsed TypeScript source file that owns the node.
 * @param node Syntax node whose start line should be computed.
 * @returns 1-based start line number.
 */
export function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Returns a 1-based end line number for a node.
 *
 * @param sourceFile Parsed TypeScript source file that owns the node.
 * @param node Syntax node whose end line should be computed.
 * @returns 1-based end line number.
 */
export function getNodeEndLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

/**
 * Collects local import bindings and resolves them to workspace-relative target files.
 *
 * @param workspacePath Absolute workspace root used for safe relative resolution.
 * @param absolutePath Absolute source file path containing the imports.
 * @param sourceFile Parsed TypeScript source file to inspect.
 * @param projectConfig Compiler options used during module resolution.
 * @returns Map of local binding names to normalized import bindings.
 */
export function collectImportBindings(
  workspacePath: string,
  absolutePath: string,
  sourceFile: ts.SourceFile,
  projectConfig: TypeScriptProjectConfig,
): ReadonlyMap<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  sourceFile.statements.forEach((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return;
    }
    const specifier = statement.moduleSpecifier.text;
    const resolved = ts.resolveModuleName(specifier, absolutePath, projectConfig.options, ts.sys);
    const resolvedFile = resolved.resolvedModule?.resolvedFileName;
    if (!resolvedFile) {
      return;
    }
    const relativePath = resolveWorkspaceRelativePath(workspacePath, resolvedFile);
    if (!relativePath || !isSupportedSourceFile(relativePath)) {
      return;
    }

    const clause = statement.importClause;
    if (clause?.name) {
      bindings.set(
        clause.name.text,
        Object.freeze({
          localName: clause.name.text,
          importedName: 'default',
          targetFile: relativePath,
        }),
      );
    }

    if (!clause?.namedBindings) {
      return;
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(
        clause.namedBindings.name.text,
        Object.freeze({
          localName: clause.namedBindings.name.text,
          importedName: '*',
          targetFile: relativePath,
        }),
      );
      return;
    }

    clause.namedBindings.elements.forEach((element) => {
      bindings.set(
        element.name.text,
        Object.freeze({
          localName: element.name.text,
          importedName: element.propertyName?.text ?? element.name.text,
          targetFile: relativePath,
        }),
      );
    });
  });

  return bindings;
}

/**
 * Scans a workspace breadth-first for supported source files.
 *
 * @param workspacePath Absolute workspace root to scan.
 * @returns Sorted unique list of workflow-relevant source files.
 */
export function scanWorkspaceSourceFiles(workspacePath: string): readonly string[] {
  return scanWorkspaceSourceFilesBySuffixes(workspacePath, SUPPORTED_SOURCE_SUFFIXES);
}

/**
 * Scans a workspace breadth-first for source files matching the provided suffixes.
 *
 * @param workspacePath Absolute workspace root to scan.
 * @param suffixes File suffixes that should be included in the result set.
 * @returns Sorted unique list of matching workspace-relative file paths.
 */
export function scanWorkspaceSourceFilesBySuffixes(workspacePath: string, suffixes: readonly string[]): readonly string[] {
  const queue = [workspacePath];
  const results: string[] = [];
  let scannedDirs = 0;

  while (queue.length > 0 && scannedDirs < MAX_SCAN_DIRS && results.length < MAX_SCAN_FILES) {
    const currentDir = queue.shift()!;
    scannedDirs += 1;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const directories = entries
      .filter((entry) => entry.isDirectory() && !IGNORED_SEGMENTS.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    directories.slice(0, 12).forEach((entry) => queue.push(path.join(currentDir, entry.name)));

    entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(currentDir, entry.name))
      .forEach((absolutePath) => {
        if (results.length >= MAX_SCAN_FILES) {
          return;
        }
        const relativePath = resolveWorkspaceRelativePath(workspacePath, absolutePath);
        if (relativePath && suffixes.some((suffix) => relativePath.endsWith(suffix))) {
          results.push(relativePath);
        }
      });
  }

  return Object.freeze([...new Set(results)].sort((a, b) => a.localeCompare(b)));
}

/**
 * Creates a stable source hash from relative path and file content.
 *
 * @param relativePath Workspace-relative file path included in the hash seed.
 * @param content Raw file content included in the hash seed.
 * @returns Stable SHA-1 hash used for invalidation and artifact freshness checks.
 */
export function createSourceHash(relativePath: string, content: string): string {
  return createHash('sha1').update(relativePath).update('\n').update(content).digest('hex');
}

/**
 * Extracts a string-like literal value when available.
 *
 * @param node Optional TypeScript expression to inspect.
 * @returns Trimmed literal value or null when the expression is dynamic.
 */
export function maybeGetStringLiteralValue(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.trim() || null;
  }
  if (ts.isTemplateExpression(node) && node.templateSpans.length === 0) {
    return node.head.text.trim() || null;
  }
  return null;
}

/**
 * Sanitizes ids used in synthetic workflow node and edge keys.
 *
 * @param value Raw identifier fragment that may contain unsafe characters.
 * @returns Stable sanitized identifier fragment safe for workflow ids.
 */
export function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9/_:-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'entry';
}
