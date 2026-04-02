/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc React and TSX semantic adapter that enriches the generic TypeScript workflow graph with JSX composition edges.
 */

import type { WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord } from '../../entities/graph';
import { visitJsxCompositionUnit } from '../execution';
import { buildTypeScriptWorkflowExtractionContext } from '../generic-facts';

/**
 * Builds React-specific composition edges from TSX and JSX units.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution containing React composition edges.
 */
async function extractReactTsxWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const context = buildTypeScriptWorkflowExtractionContext(workspacePath);
  const edges = new Map<string, WorkflowEdgeRecord>();

  context.parsedFiles.forEach((parsedFile) => {
    parsedFile.units.forEach((unit) => {
      visitJsxCompositionUnit(unit, parsedFile, edges, context.exportedSymbolsByFile);
    });
  });

  return Object.freeze({
    nodes: Object.freeze([]),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for React-style JSX composition flow extraction.
 */
export const reactTsxWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'react-tsx',
  label: 'React / TSX',
  extract: extractReactTsxWorkflowGraph,
});
