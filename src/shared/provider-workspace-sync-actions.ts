/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound workspace file sync and change-summary actions.
 */

import type { ChangeSummary, FileItem } from "./protocol";
import type {
  FileSelectionUpdate,
  WorkspaceSyncCallbacks,
} from "./extension-host";

/** Provider-owned callbacks and state accessors required to build workspace-sync actions. */
export type ProviderWorkspaceSyncActionBindings = Readonly<{
  /** Mutable set containing the currently selected absolute file paths. */
  selectedFiles: WorkspaceSyncCallbacks["selectedFiles"];
  /** Optional native shell views that mirror files and changed files. */
  nativeShellViews: WorkspaceSyncCallbacks["nativeShellViews"];
  /** Resolves a webview-supplied file path against the workspace root. */
  resolveWorkspaceFilePath: WorkspaceSyncCallbacks["resolveWorkspaceFilePath"];
  /** Returns the latest workspace file list for the file picker. */
  getWorkspaceFiles: WorkspaceSyncCallbacks["getWorkspaceFiles"];
  /** Converts an absolute file path into a workspace-relative label. */
  asWorkspaceRelative: WorkspaceSyncCallbacks["asWorkspaceRelative"];
  /** Webview bridge used to post file and change-summary updates. */
  postMessage: WorkspaceSyncCallbacks["postMessage"];
  /** Opens the tracked diff for one changed file. */
  openTrackedDiff: WorkspaceSyncCallbacks["openTrackedDiff"];
}>;

/** Provider-bound workspace-sync actions exposed by extracted host helpers. */
export type ProviderWorkspaceSyncActions = Readonly<{
  /** Applies file selection changes from the webview and syncs native views plus webview state. */
  updateContextFileSelection: (
    updates: readonly FileSelectionUpdate[],
  ) => Promise<void>;
  /** Refreshes file selections, changed-file views, and change-summary state after workspace changes. */
  refreshWorkspaceFiles: () => Promise<void>;
  /** Builds the current session change-summary payload for the webview and tree views. */
  buildChangeSummaryPayload: () => ChangeSummary;
  /** Refreshes native shell views using optional precomputed state. */
  refreshNativeShellViews: (
    files?: readonly FileItem[],
    changeSummary?: ChangeSummary,
  ) => Promise<void>;
}>;
