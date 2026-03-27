import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { estimateTokens } from './compaction';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';
import { syncSyntaxMetadata } from './rag-metadata-store';
import { parseTreeSitterSourceFile } from './tree-sitter-parser';

const SYNTAX_INDEX_VERSION = 3;
const MAX_CONTEXT_FILES = 6;
const MAX_RELATED_CONTEXT_FILES = 3;
const MAX_SYMBOLS_PER_FILE = 8;
const MAX_SYMBOL_CANDIDATES = 8;
const MAX_FOCUS_SYMBOLS = 6;
const MAX_IMPORTS_PER_FILE = 6;
const MAX_EXPORTS_PER_FILE = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SCAN_DIRS = 48;
const MAX_SCAN_FILES = 240;
const MAX_SEED_FILES = 12;
const MAX_PRIMARY_CONTEXT_FILES = 4;
const SUPPORTED_SOURCE_SUFFIXES = ['.d.ts', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java'];
const IGNORED_SEGMENTS = new Set(['.git', '.galaxy', 'node_modules', 'dist', 'build', 'out', 'coverage']);
const PREFERRED_DIR_NAMES = ['src', 'app', 'server', 'client', 'components', 'packages', 'libs', 'lib', 'api', 'pages', 'routes', 'webview'];

export type SyntaxSymbolKind =
  | 'function'
  | 'component'
  | 'hook'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'variable';

export type SyntaxSymbolRecord = Readonly<{
  name: string;
  kind: SyntaxSymbolKind;
  exported: boolean;
  line: number;
  signature: string;
}>;

export type SyntaxImportBindingRecord = Readonly<{
  localName: string;
  importedName: string;
  line: number;
  typeOnly: boolean;
}>;

export type SyntaxResolvedImportRecord = Readonly<{
  specifier: string;
  relativePath: string;
  line: number;
  bindings: readonly SyntaxImportBindingRecord[];
}>;

export type SyntaxSymbolCandidate = Readonly<{
  relation: 'primary' | 'definition' | 'reference';
  symbolName: string;
  filePath: string;
  line?: number;
  description: string;
}>;

export type ManualReadPlanStep = Readonly<{
  tool: 'read_file' | 'grep';
  targetPath: string;
  symbolName?: string;
  line?: number;
  pattern?: string;
  reason: string;
}>;

export type SyntaxFileRecord = Readonly<{
  relativePath: string;
  language: string;
  mtimeMs: number;
  imports: readonly string[];
  resolvedImports: readonly string[];
  resolvedImportRecords: readonly SyntaxResolvedImportRecord[];
  exports: readonly string[];
  symbols: readonly SyntaxSymbolRecord[];
  indexedAt: number;
}>;

export type SyntaxContextRecordSummary = Readonly<{
  relativePath: string;
  exports: readonly string[];
  imports: readonly string[];
  resolvedImports: readonly string[];
  symbols: readonly SyntaxSymbolRecord[];
}>;

type SyntaxIndexStore = Readonly<{
  version: number;
  workspacePath: string;
  updatedAt: number;
  files: Readonly<Record<string, SyntaxFileRecord>>;
}>;

export type SyntaxIndexContext = Readonly<{
  content: string;
  tokens: number;
  entryCount: number;
  records: readonly SyntaxContextRecordSummary[];
  primaryPaths: readonly string[];
  definitionPaths: readonly string[];
  referencePaths: readonly string[];
  priorityPaths: readonly string[];
  focusSymbols: readonly string[];
  primarySymbolCandidates: readonly SyntaxSymbolCandidate[];
  definitionSymbolCandidates: readonly SyntaxSymbolCandidate[];
  referenceSymbolCandidates: readonly SyntaxSymbolCandidate[];
  manualReadPlan: readonly ManualReadPlanStep[];
}>;

type TypeScriptProjectConfig = Readonly<{
  options: ts.CompilerOptions;
}>;

function createEmptyStore(workspacePath: string): SyntaxIndexStore {
  return Object.freeze({
    version: SYNTAX_INDEX_VERSION,
    workspacePath,
    updatedAt: 0,
    files: Object.freeze({}),
  });
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function resolveWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
  const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspacePath, filePath);
  const relativePath = path.relative(workspacePath, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split('/');
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return null;
  }
  return normalized;
}

function isSupportedSourceFile(relativePath: string): boolean {
  return SUPPORTED_SOURCE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

function compareDirNames(a: string, b: string): number {
  const preferredA = PREFERRED_DIR_NAMES.indexOf(a);
  const preferredB = PREFERRED_DIR_NAMES.indexOf(b);
  if (preferredA >= 0 || preferredB >= 0) {
    if (preferredA < 0) {
      return 1;
    }
    if (preferredB < 0) {
      return -1;
    }
    return preferredA - preferredB;
  }
  return a.localeCompare(b);
}

function getScriptKind(filePath: string): ts.ScriptKind {
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function collectImportBindings(sourceFile: ts.SourceFile): readonly Readonly<{
  specifier: string;
  line: number;
  bindings: readonly SyntaxImportBindingRecord[];
}>[] {
  const imports: Array<Readonly<{
    specifier: string;
    line: number;
    bindings: readonly SyntaxImportBindingRecord[];
  }>> = [];

  sourceFile.statements.forEach((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return;
    }

    const clause = statement.importClause;
    const bindings: SyntaxImportBindingRecord[] = [];
    const line = getLineNumber(sourceFile, statement);

    if (clause?.name) {
      bindings.push(
        Object.freeze({
          localName: clause.name.text,
          importedName: 'default',
          line,
          typeOnly: Boolean(clause.isTypeOnly),
        }),
      );
    }

    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push(
          Object.freeze({
            localName: clause.namedBindings.name.text,
            importedName: '*',
            line,
            typeOnly: Boolean(clause.isTypeOnly),
          }),
        );
      } else {
        clause.namedBindings.elements.forEach((element) => {
          bindings.push(
            Object.freeze({
              localName: element.name.text,
              importedName: element.propertyName?.text ?? element.name.text,
              line,
              typeOnly: Boolean(clause.isTypeOnly || element.isTypeOnly),
            }),
          );
        });
      }
    }

    imports.push(
      Object.freeze({
        specifier: statement.moduleSpecifier.text,
        line,
        bindings: Object.freeze(bindings),
      }),
    );
  });

  return Object.freeze(imports.slice(0, MAX_IMPORTS_PER_FILE));
}

function collectExports(sourceFile: ts.SourceFile): readonly string[] {
  const exports = new Set<string>();
  sourceFile.statements.forEach((statement) => {
    if (ts.isExportAssignment(statement)) {
      exports.add('default');
      return;
    }

    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        const moduleName =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : '';
        exports.add(moduleName ? `* from ${moduleName}` : '*');
        return;
      }

      if (ts.isNamedExports(statement.exportClause)) {
        statement.exportClause.elements.forEach((element) => exports.add(element.name.text));
      }
      return;
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      return;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      exports.add(statement.name.text);
      return;
    }

    if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((declaration) => {
        if (ts.isIdentifier(declaration.name)) {
          exports.add(declaration.name.text);
        }
      });
    }
  });
  return Object.freeze([...exports].slice(0, MAX_EXPORTS_PER_FILE));
}

function detectVariableKind(name: string, initializer: ts.Expression | undefined): SyntaxSymbolKind {
  const isFunctionLike = initializer ? ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) : false;
  if (isFunctionLike && /^use[A-Z0-9]/.test(name)) {
    return 'hook';
  }
  if (isFunctionLike && /^[A-Z]/.test(name)) {
    return 'component';
  }
  if (isFunctionLike) {
    return 'function';
  }
  return name === name.toUpperCase() ? 'const' : 'variable';
}

function buildFunctionSignature(
  name: string,
  node: ts.FunctionLikeDeclarationBase,
  sourceFile: ts.SourceFile,
  exported: boolean,
  kind: SyntaxSymbolKind,
): string {
  const params = node.parameters.map((parameter) => parameter.name.getText(sourceFile)).join(', ');
  const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : '';
  const prefix = exported ? 'export ' : '';
  const asyncPrefix = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
  const label = kind === 'hook' ? 'hook' : kind === 'component' ? 'component' : 'function';
  return `${prefix}${asyncPrefix}${label} ${name}(${params})${returnType}`.trim();
}

function buildClassLikeSignature(
  kind: 'class' | 'interface' | 'type' | 'enum',
  name: string,
  exported: boolean,
  sourceFile: ts.SourceFile,
  heritageClauses?: ts.NodeArray<ts.HeritageClause>,
  typeText?: string,
): string {
  const prefix = exported ? 'export ' : '';
  if (kind === 'type') {
    return `${prefix}type ${name} = ${typeText ?? 'unknown'}`.trim();
  }
  if (kind === 'enum') {
    return `${prefix}enum ${name}`.trim();
  }
  if (kind === 'interface') {
    return `${prefix}interface ${name}`.trim();
  }
  const heritage =
    heritageClauses
      ?.flatMap((clause) =>
        clause.types.map((typeNode) =>
          `${clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements'} ${typeNode.getText(sourceFile)}`,
        ),
      )
      .join(' ') ?? '';
  return `${prefix}class ${name}${heritage ? ` ${heritage}` : ''}`.trim();
}

function createFunctionSymbol(
  name: string,
  node: ts.FunctionLikeDeclarationBase,
  sourceFile: ts.SourceFile,
  exported: boolean,
  kind: SyntaxSymbolKind,
): SyntaxSymbolRecord {
  return Object.freeze({
    name,
    kind,
    exported,
    line: getLineNumber(sourceFile, node),
    signature: buildFunctionSignature(name, node, sourceFile, exported, kind),
  });
}

function createSimpleSymbol(opts: {
  name: string;
  kind: SyntaxSymbolKind;
  exported: boolean;
  line: number;
  signature: string;
}): SyntaxSymbolRecord {
  return Object.freeze({
    name: opts.name,
    kind: opts.kind,
    exported: opts.exported,
    line: opts.line,
    signature: opts.signature,
  });
}

function collectSymbols(sourceFile: ts.SourceFile): readonly SyntaxSymbolRecord[] {
  const symbols: SyntaxSymbolRecord[] = [];

  sourceFile.statements.forEach((statement) => {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      const kind: SyntaxSymbolKind = /^use[A-Z0-9]/.test(name)
        ? 'hook'
        : /^[A-Z]/.test(name)
          ? 'component'
          : 'function';
      symbols.push(createFunctionSymbol(name, statement, sourceFile, exported, kind));
      return;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      symbols.push(
        createSimpleSymbol({
          name: statement.name.text,
          kind: 'class',
          exported,
          line: getLineNumber(sourceFile, statement),
          signature: buildClassLikeSignature(
            'class',
            statement.name.text,
            exported,
            sourceFile,
            statement.heritageClauses,
          ),
        }),
      );
      return;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      symbols.push(
        createSimpleSymbol({
          name: statement.name.text,
          kind: 'interface',
          exported,
          line: getLineNumber(sourceFile, statement),
          signature: buildClassLikeSignature('interface', statement.name.text, exported, sourceFile),
        }),
      );
      return;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      symbols.push(
        createSimpleSymbol({
          name: statement.name.text,
          kind: 'type',
          exported,
          line: getLineNumber(sourceFile, statement),
          signature: buildClassLikeSignature(
            'type',
            statement.name.text,
            exported,
            sourceFile,
            undefined,
            statement.type.getText(sourceFile),
          ),
        }),
      );
      return;
    }

    if (ts.isEnumDeclaration(statement)) {
      symbols.push(
        createSimpleSymbol({
          name: statement.name.text,
          kind: 'enum',
          exported,
          line: getLineNumber(sourceFile, statement),
          signature: buildClassLikeSignature('enum', statement.name.text, exported, sourceFile),
        }),
      );
      return;
    }

    if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((declaration) => {
        if (!ts.isIdentifier(declaration.name)) {
          return;
        }
        const name = declaration.name.text;
        const kind = detectVariableKind(name, declaration.initializer);
        const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        const functionInitializer =
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
            ? declaration.initializer
            : null;
        const signature =
          functionInitializer
            ? buildFunctionSignature(name, functionInitializer, sourceFile, exported, kind)
            : `${exported ? 'export ' : ''}${isConst ? 'const' : 'let'} ${name}`.trim();
        symbols.push(
          createSimpleSymbol({
            name,
            kind: isConst && kind === 'variable' ? 'const' : kind,
            exported,
            line: getLineNumber(sourceFile, declaration),
            signature,
          }),
        );
      });
    }
  });

  return Object.freeze(symbols.slice(0, 24));
}

function inferLanguage(relativePath: string): string {
  if (relativePath.endsWith('.py')) {
    return 'python';
  }
  if (relativePath.endsWith('.go')) {
    return 'go';
  }
  if (relativePath.endsWith('.rs')) {
    return 'rust';
  }
  if (relativePath.endsWith('.java')) {
    return 'java';
  }
  if (relativePath.endsWith('.tsx')) {
    return 'tsx';
  }
  if (relativePath.endsWith('.ts') || relativePath.endsWith('.mts') || relativePath.endsWith('.cts') || relativePath.endsWith('.d.ts')) {
    return 'ts';
  }
  if (relativePath.endsWith('.jsx')) {
    return 'jsx';
  }
  return 'js';
}

function loadTypeScriptProjectConfig(workspacePath: string): TypeScriptProjectConfig {
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

function resolveImportRecordsWithCompiler(
  workspacePath: string,
  containingFile: string,
  importEntries: readonly Readonly<{
    specifier: string;
    line: number;
    bindings: readonly SyntaxImportBindingRecord[];
  }>[],
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
      resolved.set(
        relativePath,
        Object.freeze({
          specifier: importEntry.specifier,
          relativePath,
          line: importEntry.line,
          bindings: Object.freeze([...importEntry.bindings]),
        }),
      );
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
    resolved.set(
      relativePath,
      Object.freeze({
        ...existing,
        bindings: mergedBindings,
      }),
    );
  }

  return Object.freeze([...resolved.values()].slice(0, MAX_IMPORTS_PER_FILE));
}

async function parseSourceFile(
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

  const sourceFile = ts.createSourceFile(
    absolutePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(relativePath),
  );
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

function loadStore(workspacePath: string): SyntaxIndexStore {
  const projectStorage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(projectStorage);
  if (!fs.existsSync(projectStorage.syntaxIndexPath)) {
    return createEmptyStore(workspacePath);
  }

  try {
    const raw = fs.readFileSync(projectStorage.syntaxIndexPath, 'utf-8');
    const parsed = JSON.parse(raw) as SyntaxIndexStore;
    if (parsed.version !== SYNTAX_INDEX_VERSION || parsed.workspacePath !== workspacePath) {
      return createEmptyStore(workspacePath);
    }
    return Object.freeze({
      version: parsed.version,
      workspacePath: parsed.workspacePath,
      updatedAt: parsed.updatedAt,
      files: Object.freeze({ ...(parsed.files ?? {}) }),
    });
  } catch {
    return createEmptyStore(workspacePath);
  }
}

function saveStore(workspacePath: string, store: SyntaxIndexStore): void {
  const projectStorage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(projectStorage);
  fs.writeFileSync(projectStorage.syntaxIndexPath, JSON.stringify(store, null, 2), 'utf-8');
  syncSyntaxMetadata(
    workspacePath,
    Object.values(store.files).map((record) =>
      Object.freeze({
        relativePath: record.relativePath,
        language: record.language,
        mtimeMs: record.mtimeMs,
        imports: record.imports,
        exports: record.exports,
        symbols: record.symbols,
      }),
    ),
  );
}

function collectWorkspaceSeedFiles(
  workspacePath: string,
  store: SyntaxIndexStore,
): readonly string[] {
  const queue: string[] = [workspacePath];
  const discovered: Array<Readonly<{ relativePath: string; mtimeMs: number; missing: boolean }>> = [];
  let scannedDirs = 0;
  let scannedFiles = 0;

  while (queue.length > 0 && scannedDirs < MAX_SCAN_DIRS && scannedFiles < MAX_SCAN_FILES) {
    const dirPath = queue.shift()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    scannedDirs += 1;
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => compareDirNames(a.name, b.name));
    const files = entries
      .filter((entry) => entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const directory of directories) {
      const nextPath = path.join(dirPath, directory.name);
      const relativePath = path.relative(workspacePath, nextPath);
      const normalized = normalizeRelativePath(relativePath);
      if (!normalized || normalized.startsWith('..')) {
        continue;
      }
      if (normalized.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) {
        continue;
      }
      queue.push(nextPath);
    }

    for (const file of files) {
      if (scannedFiles >= MAX_SCAN_FILES) {
        break;
      }
      const fullPath = path.join(dirPath, file.name);
      const relativePath = resolveWorkspaceRelativePath(workspacePath, fullPath);
      if (!relativePath || !isSupportedSourceFile(relativePath)) {
        continue;
      }
      scannedFiles += 1;
      try {
        const stat = fs.statSync(fullPath);
        const current = store.files[relativePath];
        discovered.push(
          Object.freeze({
            relativePath,
            mtimeMs: stat.mtimeMs,
            missing: !current || current.mtimeMs !== stat.mtimeMs,
          }),
        );
      } catch {
        continue;
      }
    }
  }

  return Object.freeze(
    discovered
      .sort((a, b) => {
        if (a.missing !== b.missing) {
          return a.missing ? -1 : 1;
        }
        return a.relativePath.localeCompare(b.relativePath);
      })
      .slice(0, MAX_SEED_FILES)
      .map((entry) => entry.relativePath),
  );
}

function buildContextPaths(
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
  const rankedPrimaryPaths = rankPrimaryPaths({
    candidateFiles,
    indexedFiles,
    queryText,
  });

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

async function ensureIndexedFiles(workspacePath: string, candidateFiles: readonly string[], queryText: string): Promise<Readonly<{
  files: Readonly<Record<string, SyntaxFileRecord>>;
  records: readonly SyntaxFileRecord[];
  selection: Readonly<{
    primaryPaths: readonly string[];
    selectedPaths: readonly string[];
    definitionPaths: readonly string[];
    referencePaths: readonly string[];
  }>;
}>> {
  const normalizedCandidates = Object.freeze(
    [...new Set(candidateFiles)]
      .map((filePath) => resolveWorkspaceRelativePath(workspacePath, filePath))
      .filter((filePath): filePath is string => Boolean(filePath && isSupportedSourceFile(filePath)))
      .slice(0, MAX_CONTEXT_FILES),
  );

  const store = loadStore(workspacePath);
  const seedFiles = collectWorkspaceSeedFiles(workspacePath, store);
  const indexingTargets = Object.freeze(
    [...new Set([...normalizedCandidates, ...seedFiles])],
  );
  if (indexingTargets.length === 0) {
    return Object.freeze({
      files: Object.freeze({}),
      records: Object.freeze([]),
      selection: Object.freeze({
        primaryPaths: Object.freeze([]),
        selectedPaths: Object.freeze([]),
        definitionPaths: Object.freeze([]),
        referencePaths: Object.freeze([]),
      }),
    });
  }

  const projectConfig = loadTypeScriptProjectConfig(workspacePath);
  const nextFiles: Record<string, SyntaxFileRecord> = { ...store.files };
  let changed = false;

  for (const relativePath of indexingTargets) {
    const absolutePath = path.join(workspacePath, relativePath);
    if (!fs.existsSync(absolutePath)) {
      if (relativePath in nextFiles) {
        delete nextFiles[relativePath];
        changed = true;
      }
      continue;
    }

    const stat = fs.statSync(absolutePath);
    const current = nextFiles[relativePath];
    if (!current || current.mtimeMs !== stat.mtimeMs) {
      const parsed = await parseSourceFile(workspacePath, relativePath, projectConfig);
      if (parsed) {
        nextFiles[relativePath] = parsed;
        changed = true;
      } else if (current) {
        delete nextFiles[relativePath];
        changed = true;
      }
    }
  }

  if (changed) {
    saveStore(
      workspacePath,
      Object.freeze({
        version: SYNTAX_INDEX_VERSION,
        workspacePath,
        updatedAt: Date.now(),
        files: Object.freeze(nextFiles),
      }),
    );
  }

  if (normalizedCandidates.length === 0) {
    return Object.freeze({
      files: Object.freeze(nextFiles),
      records: Object.freeze([]),
      selection: Object.freeze({
        primaryPaths: Object.freeze([]),
        selectedPaths: Object.freeze([]),
        definitionPaths: Object.freeze([]),
        referencePaths: Object.freeze([]),
      }),
    });
  }

  const selection = buildContextPaths(normalizedCandidates, nextFiles, queryText);
  return Object.freeze({
    files: Object.freeze(nextFiles),
    records: Object.freeze(
      selection.selectedPaths
        .map((relativePath) => nextFiles[relativePath])
        .filter((record): record is SyntaxFileRecord => Boolean(record)),
    ),
    selection,
  });
}

function addUniqueSymbolName(target: string[], value: string): void {
  if (value && !target.includes(value)) {
    target.push(value);
  }
}

function buildSymbolLookup(records: readonly SyntaxFileRecord[]): Readonly<{
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

function extractQueryIdentifiers(text: string): readonly string[] {
  const matches = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? [];
  return Object.freeze([...new Set(matches)].slice(0, 24));
}

function buildRecordReferenceMap(
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

function scoreRecordForPrimarySelection(opts: {
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

function rankPrimaryPaths(opts: {
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

  return Object.freeze(
    ranked.slice(0, MAX_PRIMARY_CONTEXT_FILES).map((entry) => entry.relativePath),
  );
}

function resolveFocusSymbols(
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
    record.symbols
      .filter((symbol) => symbol.exported)
      .slice(0, 2)
      .forEach((symbol) => addUniqueSymbolName(focusSymbols, symbol.name));
    if (focusSymbols.length >= MAX_FOCUS_SYMBOLS) {
      return;
    }
    record.symbols.slice(0, 2).forEach((symbol) => addUniqueSymbolName(focusSymbols, symbol.name));
  });

  return Object.freeze(focusSymbols.slice(0, MAX_FOCUS_SYMBOLS));
}

function findSymbolInRecord(record: SyntaxFileRecord, candidateNames: readonly string[]): SyntaxSymbolRecord | null {
  for (const candidateName of candidateNames) {
    const exact = record.symbols.find((symbol) => symbol.name === candidateName);
    if (exact) {
      return exact;
    }
  }

  if (candidateNames.includes('default')) {
    return record.symbols.find((symbol) => symbol.exported) ?? record.symbols[0] ?? null;
  }

  return null;
}

function buildPrimarySymbolCandidates(
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
      candidates.push(
        Object.freeze({
          relation: 'primary',
          symbolName: symbol.name,
          filePath: record.relativePath,
          line: symbol.line,
          description: `${symbol.signature} @ ${record.relativePath}:${symbol.line}`,
        }),
      );
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

function buildDefinitionSymbolCandidates(
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
        const matchesFocus =
          focusSet.size === 0 ||
          focusSet.has(binding.localName) ||
          focusSet.has(binding.importedName);
        if (!matchesFocus) {
          return;
        }

        const targetSymbol = findSymbolInRecord(targetRecord, [binding.importedName, binding.localName]);
        if (!targetSymbol) {
          return;
        }

        candidates.push(
          Object.freeze({
            relation: 'definition',
            symbolName: targetSymbol.name,
            filePath: targetRecord.relativePath,
            line: targetSymbol.line,
            description:
              `${targetSymbol.signature} @ ${targetRecord.relativePath}:${targetSymbol.line}` +
              ` imported by ${record.relativePath}` +
              (binding.localName !== targetSymbol.name ? ` as ${binding.localName}` : ''),
          }),
        );
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

function buildReferenceSymbolCandidates(
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

        candidates.push(
          Object.freeze({
            relation: 'reference',
            symbolName,
            filePath: record.relativePath,
            line: importRecord.line,
            description:
              `${record.relativePath}:${importRecord.line} imports ${binding.localName}` +
              ` from ${targetRecord.relativePath}` +
              (targetSymbol && binding.localName !== targetSymbol.name ? ` (export ${targetSymbol.name})` : ''),
          }),
        );
      });
    });
  });

  return Object.freeze(
    [...new Map(candidates.map((candidate) => [`${candidate.filePath}:${candidate.symbolName}:${candidate.line ?? 0}`, candidate])).values()]
      .slice(0, MAX_SYMBOL_CANDIDATES),
  );
}

function buildManualReadPlan(opts: {
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
    pushStep(
      Object.freeze({
        tool: 'read_file',
        targetPath: candidate.filePath,
        symbolName: candidate.symbolName,
        ...(typeof candidate.line === 'number' ? { line: candidate.line } : {}),
        reason: `Inspect primary symbol ${candidate.symbolName}`,
      }),
    );
  });

  opts.definitionSymbolCandidates.slice(0, 2).forEach((candidate) => {
    pushStep(
      Object.freeze({
        tool: 'read_file',
        targetPath: candidate.filePath,
        symbolName: candidate.symbolName,
        ...(typeof candidate.line === 'number' ? { line: candidate.line } : {}),
        reason: `Inspect definition candidate ${candidate.symbolName}`,
      }),
    );
  });

  opts.referenceSymbolCandidates.slice(0, 2).forEach((candidate) => {
    pushStep(
      Object.freeze({
        tool: typeof candidate.line === 'number' ? 'read_file' : 'grep',
        targetPath: candidate.filePath,
        symbolName: candidate.symbolName,
        ...(typeof candidate.line === 'number' ? { line: candidate.line } : {}),
        ...(candidate.symbolName ? { pattern: candidate.symbolName } : {}),
        reason: `Verify downstream usage of ${candidate.symbolName}`,
      }),
    );
  });

  if (opts.focusSymbols.length > 0) {
    const grepPattern = opts.focusSymbols.slice(0, 3).join('|');
    [...new Set([...opts.primaryPaths, ...opts.definitionPaths, ...opts.referencePaths])]
      .slice(0, 3)
      .forEach((targetPath) => {
        pushStep(
          Object.freeze({
            tool: 'grep',
            targetPath,
            pattern: grepPattern,
            reason: `Search for focus symbols in ${targetPath}`,
          }),
        );
      });
  }

  return Object.freeze(steps.slice(0, 8));
}

function formatRecord(opts: {
  record: SyntaxFileRecord;
  referencePaths: readonly string[];
  focusSymbols: readonly string[];
}): readonly string[] {
  const { record, referencePaths, focusSymbols } = opts;
  const lines: string[] = [`File: ${record.relativePath}`];
  if (record.exports.length > 0) {
    lines.push(`Exports: ${record.exports.join(', ')}`);
  }
  if (record.imports.length > 0) {
    lines.push(`Imports: ${record.imports.join(', ')}`);
  }
  if (record.resolvedImports.length > 0) {
    lines.push(`Related: ${record.resolvedImports.join(', ')}`);
    lines.push(`Definitions: ${record.resolvedImports.slice(0, MAX_RELATED_CONTEXT_FILES).join(', ')}`);
  }
  if (referencePaths.length > 0) {
    lines.push(`Referenced by: ${referencePaths.slice(0, MAX_RELATED_CONTEXT_FILES).join(', ')}`);
  }
  if (record.symbols.length > 0) {
    lines.push('Skeleton:');
    record.symbols.slice(0, MAX_SYMBOLS_PER_FILE).forEach((symbol) => {
      const highlighted = focusSymbols.includes(symbol.name) ? ' [focus]' : '';
      lines.push(`- ${symbol.signature}${highlighted}`);
    });
  }
  return Object.freeze(lines);
}

export async function buildSyntaxIndexContext(opts: {
  workspacePath: string;
  candidateFiles: readonly string[];
  queryText?: string;
}): Promise<SyntaxIndexContext> {
  const workspacePath = path.resolve(opts.workspacePath);
  const indexed = await ensureIndexedFiles(workspacePath, opts.candidateFiles, opts.queryText ?? '');
  const records = indexed.records;
  if (records.length === 0) {
    return Object.freeze({
      content: '',
      tokens: 0,
      entryCount: 0,
      records: Object.freeze([]),
      primaryPaths: Object.freeze([]),
      definitionPaths: Object.freeze([]),
      referencePaths: Object.freeze([]),
      priorityPaths: Object.freeze([]),
      focusSymbols: Object.freeze([]),
      primarySymbolCandidates: Object.freeze([]),
      definitionSymbolCandidates: Object.freeze([]),
      referenceSymbolCandidates: Object.freeze([]),
      manualReadPlan: Object.freeze([]),
    });
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
