/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Symbol unit extraction and parsed file construction for workflow graphs.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import type { ParsedFile, SymbolUnit, TypeScriptProjectConfig } from '../entities/extractor';
import {
  collectImportBindings,
  createSourceHash,
  getLineNumber,
  getNodeEndLine,
  getScriptKind,
  hasModifier,
  sanitizeIdentifier,
} from './files';
import { MAX_FILE_BYTES } from '../entities/constants';

/**
 * Classifies a top-level symbol into a workflow-oriented node type.
 */
export function classifySymbolNodeType(relativePath: string, name: string, sourceFile: ts.SourceFile): string {
  const lowerPath = relativePath.toLowerCase();
  if (/webhook/.test(lowerPath) || /webhook/i.test(name)) {
    return 'webhook_handler';
  }
  if (/worker|consumer|subscriber|processor/.test(lowerPath)) {
    return 'worker';
  }
  if (/job|cron|schedule/.test(lowerPath)) {
    return 'job';
  }
  if (/controller/.test(lowerPath)) {
    return 'controller';
  }
  if (/repo|repository|dao|model/.test(lowerPath)) {
    return 'repository';
  }
  if (/service/.test(lowerPath)) {
    return 'backend_service';
  }
  if (/client|api/.test(lowerPath)) {
    return sourceFile.languageVariant === ts.LanguageVariant.JSX ? 'frontend_service' : 'backend_service';
  }
  if (/page|screen|view/.test(lowerPath) || /(Page|Screen|View)$/.test(name)) {
    return 'screen';
  }
  if (/^handle[A-Z0-9]/.test(name) || /^on[A-Z0-9]/.test(name)) {
    return 'event_handler';
  }
  if (sourceFile.languageVariant === ts.LanguageVariant.JSX && /^[A-Z]/.test(name)) {
    return 'component';
  }
  return 'entrypoint';
}

/**
 * Creates a normalized symbol unit from a TypeScript AST node.
 */
export function createSymbolUnit(opts: {
  relativePath: string;
  sourceFile: ts.SourceFile;
  localName?: string;
  exported: boolean;
  nodeType: string;
  label: string;
  symbolName?: string;
  node: ts.Node;
  callableNodes: readonly ts.Node[];
  description?: string;
  descriptionSource?: string;
  confidence: number;
  sourceHash: string;
}): SymbolUnit {
  const createdAt = Date.now();
  return Object.freeze({
    id: `workflow:symbol:${opts.relativePath}:${sanitizeIdentifier(opts.symbolName ?? opts.label)}:${opts.node.getStart(opts.sourceFile)}`,
    relativePath: opts.relativePath,
    ...(opts.localName ? { localName: opts.localName } : {}),
    exported: opts.exported,
    nodeType: opts.nodeType,
    label: opts.label,
    ...(opts.symbolName ? { symbolName: opts.symbolName } : {}),
    startLine: getLineNumber(opts.sourceFile, opts.node),
    endLine: getNodeEndLine(opts.sourceFile, opts.node),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.descriptionSource ? { descriptionSource: opts.descriptionSource } : {}),
    confidence: opts.confidence,
    sourceHash: opts.sourceHash,
    createdAt,
    updatedAt: createdAt,
    callableNodes: opts.callableNodes,
  });
}

/**
 * Extracts top-level executable units from a parsed source file.
 */
export function extractTopLevelUnits(relativePath: string, sourceFile: ts.SourceFile, sourceHash: string): readonly SymbolUnit[] {
  const units: SymbolUnit[] = [];

  sourceFile.statements.forEach((statement) => {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      const nodeType = classifySymbolNodeType(relativePath, statement.name.text, sourceFile);
      units.push(
        createSymbolUnit({
          relativePath,
          sourceFile,
          localName: statement.name.text,
          exported,
          nodeType,
          label: statement.name.text,
          symbolName: statement.name.text,
          node: statement,
          callableNodes: [statement.body],
          description: `${nodeType.replace(/_/g, ' ')} ${statement.name.text}`,
          descriptionSource: 'signature',
          confidence: 0.92,
          sourceHash,
        }),
      );
      return;
    }

    if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((declaration) => {
        if (!ts.isIdentifier(declaration.name)) {
          return;
        }
        const initializer = declaration.initializer;
        if (!initializer || (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))) {
          return;
        }
        const name = declaration.name.text;
        const nodeType = classifySymbolNodeType(relativePath, name, sourceFile);
        units.push(
          createSymbolUnit({
            relativePath,
            sourceFile,
            localName: name,
            exported,
            nodeType,
            label: name,
            symbolName: name,
            node: declaration,
            callableNodes: initializer.body ? [initializer.body] : [],
            description: `${nodeType.replace(/_/g, ' ')} ${name}`,
            descriptionSource: 'signature',
            confidence: 0.88,
            sourceHash,
          }),
        );
      });
      return;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const callableNodes = statement.members
        .filter((member): member is ts.MethodDeclaration | ts.ConstructorDeclaration =>
          (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && Boolean(member.body),
        )
        .map((member) => member.body!)
        .filter(Boolean);
      const nodeType = classifySymbolNodeType(relativePath, statement.name.text, sourceFile);
      units.push(
        createSymbolUnit({
          relativePath,
          sourceFile,
          localName: statement.name.text,
          exported,
          nodeType,
          label: statement.name.text,
          symbolName: statement.name.text,
          node: statement,
          callableNodes,
          description: `${nodeType.replace(/_/g, ' ')} class ${statement.name.text}`,
          descriptionSource: 'signature',
          confidence: 0.84,
          sourceHash,
        }),
      );
    }
  });

  return Object.freeze(units);
}

/**
 * Parses a workflow-relevant source file into a normalized internal representation.
 */
export function parseWorkflowFile(
  workspacePath: string,
  relativePath: string,
  projectConfig: TypeScriptProjectConfig,
): ParsedFile | null {
  const absolutePath = path.join(workspacePath, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return null;
    }
  } catch {
    return null;
  }

  let content = '';
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return null;
  }

  const sourceFile = ts.createSourceFile(
    absolutePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(relativePath),
  );
  const sourceHash = createSourceHash(relativePath, content);
  const units = extractTopLevelUnits(relativePath, sourceFile, sourceHash);
  return Object.freeze({
    relativePath,
    absolutePath,
    sourceFile,
    mtimeMs: stat.mtimeMs,
    sourceHash,
    units,
    localSymbolIds: new Map(units.flatMap((unit) => (unit.localName ? [[unit.localName, unit.id] as const] : []))),
    importBindings: collectImportBindings(workspacePath, absolutePath, sourceFile, projectConfig),
  });
}
