/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Internal helpers for TypeScript syntax parsing and symbol extraction.
 */

import * as ts from 'typescript';
import type {
  SyntaxImportBindingRecord,
  SyntaxSymbolKind,
  SyntaxSymbolRecord,
} from '../entities/syntax-index';
import { MAX_EXPORTS_PER_FILE, MAX_IMPORTS_PER_FILE } from './constants';

/**
 * Resolves the TypeScript script kind from a file suffix.
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
 * Checks whether a node has a specific TypeScript modifier.
 */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

/**
 * Returns the 1-based line number for a node.
 */
export function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Collects import bindings from a TypeScript source file.
 */
export function collectImportBindings(sourceFile: ts.SourceFile): readonly Readonly<{
  specifier: string;
  line: number;
  bindings: readonly SyntaxImportBindingRecord[];
}>[] {
  const imports: Array<Readonly<{ specifier: string; line: number; bindings: readonly SyntaxImportBindingRecord[] }>> = [];

  sourceFile.statements.forEach((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return;
    }

    const clause = statement.importClause;
    const bindings: SyntaxImportBindingRecord[] = [];
    const line = getLineNumber(sourceFile, statement);

    if (clause?.name) {
      bindings.push(Object.freeze({
        localName: clause.name.text,
        importedName: 'default',
        line,
        typeOnly: Boolean(clause.isTypeOnly),
      }));
    }

    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push(Object.freeze({
          localName: clause.namedBindings.name.text,
          importedName: '*',
          line,
          typeOnly: Boolean(clause.isTypeOnly),
        }));
      } else {
        clause.namedBindings.elements.forEach((element) => {
          bindings.push(Object.freeze({
            localName: element.name.text,
            importedName: element.propertyName?.text ?? element.name.text,
            line,
            typeOnly: Boolean(clause.isTypeOnly || element.isTypeOnly),
          }));
        });
      }
    }

    imports.push(Object.freeze({
      specifier: statement.moduleSpecifier.text,
      line,
      bindings: Object.freeze(bindings),
    }));
  });

  return Object.freeze(imports.slice(0, MAX_IMPORTS_PER_FILE));
}

/**
 * Collects exported names from a TypeScript source file.
 */
export function collectExports(sourceFile: ts.SourceFile): readonly string[] {
  const exports = new Set<string>();
  sourceFile.statements.forEach((statement) => {
    if (ts.isExportAssignment(statement)) {
      exports.add('default');
      return;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        const moduleName = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
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

/**
 * Infers a normalized symbol kind for a variable declaration.
 */
export function detectVariableKind(name: string, initializer: ts.Expression | undefined): SyntaxSymbolKind {
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

/**
 * Builds a readable function-like signature.
 */
export function buildFunctionSignature(
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

/**
 * Builds a readable signature for class-like declarations.
 */
export function buildClassLikeSignature(
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
  const heritage = heritageClauses?.flatMap((clause) =>
    clause.types.map((typeNode) =>
      `${clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements'} ${typeNode.getText(sourceFile)}`,
    ),
  ).join(' ') ?? '';
  return `${prefix}class ${name}${heritage ? ` ${heritage}` : ''}`.trim();
}

/**
 * Creates a function-like symbol record.
 */
export function createFunctionSymbol(
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

/**
 * Creates a simple symbol record from normalized inputs.
 */
export function createSimpleSymbol(opts: {
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

/**
 * Collects symbols from a TypeScript or JavaScript source file.
 */
export function collectSymbols(sourceFile: ts.SourceFile): readonly SyntaxSymbolRecord[] {
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
      symbols.push(createSimpleSymbol({
        name: statement.name.text,
        kind: 'class',
        exported,
        line: getLineNumber(sourceFile, statement),
        signature: buildClassLikeSignature('class', statement.name.text, exported, sourceFile, statement.heritageClauses),
      }));
      return;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      symbols.push(createSimpleSymbol({
        name: statement.name.text,
        kind: 'interface',
        exported,
        line: getLineNumber(sourceFile, statement),
        signature: buildClassLikeSignature('interface', statement.name.text, exported, sourceFile),
      }));
      return;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      symbols.push(createSimpleSymbol({
        name: statement.name.text,
        kind: 'type',
        exported,
        line: getLineNumber(sourceFile, statement),
        signature: buildClassLikeSignature('type', statement.name.text, exported, sourceFile, undefined, statement.type.getText(sourceFile)),
      }));
      return;
    }
    if (ts.isEnumDeclaration(statement)) {
      symbols.push(createSimpleSymbol({
        name: statement.name.text,
        kind: 'enum',
        exported,
        line: getLineNumber(sourceFile, statement),
        signature: buildClassLikeSignature('enum', statement.name.text, exported, sourceFile),
      }));
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
        const signature = functionInitializer
          ? buildFunctionSignature(name, functionInitializer, sourceFile, exported, kind)
          : `${exported ? 'export ' : ''}${isConst ? 'const' : 'let'} ${name}`.trim();
        symbols.push(createSimpleSymbol({
          name,
          kind: isConst && kind === 'variable' ? 'const' : kind,
          exported,
          line: getLineNumber(sourceFile, declaration),
          signature,
        }));
      });
    }
  });
  return Object.freeze(symbols.slice(0, 24));
}

/**
 * Infers the language label stored with a file record.
 */
export function inferLanguage(relativePath: string): string {
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
