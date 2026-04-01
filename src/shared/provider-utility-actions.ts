/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound utility actions such as clear history, composer commands, logs, telemetry, and agent selection.
 */

import type { FigmaImportRecord } from "./figma";
import type { ComposerCommandId } from "./workspace-actions";
import type { AgentType, LogEntry } from "./protocol";
import type { GalaxyWorkbenchChrome } from "./extension-host";

/** Provider-owned callbacks and state accessors required to build utility actions. */
export type ProviderUtilityActionBindings = Readonly<{
  /** Workbench chrome elements controlled by the provider runtime. */
  chrome: GalaxyWorkbenchChrome;
  /** Human-readable workspace name used by runtime logs. */
  workspaceName: string;
  /** Absolute workspace path used for telemetry summaries. */
  workspacePath: string;
  /** Returns whether a runtime turn is currently running. */
  getIsRunning: () => boolean;
  /** Returns the currently selected agent. */
  getSelectedAgent: () => AgentType;
  /** Stores the newly selected agent. */
  setSelectedAgent: (agentType: AgentType) => void;
  /** Persists the selected agent into workspace storage. */
  persistSelectedAgent: () => void;
  /** Posts the selected-agent update after the selection changes. */
  postSelectedAgentUpdate: () => Promise<void>;
  /** Applies updated quality preferences used by composer commands. */
  applyQualityPreferences: (
    next: import("./protocol").QualityPreferences,
    opts?: Readonly<{ syncVsCodeSettings?: boolean; logMessage?: string }>,
  ) => Promise<void>;
  /** Resets the provider workspace session. */
  resetWorkspaceSession: (
    opts?: import("./workspace-reset").ResetWorkspaceSessionOptions,
  ) => void;
  /** Updates the current status text shown to the user. */
  setStatusText: (statusText: string) => void;
  /** Refreshes workbench chrome after state changes. */
  updateWorkbenchChrome: () => void;
  /** Replays the full init payload into the live webview after state changes. */
  postInit: () => Promise<void>;
  /** Appends one runtime log entry. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
}>;

/** Provider-bound utility actions exposed by extracted host helpers. */
export type ProviderUtilityActions = Readonly<{
  /** Clears the current workspace session and refreshes the UI. */
  clearHistory: () => void;
  /** Appends one Figma import event to runtime logs. */
  handleFigmaImport: (record: FigmaImportRecord) => Promise<void>;
  /** Executes one composer command requested by the webview. */
  handleComposerCommand: (commandId: ComposerCommandId) => Promise<void>;
  /** Opens the hosted runtime log view. */
  openRuntimeLogs: () => Promise<void>;
  /** Opens the hosted telemetry summary view. */
  openTelemetrySummary: () => Promise<void>;
  /** Shows the provider-backed agent selection quick pick. */
  showAgentQuickPick: () => Promise<void>;
}>;
