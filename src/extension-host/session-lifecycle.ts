/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Session lifecycle helpers extracted from the extension entrypoint.
 */

import {
  appendUiTranscriptMessage,
  clearUiTranscript,
  loadInitialUiTranscriptBatch,
  loadOlderUiTranscriptBatch,
} from "../context/ui-transcript-store";
import { loadProjectMeta, saveProjectMeta } from "../context/project-store";
import type { ChatMessage } from "../shared/protocol";
import type {
  LoadInitialMessagesParams,
  LoadedInitialMessagesResult,
  PersistProjectMetaPatchParams,
  ProviderWorkspaceResetBindings,
  ResetProviderWorkspaceSessionParams,
  ResetWorkspaceSessionOptions,
} from "../shared/session-lifecycle";
import { resetWorkspaceSession } from "./workspace-reset";

/**
 * Loads the initial transcript messages for the current workspace and logs the recovery outcome.
 *
 * @param params Project storage and UI callbacks required to restore transcript state.
 * @returns Restored transcript messages, or an empty array for a fresh session.
 */
export function loadInitialMessages(
  params: LoadInitialMessagesParams,
): LoadedInitialMessagesResult {
  const transcript = loadInitialUiTranscriptBatch(params.projectStorage.uiTranscriptPath, {
    maxMessages: 200,
  });
  if (transcript.messages.length > 0) {
    params.setStatusText(`Resumed ${transcript.messages.length} messages`);
    params.appendLog(
      "info",
      `Resumed ${transcript.messages.length} transcript messages for this workspace.`,
    );
    return Object.freeze({
      messages: Object.freeze([...transcript.messages]),
      hasOlderMessages: transcript.hasOlderMessages,
    });
  }

  params.appendLog("info", "Started a fresh Galaxy Code VS Code session.");
  return Object.freeze({
    messages: Object.freeze([]),
    hasOlderMessages: false,
  });
}

export function loadOlderTranscriptMessages(
  projectStorage: PersistProjectMetaPatchParams["projectStorage"],
  opts?: Readonly<{
    oldestMessageId?: string;
    batchSize?: number;
  }>,
): Readonly<{
  messages: readonly ChatMessage[];
  hasOlderMessages: boolean;
}> {
  return loadOlderUiTranscriptBatch(projectStorage.uiTranscriptPath, opts);
}

/**
 * Appends one transcript message to the persisted UI transcript log.
 *
 * @param projectStorage Project storage info containing the transcript path.
 * @param message Transcript message to persist.
 */
export function appendTranscriptMessage(
  projectStorage: PersistProjectMetaPatchParams["projectStorage"],
  message: ChatMessage,
): void {
  appendUiTranscriptMessage(projectStorage.uiTranscriptPath, message);
}

/**
 * Applies one pure mutation to the persisted project metadata snapshot.
 *
 * @param params Project storage info and pure meta mutation callback.
 */
export function persistProjectMetaPatch(
  params: PersistProjectMetaPatchParams,
): void {
  const previousMeta = loadProjectMeta(params.projectStorage);
  saveProjectMeta(params.projectStorage, params.mutate(previousMeta));
}

/**
 * Builds reset-session callbacks from provider-owned mutable state bindings.
 *
 * @param bindings Provider-owned mutable state and reset helpers.
 * @returns Reset-session params ready for `resetProviderWorkspaceSession`.
 */
export function buildResetProviderWorkspaceSessionParams(
  bindings: ProviderWorkspaceResetBindings,
): ResetProviderWorkspaceSessionParams {
  return {
    workspacePath: bindings.workspacePath,
    projectStorage: bindings.projectStorage,
    historyManager: bindings.historyManager,
    recreateProjectStorageState: bindings.recreateProjectStorageState,
    clearActionApprovals: bindings.clearActionApprovals,
    clearRuntimeSession: bindings.clearRuntimeSession,
    resetRuntimeLogs: () => {
      bindings.setRuntimeLogs([]);
    },
    resetQualityDetails: () => {
      bindings.setQualityDetails(bindings.createEmptyQualityDetails());
    },
    resetMessages: () => {
      bindings.setMessages([]);
    },
    setIsRunning: bindings.setIsRunning,
    clearPendingApprovalState: bindings.clearPendingApprovalState,
    clearProgressReporter: bindings.clearProgressReporter,
    clearShellState: () => {
      bindings.activeShellSessions.clear();
      bindings.commandTerminalRegistry.clear();
    },
    clearStreamingBuffers: bindings.clearStreamingBuffers,
    updateWorkbenchChrome: bindings.updateWorkbenchChrome,
  };
}

/**
 * Resets persisted and in-memory session state for one provider instance.
 *
 * @param params Provider-bound storage paths and reset callbacks.
 * @param opts Optional reset mode controlling project-directory cleanup.
 */
export function resetProviderWorkspaceSession(
  params: ResetProviderWorkspaceSessionParams,
  opts?: ResetWorkspaceSessionOptions,
): void {
  resetWorkspaceSession(
    {
      projectDirPath: params.projectStorage.projectDirPath,
      commandContextPath: params.projectStorage.commandContextPath,
      recreateProjectStorageState: params.recreateProjectStorageState,
      clearUiTranscript: () => {
        clearUiTranscript(params.projectStorage.uiTranscriptPath);
      },
      clearHistory: () => {
        params.historyManager.clearAll();
      },
      clearActionApprovals: params.clearActionApprovals,
      clearRuntimeSession: params.clearRuntimeSession,
      resetRuntimeLogs: params.resetRuntimeLogs,
      resetQualityDetails: params.resetQualityDetails,
      resetMessages: params.resetMessages,
      setIsRunning: params.setIsRunning,
      clearPendingApprovalState: params.clearPendingApprovalState,
      clearProgressReporter: params.clearProgressReporter,
      clearShellState: params.clearShellState,
      clearStreamingBuffers: params.clearStreamingBuffers,
      updateWorkbenchChrome: params.updateWorkbenchChrome,
    },
    opts,
  );
}
