import fs from 'node:fs';
import path from 'node:path';
import Parser from 'web-tree-sitter';
import type {
  SyntaxFileRecord,
  SyntaxResolvedImportRecord,
  SyntaxSymbolKind,
  SyntaxSymbolRecord,
} from './syntax-index';

type TreeSitterLanguageId = 'python' | 'go' | 'rust' | 'java';

export type TreeSitterCodeUnit = Readonly<{
  name: string;
  kind: SyntaxSymbolKind;
  exported: boolean;
  signature: string;
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
}>;

type ParsedImportEntry = Readonly<{
  specifier: string;
  line: number;
}>;

type ParsedSyntaxData = Readonly<{
  language: string;
  imports: readonly string[];
  resolvedImports: readonly string[];
  resolvedImportRecords: readonly SyntaxResolvedImportRecord[];
  exports: readonly string[];
  symbols: readonly SyntaxSymbolRecord[];
}>;

function resolveWasmAssetPath(fileName: string): string {
  const candidates = [
    path.join(__dirname, 'wasm', fileName),
    path.join(__dirname, '..', 'wasm', fileName),
    path.join(__dirname, '..', '..', 'dist', 'wasm', fileName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

const TREE_SITTER_INIT_WASM_PATH = resolveWasmAssetPath('tree-sitter.wasm');
const LANGUAGE_WASM_PATHS: Readonly<Record<TreeSitterLanguageId, string>> = Object.freeze({
  python: resolveWasmAssetPath('tree-sitter-python.wasm'),
  go: resolveWasmAssetPath('tree-sitter-go.wasm'),
  rust: resolveWasmAssetPath('tree-sitter-rust.wasm'),
  java: resolveWasmAssetPath('tree-sitter-java.wasm'),
});

let parserInitPromise: Promise<void> | null = null;
const languageCache = new Map<TreeSitterLanguageId, Promise<Parser.Language>>();

function getTreeSitterLanguageId(relativePath: string): TreeSitterLanguageId | null {
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
  return null;
}

async function ensureParserInit(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({
      locateFile() {
        return TREE_SITTER_INIT_WASM_PATH;
      },
    });
  }
  await parserInitPromise;
}

async function loadLanguage(languageId: TreeSitterLanguageId): Promise<Parser.Language> {
  let languagePromise = languageCache.get(languageId);
  if (!languagePromise) {
    languagePromise = Parser.Language.load(LANGUAGE_WASM_PATHS[languageId]);
    languageCache.set(languageId, languagePromise);
  }
  return await languagePromise;
}

function getNodeText(node: Parser.SyntaxNode | null, content: string): string {
  if (!node) {
    return '';
  }
  return content.slice(node.startIndex, node.endIndex);
}

function getLineNumber(node: Parser.SyntaxNode): number {
  return node.startPosition.row + 1;
}

function createSymbolRecord(
  name: string,
  kind: SyntaxSymbolKind,
  exported: boolean,
  line: number,
  signature: string,
): SyntaxSymbolRecord {
  return Object.freeze({
    name,
    kind,
    exported,
    line,
    signature: signature.trim().replace(/\s+/g, ' ').slice(0, 240),
  });
}

function createCodeUnit(
  node: Parser.SyntaxNode,
  content: string,
  name: string,
  kind: SyntaxSymbolKind,
  exported: boolean,
): TreeSitterCodeUnit {
  return Object.freeze({
    name,
    kind,
    exported,
    signature: getNodeText(node, content).trim().replace(/\s+/g, ' ').slice(0, 240),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  });
}

function pushImport(entries: ParsedImportEntry[], specifier: string, line: number): void {
  const normalized = specifier.trim();
  if (!normalized) {
    return;
  }
  if (entries.some((entry) => entry.specifier === normalized)) {
    return;
  }
  entries.push(Object.freeze({ specifier: normalized, line }));
}

function extractPythonData(content: string, rootNode: Parser.SyntaxNode): ParsedSyntaxData {
  const imports: ParsedImportEntry[] = [];
  const symbols: SyntaxSymbolRecord[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === 'import_statement') {
      const text = getNodeText(node, content);
      const specifiers = [...text.matchAll(/\bimport\s+([A-Za-z0-9_\.]+)/g)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => Boolean(specifier));
      for (const specifier of specifiers) {
        pushImport(imports, specifier, getLineNumber(node));
      }
      continue;
    }

    if (node.type === 'import_from_statement') {
      const moduleName = getNodeText(node.childForFieldName('module_name'), content);
      if (moduleName) {
        pushImport(imports, moduleName, getLineNumber(node));
      }
      continue;
    }

    if (node.type === 'class_definition' || node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      const name = getNodeText(nameNode, content);
      if (!name) {
        continue;
      }
      symbols.push(
        createSymbolRecord(
          name,
          node.type === 'class_definition' ? 'class' : 'function',
          false,
          getLineNumber(node),
          getNodeText(node, content),
        ),
      );
    }
  }

  return Object.freeze({
    language: 'python',
    imports: Object.freeze(imports.map((entry) => entry.specifier).slice(0, 6)),
    resolvedImports: Object.freeze([]),
    resolvedImportRecords: Object.freeze([]),
    exports: Object.freeze([]),
    symbols: Object.freeze(symbols.slice(0, 24)),
  });
}

function extractGoData(content: string, rootNode: Parser.SyntaxNode): ParsedSyntaxData {
  const imports: ParsedImportEntry[] = [];
  const exports = new Set<string>();
  const symbols: SyntaxSymbolRecord[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === 'import_declaration') {
      for (const importSpec of node.descendantsOfType('import_spec')) {
        const pathNode = importSpec.childForFieldName('path');
        const specifier = getNodeText(pathNode, content).replace(/^\"|\"$/g, '');
        pushImport(imports, specifier, getLineNumber(importSpec));
      }
      continue;
    }

    if (node.type === 'function_declaration' || node.type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = getNodeText(nameNode, content);
      if (!name) {
        continue;
      }
      const exported = /^[A-Z]/.test(name);
      if (exported) {
        exports.add(name);
      }
      symbols.push(createSymbolRecord(name, 'function', exported, getLineNumber(node), getNodeText(node, content)));
      continue;
    }

    if (node.type === 'type_declaration') {
      for (const typeSpec of node.descendantsOfType('type_spec')) {
        const nameNode = typeSpec.childForFieldName('name');
        const typeNode = typeSpec.childForFieldName('type');
        const name = getNodeText(nameNode, content);
        if (!name) {
          continue;
        }
        const kind: SyntaxSymbolKind =
          typeNode?.type === 'struct_type'
            ? 'class'
            : typeNode?.type === 'interface_type'
              ? 'interface'
              : 'type';
        const exported = /^[A-Z]/.test(name);
        if (exported) {
          exports.add(name);
        }
        symbols.push(createSymbolRecord(name, kind, exported, getLineNumber(typeSpec), getNodeText(typeSpec, content)));
      }
      continue;
    }

    if (node.type === 'const_declaration' || node.type === 'var_declaration') {
      const kind: SyntaxSymbolKind = node.type === 'const_declaration' ? 'const' : 'variable';
      for (const child of node.namedChildren.filter((candidate) => candidate.type === 'const_spec' || candidate.type === 'var_spec')) {
        const nameNode = child.childForFieldName('name');
        const names = nameNode ? [nameNode] : child.namedChildren.filter((candidate) => candidate.type === 'identifier');
        for (const identifier of names) {
          const name = getNodeText(identifier, content);
          if (!name) {
            continue;
          }
          const exported = /^[A-Z]/.test(name);
          if (exported) {
            exports.add(name);
          }
          symbols.push(createSymbolRecord(name, kind, exported, getLineNumber(child), getNodeText(child, content)));
        }
      }
    }
  }

  return Object.freeze({
    language: 'go',
    imports: Object.freeze(imports.map((entry) => entry.specifier).slice(0, 6)),
    resolvedImports: Object.freeze([]),
    resolvedImportRecords: Object.freeze([]),
    exports: Object.freeze([...exports].slice(0, 8)),
    symbols: Object.freeze(symbols.slice(0, 24)),
  });
}

function extractRustData(content: string, rootNode: Parser.SyntaxNode): ParsedSyntaxData {
  const imports: ParsedImportEntry[] = [];
  const exports = new Set<string>();
  const symbols: SyntaxSymbolRecord[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === 'use_declaration') {
      const text = getNodeText(node, content)
        .replace(/^use\s+/, '')
        .replace(/;$/, '')
        .trim();
      if (text) {
        pushImport(imports, text, getLineNumber(node));
      }
      continue;
    }

    const kindMap: Partial<Record<string, SyntaxSymbolKind>> = {
      function_item: 'function',
      struct_item: 'class',
      enum_item: 'enum',
      trait_item: 'interface',
      type_item: 'type',
      const_item: 'const',
      static_item: 'variable',
    };
    const symbolKind = kindMap[node.type];
    if (!symbolKind) {
      continue;
    }
    const nameNode = node.childForFieldName('name');
    const name = getNodeText(nameNode, content);
    if (!name) {
      continue;
    }
    const exported = /\bpub\b/.test(getNodeText(node, content).split('{', 1)[0] ?? '');
    if (exported) {
      exports.add(name);
    }
    symbols.push(createSymbolRecord(name, symbolKind, exported, getLineNumber(node), getNodeText(node, content)));
  }

  return Object.freeze({
    language: 'rust',
    imports: Object.freeze(imports.map((entry) => entry.specifier).slice(0, 6)),
    resolvedImports: Object.freeze([]),
    resolvedImportRecords: Object.freeze([]),
    exports: Object.freeze([...exports].slice(0, 8)),
    symbols: Object.freeze(symbols.slice(0, 24)),
  });
}

function extractJavaData(content: string, rootNode: Parser.SyntaxNode): ParsedSyntaxData {
  const imports: ParsedImportEntry[] = [];
  const exports = new Set<string>();
  const symbols: SyntaxSymbolRecord[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === 'import_declaration') {
      const scopedIdentifier = node.descendantsOfType('scoped_identifier')[0];
      const identifier = scopedIdentifier ?? node.descendantsOfType('identifier')[0] ?? null;
      const specifier = getNodeText(identifier, content);
      if (specifier) {
        pushImport(imports, specifier, getLineNumber(node));
      }
      continue;
    }

    const kindMap: Partial<Record<string, SyntaxSymbolKind>> = {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      annotation_type_declaration: 'type',
      method_declaration: 'function',
    };
    const symbolKind = kindMap[node.type];
    if (!symbolKind) {
      continue;
    }
    const nameNode = node.childForFieldName('name');
    const name = getNodeText(nameNode, content);
    if (!name) {
      continue;
    }
    const exported = /\bpublic\b/.test(getNodeText(node, content).split('{', 1)[0] ?? '');
    if (exported) {
      exports.add(name);
    }
    symbols.push(createSymbolRecord(name, symbolKind, exported, getLineNumber(node), getNodeText(node, content)));
  }

  return Object.freeze({
    language: 'java',
    imports: Object.freeze(imports.map((entry) => entry.specifier).slice(0, 6)),
    resolvedImports: Object.freeze([]),
    resolvedImportRecords: Object.freeze([]),
    exports: Object.freeze([...exports].slice(0, 8)),
    symbols: Object.freeze(symbols.slice(0, 24)),
  });
}

function extractSyntaxData(languageId: TreeSitterLanguageId, content: string, rootNode: Parser.SyntaxNode): ParsedSyntaxData {
  switch (languageId) {
    case 'python':
      return extractPythonData(content, rootNode);
    case 'go':
      return extractGoData(content, rootNode);
    case 'rust':
      return extractRustData(content, rootNode);
    case 'java':
      return extractJavaData(content, rootNode);
  }
}

function extractPythonCodeUnits(content: string, rootNode: Parser.SyntaxNode): readonly TreeSitterCodeUnit[] {
  const units: TreeSitterCodeUnit[] = [];
  for (const node of rootNode.namedChildren) {
    if (node.type !== 'class_definition' && node.type !== 'function_definition') {
      continue;
    }
    const name = getNodeText(node.childForFieldName('name'), content);
    if (!name) {
      continue;
    }
    units.push(createCodeUnit(node, content, name, node.type === 'class_definition' ? 'class' : 'function', false));
  }
  return Object.freeze(units.slice(0, 24));
}

function extractGoCodeUnits(content: string, rootNode: Parser.SyntaxNode): readonly TreeSitterCodeUnit[] {
  const units: TreeSitterCodeUnit[] = [];
  for (const node of rootNode.namedChildren) {
    if (node.type === 'function_declaration' || node.type === 'method_declaration') {
      const name = getNodeText(node.childForFieldName('name'), content);
      if (!name) {
        continue;
      }
      units.push(createCodeUnit(node, content, name, 'function', /^[A-Z]/.test(name)));
      continue;
    }
    if (node.type === 'type_declaration') {
      for (const typeSpec of node.descendantsOfType('type_spec')) {
        const name = getNodeText(typeSpec.childForFieldName('name'), content);
        if (!name) {
          continue;
        }
        const typeNode = typeSpec.childForFieldName('type');
        const kind: SyntaxSymbolKind =
          typeNode?.type === 'struct_type'
            ? 'class'
            : typeNode?.type === 'interface_type'
              ? 'interface'
              : 'type';
        units.push(createCodeUnit(typeSpec, content, name, kind, /^[A-Z]/.test(name)));
      }
      continue;
    }
    if (node.type === 'const_declaration' || node.type === 'var_declaration') {
      const kind: SyntaxSymbolKind = node.type === 'const_declaration' ? 'const' : 'variable';
      for (const child of node.namedChildren.filter((candidate) => candidate.type === 'const_spec' || candidate.type === 'var_spec')) {
        const names = child.namedChildren.filter((candidate) => candidate.type === 'identifier');
        for (const identifier of names) {
          const name = getNodeText(identifier, content);
          if (!name) {
            continue;
          }
          units.push(createCodeUnit(child, content, name, kind, /^[A-Z]/.test(name)));
        }
      }
    }
  }
  return Object.freeze(units.slice(0, 24));
}

function extractRustCodeUnits(content: string, rootNode: Parser.SyntaxNode): readonly TreeSitterCodeUnit[] {
  const units: TreeSitterCodeUnit[] = [];
  const kindMap: Partial<Record<string, SyntaxSymbolKind>> = {
    function_item: 'function',
    struct_item: 'class',
    enum_item: 'enum',
    trait_item: 'interface',
    type_item: 'type',
    const_item: 'const',
    static_item: 'variable',
  };
  for (const node of rootNode.namedChildren) {
    const kind = kindMap[node.type];
    if (!kind) {
      continue;
    }
    const name = getNodeText(node.childForFieldName('name'), content);
    if (!name) {
      continue;
    }
    units.push(createCodeUnit(node, content, name, kind, /\bpub\b/.test(getNodeText(node, content).split('{', 1)[0] ?? '')));
  }
  return Object.freeze(units.slice(0, 24));
}

function extractJavaCodeUnits(content: string, rootNode: Parser.SyntaxNode): readonly TreeSitterCodeUnit[] {
  const units: TreeSitterCodeUnit[] = [];
  const kindMap: Partial<Record<string, SyntaxSymbolKind>> = {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    annotation_type_declaration: 'type',
    method_declaration: 'function',
  };
  for (const node of rootNode.namedChildren) {
    const kind = kindMap[node.type];
    if (!kind) {
      continue;
    }
    const name = getNodeText(node.childForFieldName('name'), content);
    if (!name) {
      continue;
    }
    units.push(createCodeUnit(node, content, name, kind, /\bpublic\b/.test(getNodeText(node, content).split('{', 1)[0] ?? '')));
  }
  return Object.freeze(units.slice(0, 24));
}

function extractTreeSitterCodeUnitsFromRoot(
  languageId: TreeSitterLanguageId,
  content: string,
  rootNode: Parser.SyntaxNode,
): readonly TreeSitterCodeUnit[] {
  switch (languageId) {
    case 'python':
      return extractPythonCodeUnits(content, rootNode);
    case 'go':
      return extractGoCodeUnits(content, rootNode);
    case 'rust':
      return extractRustCodeUnits(content, rootNode);
    case 'java':
      return extractJavaCodeUnits(content, rootNode);
  }
}

export async function extractTreeSitterCodeUnits(opts: {
  relativePath: string;
  content: string;
}): Promise<readonly TreeSitterCodeUnit[]> {
  const languageId = getTreeSitterLanguageId(opts.relativePath);
  if (!languageId) {
    return Object.freeze([]);
  }

  await ensureParserInit();
  const language = await loadLanguage(languageId);
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(opts.content);
    if (!tree) {
      return Object.freeze([]);
    }
    const units = extractTreeSitterCodeUnitsFromRoot(languageId, opts.content, tree.rootNode);
    tree.delete();
    return units;
  } catch {
    return Object.freeze([]);
  } finally {
    parser.delete();
  }
}

export async function parseTreeSitterSourceFile(opts: {
  relativePath: string;
  content: string;
  mtimeMs: number;
}): Promise<SyntaxFileRecord | null> {
  const languageId = getTreeSitterLanguageId(opts.relativePath);
  if (!languageId) {
    return null;
  }

  await ensureParserInit();
  const language = await loadLanguage(languageId);
  const parser = new Parser();

  try {
    parser.setLanguage(language);
    const tree = parser.parse(opts.content);
    if (!tree) {
      return null;
    }
    const parsed = extractSyntaxData(languageId, opts.content, tree.rootNode);
    tree.delete();
    return Object.freeze({
      relativePath: opts.relativePath,
      language: parsed.language,
      mtimeMs: opts.mtimeMs,
      imports: parsed.imports,
      resolvedImports: parsed.resolvedImports,
      resolvedImportRecords: parsed.resolvedImportRecords,
      exports: parsed.exports,
      symbols: parsed.symbols,
      indexedAt: Date.now(),
    });
  } catch {
    return null;
  } finally {
    parser.delete();
  }
}
