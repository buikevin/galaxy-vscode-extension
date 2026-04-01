/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound session synchronization and message fan-out actions.
 */

import type { ProjectStorageInfo } from "../context/entities/project-store";
import type {
  ApprovalRequestPayload,
  ChatMessage,
  ExtensionToolGroup,
  HostMessage,
  QualityDetails,
  QualityPreferences,
  SessionInitPayload,
  ToolCapabilities,
  ToolToggles,
} from "./protocol";
import type { GalaxyConfig } from "./config";
import type { ActiveShellSessionState } from "./extension-host";
import type { ChangeSummary, FileItem } from "./protocol";

/** Provider-owned callbacks and state accessors required to build session actions. */
export type ProviderSessionActionBindings = Readonly<{
  /** Workspace storage paths for persisted session data. */
  projectStorage: ProjectStorageInfo;
  /** Mutable selected-file set mirrored into the webview file picker. */
  selectedFiles: Set<string>;
  /** Refreshes workbench chrome before a session-init broadcast. */
  updateWorkbenchChrome: () => void;
  /** Refreshes extension tool-group state before rebuilding session-init payload. */
  refreshExtensionToolGroups: () => void;
  /** Builds the current tracked-change summary for the session. */
  buildChangeSummaryPayload: () => ChangeSummary;
  /** Refreshes native shell views using the latest files and change summary. */
  refreshNativeShellViews: (
    files?: readonly FileItem[],
    changeSummary?: ChangeSummary,
  ) => Promise<void>;
  /** Returns the latest transcript messages mirrored into the webview. */
  getMessages: () => readonly ChatMessage[];
  /** Returns the current selected runtime agent. */
  getSelectedAgent: () => import("./protocol").AgentType;
  /** Returns whether the provider is actively running. */
  getIsRunning: () => boolean;
  /** Returns the current status text shown in the UI and status bar. */
  getStatusText: () => string;
  /** Returns the current phase plan items. */
  getPlanItems: () => readonly import("./protocol").PlanItem[];
  /** Returns the current runtime logs mirrored into the webview. */
  getRuntimeLogs: () => readonly import("./protocol").LogEntry[];
  /** Returns the current quality details snapshot. */
  getQualityDetails: () => QualityDetails;
  /** Returns the current quality preference state. */
  getQualityPreferences: () => QualityPreferences;
  /** Returns the current effective tool capability state. */
  getToolCapabilities: () => ToolCapabilities;
  /** Returns the current effective built-in tool toggles. */
  getToolToggles: () => ToolToggles;
  /** Returns the latest discovered extension tool groups. */
  getExtensionToolGroups: () => readonly ExtensionToolGroup[];
  /** Returns the current extension tool toggle map. */
  getExtensionToolToggles: () => Readonly<Record<string, boolean>>;
  /** Returns the current assistant streaming buffer, if any. */
  getStreamingAssistant: () => string;
  /** Returns the current thinking streaming buffer, if any. */
  getStreamingThinking: () => string;
  /** Returns the current active shell sessions mirrored into the webview. */
  getActiveShellSessions: () => readonly ActiveShellSessionState[];
  /** Returns the current pending approval payload, if any. */
  getApprovalRequest: () => ApprovalRequestPayload | null;
  /** Sanitizes one transcript message before posting it to the webview. */
  sanitizeChatMessageForWebview: (message: ChatMessage) => ChatMessage;
  /** Returns the latest live sidebar webview, if present. */
  getSidebarWebview: () => import("vscode").Webview | null;
  /** Returns the latest live panel webview, if present. */
  getPanelWebview: () => import("vscode").Webview | null;
  /** Formats an absolute path into a workspace-relative label. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Returns the latest effective runtime config snapshot. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Stores a new provider status text value while loading initial messages. */
  setStatusText: (statusText: string) => void;
  /** Appends one runtime log entry while loading initial messages. */
  appendLog: (
    kind: "info" | "status" | "approval" | "validation" | "review" | "error",
    text: string,
  ) => void;
}>;

/** Provider-bound session actions exposed by extracted host helpers. */
export type ProviderSessionActions = Readonly<{
  /** Broadcasts one host message to every live Galaxy webview. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Reads workspace files for the Galaxy file picker. */
  getWorkspaceFiles: () => Promise<SessionInitPayload["files"]>;
  /** Rebuilds and posts the full session-init payload to live webviews. */
  postInit: () => Promise<void>;
  /** Returns the latest effective runtime config snapshot. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Loads initial transcript messages from persisted workspace storage. */
  loadInitialMessages: () => ChatMessage[];
}>;
