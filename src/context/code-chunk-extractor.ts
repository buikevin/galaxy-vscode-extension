import * as ts from 'typescript';
import type { SyntaxSymbolKind } from './syntax-index';
import { extractTreeSitterCodeUnits, type TreeSitterCodeUnit } from './tree-sitter-parser';

export type CodeChunkUnit = Readonly<{
  name: string;
  kind: SyntaxSymbolKind;
  exported: boolean;
  signature: string;
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
}>;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
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

function createUnit(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string,
  kind: SyntaxSymbolKind,
  exported: boolean,
  signature: string,
): CodeChunkUnit {
  return Object.freeze({
    name,
    kind,
    exported,
    signature,
    startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    startIndex: node.getStart(sourceFile),
    endIndex: node.getEnd(),
  });
}

function extractTypeScriptCodeUnits(relativePath: string, content: string): readonly CodeChunkUnit[] {
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, getScriptKind(relativePath));
  const units: CodeChunkUnit[] = [];

  sourceFile.statements.forEach((statement) => {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      const kind: SyntaxSymbolKind = /^use[A-Z0-9]/.test(name)
        ? 'hook'
        : /^[A-Z]/.test(name)
          ? 'component'
          : 'function';
      units.push(createUnit(sourceFile, statement, name, kind, exported, buildFunctionSignature(name, statement, sourceFile, exported, kind)));
      return;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      units.push(createUnit(sourceFile, statement, statement.name.text, 'class', exported, buildClassLikeSignature('class', statement.name.text, exported, sourceFile, statement.heritageClauses)));
      return;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      units.push(createUnit(sourceFile, statement, statement.name.text, 'interface', exported, buildClassLikeSignature('interface', statement.name.text, exported, sourceFile)));
      return;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      units.push(createUnit(sourceFile, statement, statement.name.text, 'type', exported, buildClassLikeSignature('type', statement.name.text, exported, sourceFile, undefined, statement.type.getText(sourceFile))));
      return;
    }

    if (ts.isEnumDeclaration(statement)) {
      units.push(createUnit(sourceFile, statement, statement.name.text, 'enum', exported, buildClassLikeSignature('enum', statement.name.text, exported, sourceFile)));
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
        units.push(createUnit(sourceFile, declaration, name, isConst && kind === 'variable' ? 'const' : kind, exported, signature));
      });
    }
  });

  return Object.freeze(units.slice(0, 24));
}

function isTypeScriptLike(relativePath: string): boolean {
  return ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].some((suffix) => relativePath.endsWith(suffix));
}

export async function extractCodeChunkUnits(opts: {
  relativePath: string;
  content: string;
}): Promise<readonly CodeChunkUnit[]> {
  if (isTypeScriptLike(opts.relativePath)) {
    return extractTypeScriptCodeUnits(opts.relativePath, opts.content);
  }
  return (await extractTreeSitterCodeUnits(opts)) as readonly TreeSitterCodeUnit[];
}
