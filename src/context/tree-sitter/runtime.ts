/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Runtime bootstrapping for Tree-sitter grammars and parsers.
 */

import fs from 'node:fs';
import path from 'node:path';
import Parser from 'web-tree-sitter';
import type { TreeSitterLanguageId } from '../entities/tree-sitter';

/**
 * Resolves the actual wasm asset path across development and packaged layouts.
 */
function resolveWasmAssetPath(fileName: string): string {
  const candidates = [
    path.join(__dirname, 'wasm', fileName),
    path.join(__dirname, '..', 'wasm', fileName),
    path.join(__dirname, '..', '..', '..', 'dist', 'wasm', fileName),
    path.join(__dirname, '..', '..', '..', 'node_modules', 'web-tree-sitter', fileName),
    path.join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out', fileName),
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

/**
 * Maps a file extension to the supported Tree-sitter language id.
 */
export function getTreeSitterLanguageId(relativePath: string): TreeSitterLanguageId | null {
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

/**
 * Initializes the shared Tree-sitter runtime exactly once.
 */
export async function ensureParserInit(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({
      locateFile() {
        return TREE_SITTER_INIT_WASM_PATH;
      },
    });
  }
  await parserInitPromise;
}

/**
 * Loads one Tree-sitter language grammar and caches it.
 */
export async function loadLanguage(languageId: TreeSitterLanguageId): Promise<Parser.Language> {
  let languagePromise = languageCache.get(languageId);
  if (!languagePromise) {
    languagePromise = Parser.Language.load(LANGUAGE_WASM_PATHS[languageId]);
    languageCache.set(languageId, languagePromise);
  }
  return await languagePromise;
}

/**
 * Parses source content with the resolved Tree-sitter grammar.
 */
export async function withParsedTree<T>(
  languageId: TreeSitterLanguageId,
  content: string,
  handler: (rootNode: Parser.SyntaxNode) => T,
): Promise<T | null> {
  await ensureParserInit();
  const language = await loadLanguage(languageId);
  const parser = new Parser();

  try {
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) {
      return null;
    }
    const result = handler(tree.rootNode);
    tree.delete();
    return result;
  } catch {
    return null;
  } finally {
    parser.delete();
  }
}
