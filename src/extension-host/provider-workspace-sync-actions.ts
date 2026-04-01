/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound workspace file sync and change-summary actions extracted from the extension host entrypoint.
 */

import { createWorkspaceSyncCallbacks } from "./provider-bindings";
import {
  buildProviderChangeSummaryPayload,
  refreshProviderNativeShellViews,
  refreshWorkspaceFiles,
  updateContextFileSelection,
} from "./workspace-sync";
import type {
  ProviderWorkspaceSyncActionBindings,
  ProviderWorkspaceSyncActions,
} from "../shared/provider-workspace-sync-actions";

/** Builds provider-bound workspace-sync actions from provider-owned state accessors and callbacks. */
export function createProviderWorkspaceSyncActions(
  bindings: ProviderWorkspaceSyncActionBindings,
): ProviderWorkspaceSyncActions {
  const callbacks = createWorkspaceSyncCallbacks({
    selectedFiles: bindings.selectedFiles,
    nativeShellViews: bindings.nativeShellViews,
    resolveWorkspaceFilePath: bindings.resolveWorkspaceFilePath,
    getWorkspaceFiles: bindings.getWorkspaceFiles,
    asWorkspaceRelative: bindings.asWorkspaceRelative,
    postMessage: bindings.postMessage,
    openTrackedDiff: bindings.openTrackedDiff,
  });

  return {
    updateContextFileSelection: async (updates) =>
      updateContextFileSelection(callbacks, updates),
    refreshWorkspaceFiles: async () => refreshWorkspaceFiles(callbacks),
    buildChangeSummaryPayload: () =>
      buildProviderChangeSummaryPayload(callbacks),
    refreshNativeShellViews: async (files, changeSummary) =>
      refreshProviderNativeShellViews(callbacks, files, changeSummary),
  };
}
