/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow graph snapshot building and background refresh runtime orchestration.
 */

import type {
  WorkflowExtractorAdapter,
  WorkflowGraphSnapshotBuildOptions,
  WorkflowRefreshScheduleOptions,
  WorkflowRefreshState,
} from '../entities/extractor';
import type { WorkflowGraphSnapshot } from '../entities/graph';
import { primeWorkflowArtifactSemanticIndex } from '../artifact-semantic';
import { syncWorkflowGraphSnapshot } from '../sync';
import { electronWorkflowExtractorAdapter } from './adapters/electron';
import { expressNodeWorkflowExtractorAdapter } from './adapters/express-node';
import { flutterDartWorkflowExtractorAdapter } from './adapters/flutter-dart';
import { goWorkflowExtractorAdapter } from './adapters/go';
import { javaSpringWorkflowExtractorAdapter } from './adapters/java-spring';
import { nestWorkflowExtractorAdapter } from './adapters/nest';
import { phpLaravelWorkflowExtractorAdapter } from './adapters/php-laravel';
import { pythonFastApiWorkflowExtractorAdapter } from './adapters/python-fastapi';
import { reactTsxWorkflowExtractorAdapter } from './adapters/react-tsx';
import { rustWebWorkflowExtractorAdapter } from './adapters/rust-web';
import { tauriWorkflowExtractorAdapter } from './adapters/tauri';
import { typeScriptWorkflowExtractorAdapter } from './adapters/typescript';
import { vueSfcWorkflowExtractorAdapter } from './adapters/vue-sfc';
import { buildWorkflowArtifacts } from './artifacts';
import { isSupportedSourceFile, resolveWorkspaceRelativePath } from './files';
import { DEFAULT_WORKFLOW_REFRESH_DELAY_MS } from '../entities/constants';

const workflowRefreshStates = new Map<string, WorkflowRefreshState>();
const workflowExtractorAdapters: readonly WorkflowExtractorAdapter[] = Object.freeze([
  typeScriptWorkflowExtractorAdapter,
  reactTsxWorkflowExtractorAdapter,
  vueSfcWorkflowExtractorAdapter,
  electronWorkflowExtractorAdapter,
  flutterDartWorkflowExtractorAdapter,
  nestWorkflowExtractorAdapter,
  expressNodeWorkflowExtractorAdapter,
  goWorkflowExtractorAdapter,
  javaSpringWorkflowExtractorAdapter,
  phpLaravelWorkflowExtractorAdapter,
  pythonFastApiWorkflowExtractorAdapter,
  rustWebWorkflowExtractorAdapter,
  tauriWorkflowExtractorAdapter,
]);

/**
 * Builds a full workflow graph snapshot for a workspace.
 *
 * @param opts Snapshot build options for the target workspace.
 * @returns Immutable graph snapshot enriched with workflow artifacts.
 */
export async function buildWorkflowGraphSnapshot(
  opts: WorkflowGraphSnapshotBuildOptions,
): Promise<WorkflowGraphSnapshot> {
  const contributions = await Promise.all(workflowExtractorAdapters.map((adapter) => adapter.extract(opts.workspacePath)));
  const sortedNodes = Object.freeze(
    contributions
      .flatMap((contribution) => contribution.nodes)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  const sortedEdges = Object.freeze(
    contributions
      .flatMap((contribution) => contribution.edges)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
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
 *
 * @param workspacePath Absolute workspace path whose graph should be rebuilt.
 * @returns Freshly rebuilt immutable workflow graph snapshot.
 */
export async function refreshWorkflowGraph(workspacePath: string): Promise<WorkflowGraphSnapshot> {
  const snapshot = await buildWorkflowGraphSnapshot({ workspacePath });
  syncWorkflowGraphSnapshot(workspacePath, snapshot);
  void primeWorkflowArtifactSemanticIndex(workspacePath);
  return snapshot;
}

/**
 * Gets or creates mutable refresh scheduling state for a workspace.
 *
 * @param workspacePath Absolute workspace path that owns the scheduler state.
 * @returns Mutable scheduler state reused across refresh requests.
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
 *
 * @param workspacePath Absolute workspace path used for relative path resolution.
 * @param filePaths Absolute or workspace-local file paths touched by the current change.
 * @returns True when the change should refresh workflow graph artifacts.
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
 *
 * @param workspacePath Absolute workspace path whose refresh queue should run.
 * @returns Latest in-flight or newly scheduled workflow graph snapshot.
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
 *
 * @param workspacePath Absolute workspace path whose graph should be refreshed.
 * @param opts Debounce and file-scope options for the refresh request.
 * @returns True when a refresh was queued or updated.
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
 *
 * @param workspacePath Absolute workspace path whose pending refresh should run now.
 * @returns Latest graph snapshot or null when refresh failed.
 */
export async function flushScheduledWorkflowGraphRefresh(workspacePath: string): Promise<WorkflowGraphSnapshot | null> {
  return runScheduledWorkflowGraphRefresh(workspacePath);
}
