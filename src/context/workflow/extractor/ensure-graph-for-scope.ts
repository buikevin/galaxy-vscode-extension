/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-07
 * @modify date 2026-05-07
 * @desc Synchronous fallback that primes the workflow graph for a requested scope before exporters run.
 */

import { getProjectStorageInfo } from "../../project-store";
import { withRagMetadataDatabase } from "../../rag-metadata/database";
import { isSupportedSourceFile, resolveWorkspaceRelativePath } from "./files";
import {
  flushWorkflowTouchQueue,
  noteFileTouchedForGraph,
} from "./touch-queue";

/**
 * Inputs accepted by {@link ensureGraphForScope}. Mirrors the subset of view options the
 * workflow exporters care about so it can be chained directly from `createWorkflow*Tool`.
 */
export type EnsureGraphForScopeInput = Readonly<{
  /** Optional explicit entry node id (`route::POST::/api/auth/login`, `function::file#sym`, …). */
  entryNodeId?: string;
  /** Optional route path scope (e.g. `/api/auth/login`). */
  routePath?: string;
  /** Optional workspace-relative file path scope. */
  filePath?: string;
  /** Optional natural-language scope query (used only when no explicit scope is provided). */
  query?: string;
}>;

/** Result describing what {@link ensureGraphForScope} did so callers can craft helpful errors. */
export type EnsureGraphForScopeResult = Readonly<{
  /** True when the function decided to enqueue and flush at least one file. */
  primed: boolean;
  /** Number of files enqueued for the scope (0 means we relied on existing graph state). */
  enqueuedFileCount: number;
  /** True when the relevant scope rows already exist in `workflow_nodes`. */
  graphHasMatchingNodes: boolean;
  /** Optional human-readable explanation for diagnostics / error messages. */
  reason?: string;
}>;

/**
 * Ensures the workflow graph contains rows that the requested scope will need.
 *
 * Strategy by scope kind:
 * - `filePath`: enqueue with `force:true`, flush queue.
 * - `entryNodeId`: if the node row is missing, flush queue (entry may be queued from a recent read).
 * - `routePath`: if no `workflow_nodes` row matches the route, flush queue.
 * - `query`: never full-refresh — just flush whatever the queue already has.
 *
 * The function never throws: any unexpected error is captured into `reason`. Callers should
 * treat a non-primed result with `graphHasMatchingNodes:false` as a hint to surface a friendly
 * suggestion instead of a hard failure.
 *
 * @param workspacePath Absolute workspace root.
 * @param input Scope inputs (subset of the view options).
 * @returns A summary of what was done and the current matching-row state.
 */
export async function ensureGraphForScope(
  workspacePath: string,
  input: EnsureGraphForScopeInput,
): Promise<EnsureGraphForScopeResult> {
  let enqueuedFileCount = 0;
  let primed = false;
  let reason: string | undefined;

  try {
    const trimmedFile = trim(input.filePath);
    if (trimmedFile) {
      const rel = resolveWorkspaceRelativePath(workspacePath, trimmedFile);
      if (rel && isSupportedSourceFile(rel)) {
        noteFileTouchedForGraph(workspacePath, rel, { force: true });
        enqueuedFileCount += 1;
        primed = true;
      } else {
        reason = `filePath ${trimmedFile} is not a supported source file`;
      }
    }

    const trimmedRoute = trim(input.routePath);
    if (!primed && trimmedRoute) {
      if (!routeHasMatchingNode(workspacePath, trimmedRoute)) {
        primed = true;
      }
    }

    const trimmedEntry = trim(input.entryNodeId);
    if (!primed && trimmedEntry) {
      if (!entryNodeExists(workspacePath, trimmedEntry)) {
        primed = true;
      }
    }

    const trimmedQuery = trim(input.query);
    if (
      !primed &&
      !trimmedFile &&
      !trimmedRoute &&
      !trimmedEntry &&
      trimmedQuery
    ) {
      // Query-only path — flush whatever the touch queue already has so very recent reads
      // get persisted before we attempt to resolve the entry node from the graph.
      primed = true;
    }

    if (primed) {
      await flushWorkflowTouchQueue(workspacePath);
    }
  } catch (error) {
    reason = `ensureGraphForScope failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const graphHasMatchingNodes = scopeMatchesAnyNode(workspacePath, input);
  return Object.freeze({
    primed,
    enqueuedFileCount,
    graphHasMatchingNodes,
    ...(reason ? { reason } : {}),
  });
}

/** Returns true when at least one `workflow_nodes` row matches the requested scope. */
function scopeMatchesAnyNode(
  workspacePath: string,
  input: EnsureGraphForScopeInput,
): boolean {
  try {
    const trimmedEntry = trim(input.entryNodeId);
    if (trimmedEntry) {
      return entryNodeExists(workspacePath, trimmedEntry);
    }
    const trimmedRoute = trim(input.routePath);
    if (trimmedRoute) {
      return routeHasMatchingNode(workspacePath, trimmedRoute);
    }
    const trimmedFile = trim(input.filePath);
    if (trimmedFile) {
      return filePathHasMatchingNode(workspacePath, trimmedFile);
    }
    return countAnyWorkflowNodes(workspacePath) > 0;
  } catch {
    return false;
  }
}

/** Returns true when the database has a `workflow_nodes` row with the given primary key. */
function entryNodeExists(workspacePath: string, entryNodeId: string): boolean {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const storage = getProjectStorageInfo(workspacePath);
    const row = db
      .prepare(
        `SELECT 1 AS hit FROM workflow_nodes WHERE workspace_id = ? AND id = ? LIMIT 1`,
      )
      .get(storage.workspaceId, entryNodeId) as { hit: number } | undefined;
    return Boolean(row);
  });
}

/** Returns true when at least one `workflow_nodes` row matches the requested route path. */
function routeHasMatchingNode(
  workspacePath: string,
  routePath: string,
): boolean {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const storage = getProjectStorageInfo(workspacePath);
    const lowered = routePath.toLowerCase();
    const row = db
      .prepare(
        `SELECT 1 AS hit FROM workflow_nodes WHERE workspace_id = ? AND route_path_lower = ? LIMIT 1`,
      )
      .get(storage.workspaceId, lowered) as { hit: number } | undefined;
    return Boolean(row);
  });
}

/** Returns true when at least one `workflow_nodes` row matches the requested file path. */
function filePathHasMatchingNode(
  workspacePath: string,
  filePath: string,
): boolean {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const storage = getProjectStorageInfo(workspacePath);
    const rel =
      resolveWorkspaceRelativePath(workspacePath, filePath) ?? filePath;
    const row = db
      .prepare(
        `SELECT 1 AS hit FROM workflow_nodes WHERE workspace_id = ? AND file_path = ? LIMIT 1`,
      )
      .get(storage.workspaceId, rel) as { hit: number } | undefined;
    return Boolean(row);
  });
}

/** Returns the total number of workflow nodes for the workspace. */
function countAnyWorkflowNodes(workspacePath: string): number {
  return withRagMetadataDatabase(workspacePath, (db) => {
    const storage = getProjectStorageInfo(workspacePath);
    const row = db
      .prepare(
        `SELECT count(*) AS c FROM workflow_nodes WHERE workspace_id = ?`,
      )
      .get(storage.workspaceId) as { c: number };
    return row.c;
  });
}

/** Trims a string-like value and returns `undefined` when the result is empty. */
function trim(value: string | undefined): string | undefined {
  const out = String(value ?? "").trim();
  return out.length > 0 ? out : undefined;
}

/**
 * Builds a human-friendly hint suggesting the next agent action when `ensureGraphForScope`
 * could not produce a matching node. Used by the workflow export tools to return a helpful
 * `ToolResult.error` instead of throwing a raw exception.
 *
 * @param input The scope that was requested.
 * @param result The summary returned by {@link ensureGraphForScope}.
 * @returns A short imperative hint (e.g. "read the relevant feature files first").
 */
export function describeEnsureGraphFallbackHint(
  input: EnsureGraphForScopeInput,
  result: EnsureGraphForScopeResult,
): string {
  const trimmedFile = trim(input.filePath);
  const trimmedRoute = trim(input.routePath);
  const trimmedEntry = trim(input.entryNodeId);
  const trimmedQuery = trim(input.query);

  if (trimmedFile) {
    return `Workflow graph is empty for file "${trimmedFile}". Read the file with read_file (or its callers) first, then retry the export.`;
  }
  if (trimmedRoute) {
    return `Workflow graph has no node for route "${trimmedRoute}". Read the controller/handler implementing this route first (or pass filePath), then retry.`;
  }
  if (trimmedEntry) {
    return `Workflow graph has no node with id "${trimmedEntry}". Read the source file containing this symbol first, then retry.`;
  }
  if (trimmedQuery) {
    return `Workflow graph contains no entries matching query "${trimmedQuery}". Read a file from the relevant feature first (or pass filePath/routePath), then retry.`;
  }
  return result.reason ?? "Workflow graph scope could not be resolved.";
}
