/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound workbench chrome and runtime UI actions extracted from the extension host entrypoint.
 */

import { updateWorkbenchChrome } from "./workbench-state";
import {
  postRunState,
  postSelectedAgentUpdate,
  reportProgress,
  showWorkbenchError,
} from "./workbench-runtime";
import type {
  ProviderWorkbenchActionBindings,
  ProviderWorkbenchActions,
} from "../shared/provider-workbench-actions";

/** Builds provider-bound workbench actions from provider-owned state accessors and callbacks. */
export function createProviderWorkbenchActions(
  bindings: ProviderWorkbenchActionBindings,
): ProviderWorkbenchActions {
  const updateChrome: ProviderWorkbenchActions["updateWorkbenchChrome"] =
    () => {
      updateWorkbenchChrome({
        chrome: bindings.chrome,
        isRunning: bindings.getIsRunning(),
        statusText: bindings.getStatusText(),
        selectedAgent: bindings.getSelectedAgent(),
        pendingApprovalRequestId: bindings.getPendingApprovalRequestId(),
        pendingApprovalTitle: bindings.getPendingApprovalTitle(),
        qualityPreferences: bindings.getQualityPreferences(),
      });
    };

  return {
    updateWorkbenchChrome: updateChrome,
    postSelectedAgentUpdate: async () => {
      await postSelectedAgentUpdate({
        updateWorkbenchChrome: updateChrome,
        selectedAgent: bindings.getSelectedAgent(),
        postMessage: bindings.postMessage,
      });
    },
    postRunState: async () => {
      await postRunState({
        updateWorkbenchChrome: updateChrome,
        isRunning: bindings.getIsRunning(),
        statusText: bindings.getStatusText(),
        postMessage: bindings.postMessage,
      });
    },
    reportProgress: (message) => {
      reportProgress(bindings.getProgressReporter(), message);
    },
    showWorkbenchError: (message) => {
      showWorkbenchError({
        message,
        reveal: bindings.reveal,
        showLogs: bindings.showLogs,
      });
    },
  };
}
