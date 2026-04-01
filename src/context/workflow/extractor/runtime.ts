/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow graph snapshot building and background refresh runtime orchestration.
 */

import type {
  ParsedFile,
  SymbolUnit,
  WorkflowRefreshScheduleOptions,
  WorkflowRefreshState,
} from '../entities/extractor';
import type {
  WorkflowEdgeRecord,
  WorkflowGraphSnapshot,
  WorkflowNodeRecord,
} from '../entities/graph';
import { primeWorkflowArtifactSemanticIndex } from '../artifact-semantic';
import { syncWorkflowGraphSnapshot } from '../sync';
import { buildWorkflowArtifacts } from './artifacts';
import { extractRouteAndBoundarySeeds } from './boundaries';
import { isSupportedSourceFile, loadTypeScriptProjectConfig, resolveWorkspaceRelativePath, scanWorkspaceSourceFiles } from './files';
import { addNode, createGraphNodeFromUnit } from './nodes';
import { DEFAULT_WORKFLOW_REFRESH_DELAY_MS } from '../entities/constants';
import { parseWorkflowFile } from './units';
import { visitExecutableUnit } from './execution';

const workflowRefreshStates = new Map<string, WorkflowRefreshState>();

/**
 * Builds a full workflow graph snapshot for a workspace.
 */
export async function buildWorkflowGraphSnapshot(opts: {
  workspacePath: string;
}): Promise<WorkflowGraphSnapshot> {
  const projectConfig = loadTypeScriptProjectConfig(opts.workspacePath);
  const parsedFiles = scanWorkspaceSourceFiles(opts.workspacePath)
    .map((relativePath) => parseWorkflowFile(opts.workspacePath, relativePath, projectConfig))
    .filter((file): file is ParsedFile => Boolean(file));

  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();
  const exportedSymbolsByFile = new Map<string, ReadonlyMap<string, string>>();

  parsedFiles.forEach((parsedFile) => {
    parsedFile.units.forEach((unit) => {
      addNode(nodes, createGraphNodeFromUnit(unit));
    });
    exportedSymbolsByFile.set(
      parsedFile.relativePath,
      new Map(parsedFile.units.filter((unit) => unit.exported && unit.symbolName).map((unit) => [unit.symbolName!, unit.id] as const)),
    );
  });

  const syntheticUnits: SymbolUnit[] = [];
  parsedFiles.forEach((parsedFile) => {
    syntheticUnits.push(...extractRouteAndBoundarySeeds(parsedFile, nodes, edges, exportedSymbolsByFile));
  });

  const syntheticUnitsByFile = new Map<string, SymbolUnit[]>();
  syntheticUnits.forEach((unit) => {
    const existing = syntheticUnitsByFile.get(unit.relativePath) ?? [];
    existing.push(unit);
    syntheticUnitsByFile.set(unit.relativePath, existing);
  });

  parsedFiles.forEach((parsedFile) => {
    const combinedUnits = [...parsedFile.units, ...(syntheticUnitsByFile.get(parsedFile.relativePath) ?? [])];
    combinedUnits.forEach((unit) => {
      visitExecutableUnit(unit, parsedFile, nodes, edges, exportedSymbolsByFile);
    });
  });

  const sortedNodes = Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)));
  const sortedEdges = Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id)));
  const artifacts = buildWorkflowArtifacts({
    nodes: sortedNodes,
    edges: sortedEdges,
  });

  return Object.freeze({
    nodes: sortedNodes,
    edges: sortedEdges,
    maps: artifacts.maps,
    mapSources: artifacts.mapSources,
    traceSummaries: artifacts.traceSummaries,
  });
}

/**
 * Rebuilds and persists the workflow graph for a workspace.
 */
export async function refreshWorkflowGraph(workspacePath: string): Promise<WorkflowGraphSnapshot> {
  const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
  syncWorkflowGraphSnapshot(workspacePath, snapshot);
  void primeWorkflowArtifactSemanticIndex(workspacePath);
  return snapshot;
}

/**
 * Gets or creates mutable refresh scheduling state for a workspace.
 */
function getWorkflowRefreshState(workspacePath: string): WorkflowRefreshState {
  let existing = workflowRefreshStates.get(workspacePath);
  if (existing) {
    return existing;
  }
  existing = {
    timer: null,
    inFlight: null,
    rerunRequested: false,
  };
  workflowRefreshStates.set(workspacePath, existing);
  return existing;
}

/**
 * Checks whether a set of touched files should trigger workflow refresh.
 */
function hasWorkflowRelevantFilePath(workspacePath: string, filePaths: readonly string[]): boolean {
  if (filePaths.length === 0) {
    return true;
  }
  return filePaths.some((filePath) => {
    const relativePath = resolveWorkspaceRelativePath(workspacePath, filePath);
    return relativePath ? isSupportedSourceFile(relativePath) : false;
  });
}

/**
 * Executes a debounced workflow graph refresh for a workspace.
 */
async function runScheduledWorkflowGraphRefresh(workspacePath: string): Promise<WorkflowGraphSnapshot | null> {
  const state = getWorkflowRefreshState(workspacePath);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.inFlight) {
    state.rerunRequested = true;
    return state.inFlight;
  }
  state.inFlight = refreshWorkflowGraph(workspacePath)
    .catch((error) => {
      console.warn(`[galaxy] workflow graph refresh failed for ${workspacePath}: ${String(error)}`);
      return null;
    })
    .finally(() => {
      const latestState = getWorkflowRefreshState(workspacePath);
      latestState.inFlight = null;
      if (latestState.rerunRequested) {
        latestState.rerunRequested = false;
        latestState.timer = setTimeout(() => {
          void runScheduledWorkflowGraphRefresh(workspacePath);
        }, DEFAULT_WORKFLOW_REFRESH_DELAY_MS);
      }
    });
  return state.inFlight;
}

/**
 * Schedules a debounced workflow graph refresh if the touched files are relevant.
 */
export function scheduleWorkflowGraphRefresh(
  workspacePath: string,
  opts: WorkflowRefreshScheduleOptions = {},
): boolean {
  if (!opts.force && !hasWorkflowRelevantFilePath(workspacePath, opts.filePaths ?? [])) {
    return false;
  }
  const state = getWorkflowRefreshState(workspacePath);
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void runScheduledWorkflowGraphRefresh(workspacePath);
  }, Math.max(0, opts.delayMs ?? DEFAULT_WORKFLOW_REFRESH_DELAY_MS));
  return true;
}

/**
 * Flushes any pending workflow refresh immediately.
 */
export async function flushScheduledWorkflowGraphRefresh(workspacePath: string): Promise<WorkflowGraphSnapshot | null> {
  return runScheduledWorkflowGraphRefresh(workspacePath);
}
