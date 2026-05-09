/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc TypeScript and JavaScript workflow extractor adapter used as the reference implementation for the adapter architecture.
 */

import type {
  SymbolUnit,
  WorkflowExtractorAdapter,
  WorkflowGraphContribution,
} from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import { extractRouteAndBoundarySeeds } from '../boundaries';
import { buildSingleFileTypeScriptWorkflowExtractionContext, buildTypeScriptWorkflowExtractionContext } from '../generic-facts';
import { visitGenericExecutableUnit } from '../execution';
import { isTypeScriptWorkflowSourceFile } from '../files';

/**
 * Builds a workflow graph contribution from TypeScript and JavaScript source files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution built from generic TypeScript and JavaScript structure.
 */
async function extractTypeScriptWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const context = buildTypeScriptWorkflowExtractionContext(workspacePath);
  const nodes = new Map<string, WorkflowNodeRecord>(context.baseNodes);
  const edges = new Map<string, WorkflowEdgeRecord>();

  const syntheticUnits: SymbolUnit[] = [];
  context.parsedFiles.forEach((parsedFile) => {
    syntheticUnits.push(...extractRouteAndBoundarySeeds(parsedFile, nodes, edges, context.exportedSymbolsByFile));
  });

  const syntheticUnitsByFile = new Map<string, SymbolUnit[]>();
  syntheticUnits.forEach((unit) => {
    const existing = syntheticUnitsByFile.get(unit.relativePath) ?? [];
    existing.push(unit);
    syntheticUnitsByFile.set(unit.relativePath, existing);
  });

  context.parsedFiles.forEach((parsedFile) => {
    const combinedUnits = [...parsedFile.units, ...(syntheticUnitsByFile.get(parsedFile.relativePath) ?? [])];
    combinedUnits.forEach((unit) => {
      visitGenericExecutableUnit(unit, parsedFile, nodes, edges, context.exportedSymbolsByFile);
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Builds a single-file workflow contribution from one TypeScript/JavaScript source.
 *
 * Cross-file edges that depend on other files' exports may not resolve until those files
 * are also indexed by the per-file extractor.
 *
 * @param workspacePath Absolute workspace root path.
 * @param relativePath Workspace-relative path of the file to extract.
 * @returns Workflow graph contribution scoped to the single file (empty when unsupported).
 */
async function extractTypeScriptWorkflowGraphFromFile(
  workspacePath: string,
  relativePath: string,
): Promise<WorkflowGraphContribution> {
  const context = buildSingleFileTypeScriptWorkflowExtractionContext(workspacePath, relativePath);
  if (!context) {
    return Object.freeze({ nodes: Object.freeze([]), edges: Object.freeze([]) });
  }
  const nodes = new Map<string, WorkflowNodeRecord>(context.baseNodes);
  const edges = new Map<string, WorkflowEdgeRecord>();

  const syntheticUnits: SymbolUnit[] = [];
  context.parsedFiles.forEach((parsedFile) => {
    syntheticUnits.push(...extractRouteAndBoundarySeeds(parsedFile, nodes, edges, context.exportedSymbolsByFile));
  });

  const syntheticUnitsByFile = new Map<string, SymbolUnit[]>();
  syntheticUnits.forEach((unit) => {
    const existing = syntheticUnitsByFile.get(unit.relativePath) ?? [];
    existing.push(unit);
    syntheticUnitsByFile.set(unit.relativePath, existing);
  });

  context.parsedFiles.forEach((parsedFile) => {
    const combinedUnits = [...parsedFile.units, ...(syntheticUnitsByFile.get(parsedFile.relativePath) ?? [])];
    combinedUnits.forEach((unit) => {
      visitGenericExecutableUnit(unit, parsedFile, nodes, edges, context.exportedSymbolsByFile);
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Reference workflow extractor adapter for the current TypeScript and JavaScript implementation.
 */
export const typeScriptWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'typescript',
  label: 'TypeScript / JavaScript',
  extract: extractTypeScriptWorkflowGraph,
  supportsFile: isTypeScriptWorkflowSourceFile,
  extractFromFile: extractTypeScriptWorkflowGraphFromFile,
});
