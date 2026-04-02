/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound session synchronization and message fan-out actions extracted from the extension entrypoint.
 */

import { loadInitialMessages } from "./session-lifecycle";
import {
  getWorkspaceFiles,
  postHostMessage,
  postProviderSessionInit,
} from "./session-sync";
import { MAX_WEBVIEW_MESSAGE_COUNT } from "../shared/constants";
import type {
  ProviderSessionActionBindings,
  ProviderSessionActions,
} from "../shared/provider-session-actions";

/** Builds provider-bound session actions from provider-owned state accessors and callbacks. */
export function createProviderSessionActions(
  bindings: ProviderSessionActionBindings,
): ProviderSessionActions {
  const postMessage: ProviderSessionActions["postMessage"] = async (
    message,
  ) => {
    const targets = [
      bindings.getSidebarWebview(),
      bindings.getPanelWebview(),
    ].filter((target): target is import("vscode").Webview => target !== null);
    await postHostMessage(targets, message);
  };

  const getProviderWorkspaceFiles: ProviderSessionActions["getWorkspaceFiles"] =
    async () =>
      getWorkspaceFiles(bindings.selectedFiles, bindings.asWorkspaceRelative);

  return {
    postMessage,
    getWorkspaceFiles: getProviderWorkspaceFiles,
    postInit: async () => {
      await postProviderSessionInit({
        updateWorkbenchChrome: bindings.updateWorkbenchChrome,
        refreshExtensionToolGroups: bindings.refreshExtensionToolGroups,
        getWorkspaceFiles: getProviderWorkspaceFiles,
        buildChangeSummaryPayload: bindings.buildChangeSummaryPayload,
        refreshNativeShellViews: bindings.refreshNativeShellViews,
        postSessionInitParams: {
          projectStorage: bindings.projectStorage,
          messages: bindings.getMessages().slice(-MAX_WEBVIEW_MESSAGE_COUNT),
          selectedAgent: bindings.getSelectedAgent(),
          isRunning: bindings.getIsRunning(),
          statusText: bindings.getStatusText(),
          planItems: bindings.getPlanItems(),
          logs: [...bindings.getRuntimeLogs()],
          qualityDetails: bindings.getQualityDetails(),
          qualityPreferences: bindings.getQualityPreferences(),
          toolCapabilities: bindings.getToolCapabilities(),
          toolToggles: bindings.getToolToggles(),
          extensionToolGroups: bindings.getExtensionToolGroups(),
          extensionToolToggles: bindings.getExtensionToolToggles(),
          streamingAssistant: bindings.getStreamingAssistant() || undefined,
          streamingThinking: bindings.getStreamingThinking() || undefined,
          activeShellSessions: [...bindings.getActiveShellSessions()],
          approvalRequest: bindings.getApprovalRequest(),
          sanitizeChatMessageForWebview: bindings.sanitizeChatMessageForWebview,
          postMessage,
        },
        hasOlderMessages: bindings.getHasOlderMessages(),
      });
    },
    getEffectiveConfig: bindings.getEffectiveConfig,
    loadInitialMessages: () =>
      loadInitialMessages({
        projectStorage: bindings.projectStorage,
        setStatusText: bindings.setStatusText,
        appendLog: bindings.appendLog,
      }),
  };
}
