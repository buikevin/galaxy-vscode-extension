/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Tree-sitter code-unit extractors for semantic chunking.
 */

import Parser from 'web-tree-sitter';
import type { SyntaxSymbolKind } from '../entities/syntax-index';
import type { TreeSitterCodeUnit, TreeSitterLanguageId } from '../entities/tree-sitter';
import { createCodeUnit, getNodeText } from './helpers';

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
          typeNode?.type === 'struct_type' ? 'class' : typeNode?.type === 'interface_type' ? 'interface' : 'type';
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
    units.push(createCodeUnit(node, content, name, kind, /\bpub\b/.test((getNodeText(node, content).split('{', 1)[0] ?? ''))));
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
    units.push(createCodeUnit(node, content, name, kind, /\bpublic\b/.test((getNodeText(node, content).split('{', 1)[0] ?? ''))));
  }
  return Object.freeze(units.slice(0, 24));
}

export function extractTreeSitterCodeUnitsFromRoot(
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
  return Object.freeze([]);
}
