/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound utility actions extracted from the extension host entrypoint.
 */

import {
  handleComposerCommand,
  openProviderRuntimeLogs,
  openProviderTelemetrySummary,
  showProviderAgentQuickPick,
} from "./workspace-actions";
import type {
  ProviderUtilityActionBindings,
  ProviderUtilityActions,
} from "../shared/provider-utility-actions";

/** Builds provider-bound utility actions from provider-owned state accessors and callbacks. */
export function createProviderUtilityActions(
  bindings: ProviderUtilityActionBindings,
): ProviderUtilityActions {
  return {
    clearHistory: () => {
      bindings.resetWorkspaceSession();
      bindings.setStatusText("Session cleared");
      bindings.appendLog(
        "info",
        "Session history and runtime state were cleared.",
      );
      bindings.updateWorkbenchChrome();
      void bindings.postInit();
    },
    handleFigmaImport: async (record) => {
      bindings.appendLog("info", `Received Figma import ${record.importId}.`);
    },
    handleComposerCommand: async (commandId) => {
      await handleComposerCommand({
        commandId,
        appendLog: bindings.appendLog,
        applyQualityPreferences: bindings.applyQualityPreferences,
        resetWorkspaceSession: bindings.resetWorkspaceSession,
        setStatusText: bindings.setStatusText,
        postInit: bindings.postInit,
      });
    },
    openRuntimeLogs: async () => {
      await openProviderRuntimeLogs({
        chrome: bindings.chrome,
        workspaceName: bindings.workspaceName,
      });
    },
    openTelemetrySummary: async () => {
      await openProviderTelemetrySummary({
        chrome: bindings.chrome,
        workspacePath: bindings.workspacePath,
      });
    },
    showAgentQuickPick: async () => {
      await showProviderAgentQuickPick({
        isRunning: bindings.getIsRunning,
        getSelectedAgent: bindings.getSelectedAgent,
        setSelectedAgent: bindings.setSelectedAgent,
        persistSelectedAgent: bindings.persistSelectedAgent,
        postSelectedAgentUpdate: bindings.postSelectedAgentUpdate,
        appendLog: bindings.appendLog,
      });
    },
  };
}
