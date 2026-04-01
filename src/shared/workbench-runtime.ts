/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for workbench and provider lifecycle helpers extracted from the extension entrypoint.
 */

import type {
  AgentType,
  HostMessage,
  PlanItem,
  QualityDetails,
} from "./protocol";

/** Parameters required to post one selected-agent update into the webview. */
export type PostSelectedAgentUpdateParams = Readonly<{
  /** Refreshes status bar items before the webview update is sent. */
  updateWorkbenchChrome: () => void;
  /** Currently selected runtime agent. */
  selectedAgent: AgentType;
  /** Posts one host message to the live Galaxy webviews. */
  postMessage: (message: HostMessage) => Promise<void>;
}>;

/** Parameters required to post one run-state update into the webview. */
export type PostRunStateParams = Readonly<{
  /** Refreshes status bar items before the run-state update is sent. */
  updateWorkbenchChrome: () => void;
  /** Whether a runtime turn is currently running. */
  isRunning: boolean;
  /** Current status text shown in the status bar and webview. */
  statusText: string;
  /** Posts one host message to the live Galaxy webviews. */
  postMessage: (message: HostMessage) => Promise<void>;
}>;

/** Parameters required to show one VS Code workbench error prompt. */
export type ShowWorkbenchErrorParams = Readonly<{
  /** Human-readable error text shown in the prompt. */
  message: string;
  /** Reveals the main Galaxy chat UI if the user chooses that action. */
  reveal: () => Promise<void>;
  /** Reveals the Galaxy output channel if the user chooses that action. */
  showLogs: () => void;
}>;

/** Parameters required to merge and post updated quality details to the webview. */
export type UpdateQualityDetailsParams = Readonly<{
  /** Current in-memory quality details snapshot. */
  qualityDetails: QualityDetails;
  /** Partial quality update coming from validation or review flows. */
  update: Partial<QualityDetails>;
  /** Stores the next merged quality details snapshot in provider state. */
  setQualityDetails: (qualityDetails: QualityDetails) => void;
  /** Posts one host message to the live Galaxy webviews. */
  postMessage: (message: HostMessage) => Promise<void>;
}>;

/** Static migration-plan items shown in the webview header. */
export type PhasePlanItems = readonly PlanItem[];
