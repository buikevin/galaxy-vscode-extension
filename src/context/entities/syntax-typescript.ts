/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc TypeScript parser entity types shared by syntax indexing helpers.
 */

import type * as ts from 'typescript';

/**
 * Minimal TypeScript project configuration used for module resolution.
 */
export type TypeScriptProjectConfig = Readonly<{
  /** Compiler options used by TypeScript module resolution. */
  options: ts.CompilerOptions;
}>;
