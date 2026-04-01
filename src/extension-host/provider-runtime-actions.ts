/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound runtime actions covering tracked changes, approvals, logs, and quality detail updates.
 */

import { requestToolApproval } from "./approval-workflow";
import { appendRuntimeLog } from "./message-runtime";
import {
  revertAllTrackedChanges,
  revertTrackedFileChange,
} from "./tracked-changes";
import { updateQualityDetails } from "./workbench-state";
import type {
  ApprovalWorkflowCallbacks,
  PendingApprovalState,
} from "../shared/extension-host";
import type { ProviderRuntimeLogBindings } from "../shared/message-runtime";
import type { TrackedChangeCallbacks } from "../shared/tracked-changes";
import type {
  ProviderRuntimeActionBindings,
  ProviderRuntimeActions,
  ProviderToolApprovalRequest,
} from "../shared/provider-runtime-actions";

/** Builds provider-bound runtime actions from provider-owned state accessors and callbacks. */
export function createProviderRuntimeActions(
  bindings: ProviderRuntimeActionBindings,
): ProviderRuntimeActions {
  const appendLog: ProviderRuntimeActions["appendLog"] = (kind, text) => {
    const runtimeLogBindings: ProviderRuntimeLogBindings = {
      createMessageId: bindings.createMessageId,
      runtimeLogs: bindings.getRuntimeLogs(),
      setRuntimeLogs: bindings.setRuntimeLogs,
      debugLogPath: bindings.debugLogPath,
      outputChannel: bindings.outputChannel,
      postMessage: bindings.postMessage,
    };
    appendRuntimeLog(runtimeLogBindings, kind, text);
  };

  const trackedChangeCallbacks: TrackedChangeCallbacks = {
    workspacePath: bindings.workspacePath,
    asWorkspaceRelative: bindings.asWorkspaceRelative,
    postMessage: bindings.postMessage,
    recordExternalEvent: bindings.recordExternalEvent,
    addMessage: bindings.addMessage,
    refreshWorkspaceFiles: bindings.refreshWorkspaceFiles,
  };

  const approvalWorkflowCallbacks: ApprovalWorkflowCallbacks = {
    hasPendingApproval: bindings.hasPendingApproval,
    createRequestId: bindings.createMessageId,
    appendLog: (_kind, text) => {
      appendLog("approval", text);
    },
    setPendingApprovalState: (state: PendingApprovalState) => {
      bindings.setPendingApprovalState(state);
    },
    updateWorkbenchChrome: bindings.updateWorkbenchChrome,
    clearPendingApprovalState: bindings.clearPendingApprovalState,
    postMessage: bindings.postMessage,
    reveal: bindings.reveal,
    showLogs: bindings.showLogs,
  };

  return {
    appendLog,
    updateQualityDetails: (next) => {
      updateQualityDetails({
        qualityDetails: bindings.getQualityDetails(),
        update: next,
        setQualityDetails: bindings.setQualityDetails,
        postMessage: bindings.postMessage,
      });
    },
    revertTrackedFileChange: async (filePath) =>
      revertTrackedFileChange(trackedChangeCallbacks, filePath),
    revertAllTrackedChanges: async () =>
      revertAllTrackedChanges(trackedChangeCallbacks),
    requestToolApproval: async (approval: ProviderToolApprovalRequest) =>
      requestToolApproval(approvalWorkflowCallbacks, approval),
  };
}
