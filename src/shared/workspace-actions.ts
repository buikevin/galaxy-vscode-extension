/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for user-facing workspace action helpers extracted from the extension entrypoint.
 */

import type {
  AgentQuickPickCallbacks,
  GalaxyWorkbenchChrome,
} from "./extension-host";
import type { ExtensionToolGroup, QualityPreferences } from "./protocol";
import type { ResetWorkspaceSessionOptions } from "./workspace-reset";

/** Supported composer commands triggered by the Galaxy webview. */
export type ComposerCommandId = "config" | "reset" | "clear";

/** Parameters required to handle one composer command outside the provider class. */
export type HandleComposerCommandParams = Readonly<{
  /** Command requested by the webview composer. */
  commandId: ComposerCommandId;
  /** Appends one runtime log entry for the executed action. */
  appendLog: (
    kind: "info" | "status" | "approval" | "validation" | "review" | "error",
    text: string,
  ) => void;
  /** Applies quality preferences and optionally syncs them back to VS Code settings. */
  applyQualityPreferences: (
    next: QualityPreferences,
    opts?: Readonly<{ syncVsCodeSettings?: boolean }>,
  ) => Promise<void>;
  /** Resets the current workspace session with optional storage cleanup. */
  resetWorkspaceSession: (opts?: ResetWorkspaceSessionOptions) => void;
  /** Updates the provider status text after destructive actions complete. */
  setStatusText: (statusText: string) => void;
  /** Rebuilds and posts the initial session state snapshot. */
  postInit: () => Promise<void>;
}>;

/** Parameters required to refresh cached extension tool groups from provider-owned state. */
export type RefreshExtensionToolGroupsParams = Readonly<{
  /** Extension id used to discover local extension tool groups. */
  extensionId: string;
  /** Stores the refreshed extension tool groups in provider state. */
  setExtensionToolGroups: (groups: readonly ExtensionToolGroup[]) => void;
}>;

/** Parameters required to open runtime logs from provider-owned state. */
export type OpenRuntimeLogsParams = Readonly<{
  /** Chrome elements controlled by the host runtime. */
  chrome: GalaxyWorkbenchChrome;
  /** Current workspace name shown in the log header. */
  workspaceName: string;
}>;

/** Parameters required to open the telemetry summary from provider-owned state. */
export type OpenTelemetrySummaryParams = Readonly<{
  /** Chrome elements controlled by the host runtime. */
  chrome: GalaxyWorkbenchChrome;
  /** Absolute workspace path used to load persisted telemetry. */
  workspacePath: string;
}>;

/** Parameters required to show and persist the selected agent from provider-owned state. */
export type ShowAgentQuickPickParams = AgentQuickPickCallbacks;
