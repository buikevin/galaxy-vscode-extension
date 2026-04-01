/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Tree-sitter syntax-index extractors for supported languages.
 */

import Parser from 'web-tree-sitter';
import type { SyntaxSymbolKind, SyntaxSymbolRecord } from '../entities/syntax-index';
import type { ParsedImportEntry, ParsedSyntaxData, TreeSitterLanguageId } from '../entities/tree-sitter';
import { createSymbolRecord, getLineNumber, getNodeText, pushImport } from './helpers';

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
      const name = getNodeText(node.childForFieldName('name'), content);
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
        const specifier = getNodeText(importSpec.childForFieldName('path'), content).replace(/^"|"$/g, '');
        pushImport(imports, specifier, getLineNumber(importSpec));
      }
      continue;
    }
    if (node.type === 'function_declaration' || node.type === 'method_declaration') {
      const name = getNodeText(node.childForFieldName('name'), content);
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
        const name = getNodeText(typeSpec.childForFieldName('name'), content);
        if (!name) {
          continue;
        }
        const typeNode = typeSpec.childForFieldName('type');
        const kind: SyntaxSymbolKind =
          typeNode?.type === 'struct_type' ? 'class' : typeNode?.type === 'interface_type' ? 'interface' : 'type';
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
        const names = child.childForFieldName('name') ? [child.childForFieldName('name')!] : child.namedChildren.filter((candidate) => candidate.type === 'identifier');
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
    if (node.type === 'use_declaration') {
      const text = getNodeText(node, content).replace(/^use\s+/, '').replace(/;$/, '').trim();
      if (text) {
        pushImport(imports, text, getLineNumber(node));
      }
      continue;
    }
    const symbolKind = kindMap[node.type];
    if (!symbolKind) {
      continue;
    }
    const name = getNodeText(node.childForFieldName('name'), content);
    if (!name) {
      continue;
    }
    const exported = /\bpub\b/.test((getNodeText(node, content).split('{', 1)[0] ?? ''));
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
  const kindMap: Partial<Record<string, SyntaxSymbolKind>> = {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    annotation_type_declaration: 'type',
    method_declaration: 'function',
  };

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
    const symbolKind = kindMap[node.type];
    if (!symbolKind) {
      continue;
    }
    const name = getNodeText(node.childForFieldName('name'), content);
    if (!name) {
      continue;
    }
    const exported = /\bpublic\b/.test((getNodeText(node, content).split('{', 1)[0] ?? ''));
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

export function extractSyntaxData(
  languageId: TreeSitterLanguageId,
  content: string,
  rootNode: Parser.SyntaxNode,
): ParsedSyntaxData {
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
