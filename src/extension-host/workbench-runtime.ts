/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Workbench-facing lifecycle helpers extracted from the extension entrypoint.
 */

import * as vscode from "vscode";
import type { AgentType } from "../shared/protocol";
import type {
  PostRunStateParams,
  PostSelectedAgentUpdateParams,
  ShowWorkbenchErrorParams,
} from "../shared/workbench-runtime";

/**
 * Loads the currently selected agent from workspace state and validates the stored value.
 *
 * @param workspaceState VS Code workspace state storage used by the provider.
 * @param storageKey Workspace-state key storing the selected agent id.
 * @param isAgentType Runtime validator for persisted agent ids.
 * @returns Persisted agent type when valid, otherwise the manual fallback.
 */
export function loadSelectedAgent(
  workspaceState: vscode.Memento,
  storageKey: string,
  isAgentType: (value: string | undefined) => value is AgentType,
): AgentType {
  const stored = workspaceState.get<string>(storageKey);
  return isAgentType(stored) ? stored : "manual";
}

/**
 * Persists the currently selected agent into workspace state.
 *
 * @param workspaceState VS Code workspace state storage used by the provider.
 * @param storageKey Workspace-state key storing the selected agent id.
 * @param selectedAgent Agent type to persist for the current workspace.
 */
export function persistSelectedAgent(
  workspaceState: vscode.Memento,
  storageKey: string,
  selectedAgent: AgentType,
): void {
  void workspaceState.update(storageKey, selectedAgent);
}

/**
 * Posts the current selected-agent state to the webview after refreshing the workbench chrome.
 *
 * @param params Workbench update callbacks and selected-agent state.
 * @returns A promise that resolves after the webview message is posted.
 */
export async function postSelectedAgentUpdate(
  params: PostSelectedAgentUpdateParams,
): Promise<void> {
  params.updateWorkbenchChrome();
  await params.postMessage({
    type: "selected-agent-updated",
    payload: { selectedAgent: params.selectedAgent },
  });
}

/**
 * Posts the current run-state payload to the webview after refreshing the workbench chrome.
 *
 * @param params Workbench update callbacks and current run-state values.
 * @returns A promise that resolves after the run-state message is posted.
 */
export async function postRunState(params: PostRunStateParams): Promise<void> {
  params.updateWorkbenchChrome();
  await params.postMessage({
    type: "run-state",
    payload: { isRunning: params.isRunning, statusText: params.statusText },
  });
}

/**
 * Reports one progress update through the active VS Code progress reporter.
 *
 * @param progressReporter Active progress reporter, if one exists.
 * @param message User-facing progress text for the current step.
 */
export function reportProgress(
  progressReporter: vscode.Progress<{ message?: string }> | null,
  message: string,
): void {
  progressReporter?.report({ message });
}

/**
 * Shows one workbench error prompt and routes follow-up actions back into the Galaxy UI.
 *
 * @param params Prompt text and callbacks used by the follow-up actions.
 */
export function showWorkbenchError(params: ShowWorkbenchErrorParams): void {
  void vscode.window
    .showErrorMessage(params.message, "Open Galaxy Code", "Show Logs")
    .then(async (selection) => {
      if (selection === "Open Galaxy Code") {
        await params.reveal();
        return;
      }

      if (selection === "Show Logs") {
        params.showLogs();
      }
    });
}
