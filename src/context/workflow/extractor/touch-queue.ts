/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-07
 * @modify date 2026-05-07
 * @desc Workspace-scoped debounced queue that funnels per-file workflow graph extraction requests.
 */

import { extractWorkflowForFile } from './file-extractor';
import { resolveWorkspaceRelativePath } from './files';

/**
 * Options controlling how a file touch is queued for workflow graph indexing.
 */
export type NoteFileTouchedForGraphOptions = Readonly<{
  /** Force re-extraction even when the cached source hash matches. */
  force?: boolean;
  /** Override the default debounce delay in milliseconds for this batch. */
  delayMs?: number;
}>;

type TouchEntry = Readonly<{ force: boolean }>;

type WorkspaceTouchState = {
  pending: Map<string, TouchEntry>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  rerunRequested: boolean;
};

const DEFAULT_DEBOUNCE_MS = 500;
const MAX_BATCH_SIZE = 25;
const states = new Map<string, WorkspaceTouchState>();

/**
 * Returns or lazily creates the per-workspace touch state.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Mutable scheduler state shared across enqueue calls.
 */
function getState(workspacePath: string): WorkspaceTouchState {
  let existing = states.get(workspacePath);
  if (existing) {
    return existing;
  }
  existing = { pending: new Map(), timer: null, inFlight: null, rerunRequested: false };
  states.set(workspacePath, existing);
  return existing;
}

/**
 * Drains the pending queue by invoking `extractWorkflowForFile` for each batched file.
 *
 * Errors from individual files are swallowed and logged so the queue keeps draining.
 *
 * @param workspacePath Absolute workspace root path whose queue should be processed.
 */
async function drainQueue(workspacePath: string): Promise<void> {
  const state = getState(workspacePath);
  while (state.pending.size > 0) {
    const batch: Array<[string, TouchEntry]> = [];
    for (const entry of state.pending.entries()) {
      batch.push(entry);
      if (batch.length >= MAX_BATCH_SIZE) {
        break;
      }
    }
    batch.forEach(([relPath]) => state.pending.delete(relPath));
    for (const [relPath, info] of batch) {
      try {
        await extractWorkflowForFile(workspacePath, relPath, info.force ? { force: true } : {});
      } catch (error) {
        console.warn(
          `[galaxy] workflow per-file extraction failed for ${workspacePath} :: ${relPath}: ${String(error)}`,
        );
      }
    }
  }
}

/**
 * Schedules a debounced run of the queue worker, ensuring single in-flight per workspace.
 *
 * @param workspacePath Absolute workspace root path whose queue should run.
 * @param delayMs Debounce delay in milliseconds before draining.
 */
function scheduleRun(workspacePath: string, delayMs: number): void {
  const state = getState(workspacePath);
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.inFlight) {
      state.rerunRequested = true;
      return;
    }
    state.inFlight = drainQueue(workspacePath)
      .catch((error) => {
        console.warn(
          `[galaxy] workflow touch queue drain failed for ${workspacePath}: ${String(error)}`,
        );
      })
      .finally(() => {
        state.inFlight = null;
        if (state.rerunRequested || state.pending.size > 0) {
          state.rerunRequested = false;
          scheduleRun(workspacePath, DEFAULT_DEBOUNCE_MS);
        }
      });
  }, Math.max(0, delayMs));
}

/**
 * Enqueues a file for per-file workflow graph extraction (debounced, deduplicated).
 *
 * Files outside the workspace or with unsupported extensions are silently dropped at
 * extraction time. The call returns immediately and never throws.
 *
 * @param workspacePath Absolute workspace root path.
 * @param filePath Absolute or workspace-relative path of the file the agent just touched.
 * @param opts Optional flags such as `force` (write tools) or `delayMs` override.
 */
export function noteFileTouchedForGraph(
  workspacePath: string,
  filePath: string,
  opts: NoteFileTouchedForGraphOptions = {},
): void {
  if (!workspacePath || !filePath) {
    return;
  }
  const relativePath = resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!relativePath) {
    return;
  }
  const state = getState(workspacePath);
  const previous = state.pending.get(relativePath);
  state.pending.set(relativePath, {
    force: Boolean(previous?.force) || Boolean(opts.force),
  });
  scheduleRun(workspacePath, opts.delayMs ?? DEFAULT_DEBOUNCE_MS);
}

/**
 * Awaits any in-flight queue drain for a workspace, useful before tools that read the graph.
 *
 * Also flushes a pending debounce timer so callers do not have to wait for it.
 *
 * @param workspacePath Absolute workspace root path whose queue should be flushed.
 */
export async function flushWorkflowTouchQueue(workspacePath: string): Promise<void> {
  const state = getState(workspacePath);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.pending.size > 0 && !state.inFlight) {
    state.inFlight = drainQueue(workspacePath).finally(() => {
      state.inFlight = null;
    });
  }
  if (state.inFlight) {
    await state.inFlight;
  }
}

/**
 * Resets all queue state. Intended for tests; not used in production code.
 */
export function _resetWorkflowTouchQueueForTests(): void {
  states.forEach((state) => {
    if (state.timer) {
      clearTimeout(state.timer);
    }
  });
  states.clear();
}
