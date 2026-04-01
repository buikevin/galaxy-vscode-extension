/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc User-facing workspace actions such as logs, telemetry, and agent switching extracted from the extension host entrypoint.
 */

import * as vscode from "vscode";
import { getAgentConfig, getConfigDir, loadConfig } from "../config/manager";
import {
  formatTelemetrySummary,
  loadTelemetrySummary,
} from "../context/telemetry";
import { AGENT_TYPES } from "../shared/constants";
import type {
  GalaxyWorkbenchChrome,
  AgentQuickPickCallbacks,
} from "../shared/extension-host";
import { refreshExtensionToolGroups as refreshExtensionToolCatalog } from "./extension-tool-catalog";
import type {
  HandleComposerCommandParams,
  OpenRuntimeLogsParams,
  OpenTelemetrySummaryParams,
  RefreshExtensionToolGroupsParams,
  ShowAgentQuickPickParams,
} from "../shared/workspace-actions";
import { getAgentLabel, openGalaxyConfigDir } from "./utils";

/** Opens the Galaxy output channel and prints a short runtime-log header. */
export async function openRuntimeLogs(
  chrome: GalaxyWorkbenchChrome,
  workspaceName: string,
): Promise<void> {
  chrome.outputChannel.appendLine("");
  chrome.outputChannel.appendLine(
    `[Galaxy Code] Runtime logs for ${workspaceName}`,
  );
  chrome.outputChannel.appendLine(
    "[Galaxy Code] Use the VS Code Terminal for live command output.",
  );
  chrome.outputChannel.show(true);
}

/** Loads and prints the persisted telemetry summary for the current workspace. */
export async function openTelemetrySummary(
  chrome: GalaxyWorkbenchChrome,
  workspacePath: string,
): Promise<void> {
  const summary = loadTelemetrySummary(workspacePath);
  chrome.outputChannel.appendLine("");
  chrome.outputChannel.appendLine(formatTelemetrySummary(summary));
  chrome.outputChannel.show(true);
}

/** Shows the agent quick pick and persists the newly selected agent. */
export async function showAgentQuickPick(
  callbacks: AgentQuickPickCallbacks,
): Promise<void> {
  if (callbacks.isRunning()) {
    vscode.window.showInformationMessage(
      "Galaxy Code is currently running. Switch the agent after the current turn finishes.",
    );
    return;
  }

  const selectedAgent = callbacks.getSelectedAgent();
  const config = loadConfig();
  const quickPickItems = AGENT_TYPES.map((agentType) => {
    const agentConfig = getAgentConfig(config, agentType);
    const detail =
      [agentConfig?.model?.trim(), agentConfig?.baseUrl?.trim()]
        .filter((value): value is string => Boolean(value))
        .join(" · ") || "Configured in ~/.galaxy/config.json";

    return Object.freeze({
      label: getAgentLabel(agentType),
      description: agentType === selectedAgent ? "Current" : "",
      detail,
      agentType,
    });
  });

  const selection = await vscode.window.showQuickPick(quickPickItems, {
    title: "Galaxy Code Agent",
    placeHolder: "Select the agent for the next Galaxy Code run",
    ignoreFocusOut: true,
  });

  if (!selection || selection.agentType === selectedAgent) {
    return;
  }

  callbacks.setSelectedAgent(selection.agentType);
  callbacks.persistSelectedAgent();
  await callbacks.postSelectedAgentUpdate();
  callbacks.appendLog(
    "info",
    `Selected agent changed to ${selection.agentType}.`,
  );
}

/** Refreshes cached extension tool groups from provider-owned state. */
export function refreshProviderExtensionToolGroups(
  params: RefreshExtensionToolGroupsParams,
): void {
  params.setExtensionToolGroups(
    refreshExtensionToolCatalog(params.extensionId),
  );
}

/** Opens runtime logs using provider-owned state. */
export async function openProviderRuntimeLogs(
  params: OpenRuntimeLogsParams,
): Promise<void> {
  await openRuntimeLogs(params.chrome, params.workspaceName);
}

/** Opens telemetry summary using provider-owned state. */
export async function openProviderTelemetrySummary(
  params: OpenTelemetrySummaryParams,
): Promise<void> {
  await openTelemetrySummary(params.chrome, params.workspacePath);
}

/** Shows the agent quick pick using provider-owned state. */
export async function showProviderAgentQuickPick(
  params: ShowAgentQuickPickParams,
): Promise<void> {
  await showAgentQuickPick(params);
}

/**
 * Handles one user-facing composer command from the Galaxy webview.
 *
 * @param params Composer command id plus provider-bound action callbacks.
 * @returns A promise that resolves after the requested action completes.
 */
export async function handleComposerCommand(
  params: HandleComposerCommandParams,
): Promise<void> {
  if (params.commandId === "config") {
    loadConfig();
    await openGalaxyConfigDir(getConfigDir());
    params.appendLog(
      "info",
      `Opened Galaxy config directory: ${getConfigDir()}`,
    );
    return;
  }

  if (params.commandId === "reset") {
    await params.applyQualityPreferences(
      Object.freeze({
        reviewEnabled: false,
        validateEnabled: false,
        fullAccessEnabled: false,
      }),
      {
        syncVsCodeSettings: true,
      },
    );
    params.appendLog(
      "info",
      "Reset config: review=false, validate=false, fullAccess=false.",
    );
    return;
  }

  params.resetWorkspaceSession({ removeProjectDir: true });
  params.setStatusText("Workspace cleared");
  params.appendLog(
    "info",
    `Cleared current workspace storage under ${getConfigDir()}/projects.`,
  );
  await params.postInit();
}
