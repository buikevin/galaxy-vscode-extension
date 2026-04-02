/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc Shared TypeScript workflow facts reused by generic and framework-specific adapters.
 */

import type { ParsedFile, TypeScriptWorkflowExtractionContext } from '../entities/extractor';
import type { WorkflowNodeRecord } from '../entities/graph';
import { isTypeScriptWorkflowSourceFile, loadTypeScriptProjectConfig, scanWorkspaceSourceFiles } from './files';
import { addNode, createGraphNodeFromUnit } from './nodes';
import { parseWorkflowFile } from './units';

/**
 * Builds reusable parsed workflow context from TypeScript and JavaScript source files.
 *
 * @param workspacePath Absolute workspace path whose TS/JS sources should be parsed.
 * @returns Shared parsed workflow context reused by generic and framework-specific adapters.
 */
export function buildTypeScriptWorkflowExtractionContext(workspacePath: string): TypeScriptWorkflowExtractionContext {
  const projectConfig = loadTypeScriptProjectConfig(workspacePath);
  const parsedFiles = scanWorkspaceSourceFiles(workspacePath)
    .filter((relativePath) => isTypeScriptWorkflowSourceFile(relativePath))
    .map((relativePath) => parseWorkflowFile(workspacePath, relativePath, projectConfig))
    .filter((file): file is ParsedFile => Boolean(file));

  const baseNodes = new Map<string, WorkflowNodeRecord>();
  const exportedSymbolsByFile = new Map<string, ReadonlyMap<string, string>>();

  parsedFiles.forEach((parsedFile) => {
    parsedFile.units.forEach((unit) => {
      addNode(baseNodes, createGraphNodeFromUnit(unit));
    });
    exportedSymbolsByFile.set(
      parsedFile.relativePath,
      new Map(
        parsedFile.units
          .filter((unit) => unit.exported && unit.symbolName)
          .map((unit) => [unit.symbolName!, unit.id] as const),
      ),
    );
  });

  return Object.freeze({
    parsedFiles: Object.freeze(parsedFiles),
    baseNodes,
    exportedSymbolsByFile,
  });
}
