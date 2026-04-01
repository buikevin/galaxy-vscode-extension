/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound workbench chrome and runtime UI actions.
 */

import type * as vscode from "vscode";
import type { AgentType, LogEntry, QualityPreferences } from "./protocol";

/** Provider-owned callbacks and state accessors required to build workbench actions. */
export type ProviderWorkbenchActionBindings = Readonly<{
  /** Workbench chrome elements controlled by the provider runtime. */
  chrome: Readonly<{
    outputChannel: vscode.OutputChannel;
    runStatusItem: vscode.StatusBarItem;
    agentStatusItem: vscode.StatusBarItem;
    approvalStatusItem: vscode.StatusBarItem;
  }>;
  /** Returns whether a runtime turn is currently running. */
  getIsRunning: () => boolean;
  /** Returns the current user-facing status text. */
  getStatusText: () => string;
  /** Returns the currently selected agent. */
  getSelectedAgent: () => AgentType;
  /** Returns the currently pending approval request id, if any. */
  getPendingApprovalRequestId: () => string | null;
  /** Returns the currently pending approval title, if any. */
  getPendingApprovalTitle: () => string | null;
  /** Returns the current quality preference snapshot. */
  getQualityPreferences: () => QualityPreferences;
  /** Returns the current active progress reporter, if any. */
  getProgressReporter: () => vscode.Progress<{ message?: string }> | null;
  /** Posts one host message back into the live Galaxy webviews. */
  postMessage: (message: { type: string; payload: unknown }) => Promise<void>;
  /** Reveals the main Galaxy UI when the user requests it from an error prompt. */
  reveal: () => Promise<void>;
  /** Opens the Galaxy output channel when the user requests logs. */
  showLogs: () => void;
  /** Runtime log sink used for optional status reporting by callers. */
  appendLog?: (kind: LogEntry["kind"], text: string) => void;
}>;

/** Provider-bound workbench and runtime UI actions exposed by extracted host helpers. */
export type ProviderWorkbenchActions = Readonly<{
  /** Applies the current run, agent, and approval state to the VS Code status bar. */
  updateWorkbenchChrome: () => void;
  /** Posts the current selected-agent state to the webview after refreshing the chrome. */
  postSelectedAgentUpdate: () => Promise<void>;
  /** Posts the current run-state payload to the webview after refreshing the chrome. */
  postRunState: () => Promise<void>;
  /** Reports one progress update through the active VS Code progress reporter. */
  reportProgress: (message: string) => void;
  /** Shows one workbench error prompt and routes follow-up actions back into Galaxy UI. */
  showWorkbenchError: (message: string) => void;
}>;
