/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for persisted quality preference and tool toggle state.
 */

import type {
  ProjectMeta,
  ProjectStorageInfo,
} from "../context/entities/project-store";
import type { GalaxyConfig } from "./config";
import type {
  ExtensionToolGroup,
  HostMessage,
  LogEntry,
  QualityPreferences,
  ToolCapabilities,
  ToolToggles,
} from "./protocol";

/** Runtime state synchronized between config persistence and the chat host. */
export type PersistedToolingState = Readonly<{
  /** Effective quality preference state after persistence. */
  qualityPreferences: QualityPreferences;
  /** Effective capability flags after merging workspace overrides. */
  toolCapabilities: ToolCapabilities;
  /** Effective built-in tool toggles after merging workspace overrides. */
  toolToggles: ToolToggles;
  /** Effective extension tool toggle map after merging workspace overrides. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
}>;

/** Shared workspace context used when persisting tool and quality state. */
export type ToolStateContext = Readonly<{
  /** Storage paths for the active workspace. */
  projectStorage: ProjectStorageInfo;
  /** Discovered extension tool groups used to derive effective toggles. */
  extensionToolGroups: readonly ExtensionToolGroup[];
}>;

/** Parameters required to persist quality preferences and recompute effective tool state. */
export type ApplyQualityPreferencesStateParams = ToolStateContext &
  Readonly<{
    /** Next quality preferences selected by the user. */
    next: QualityPreferences;
    /** Whether the new preferences should be mirrored into VS Code settings. */
    syncVsCodeSettings: boolean;
  }>;

/** Parameters required to persist tool capabilities and recompute effective state. */
export type ApplyToolCapabilitiesStateParams = ToolStateContext &
  Readonly<{
    /** New capability map chosen by the user. */
    next: ToolCapabilities;
  }>;

/** Parameters required to persist built-in tool toggles. */
export type ApplyToolTogglesStateParams = Readonly<{
  /** Storage paths for the active workspace. */
  projectStorage: ProjectStorageInfo;
  /** New built-in tool toggle map. */
  next: ToolToggles;
}>;

/** Parameters required to persist extension-contributed tool toggles. */
export type ApplyExtensionToolTogglesStateParams = ToolStateContext &
  Readonly<{
    /** New extension tool toggle map. */
    next: Readonly<Record<string, boolean>>;
  }>;

/** Overrides used when seeding the first persisted workspace metadata record. */
export type ProjectMetaSeedOverrides = Readonly<{
  /** Optional capability override for the seed. */
  toolCapabilities: ProjectMeta["toolCapabilities"];
  /** Built-in tool toggle state stored in the seed. */
  toolToggles: ProjectMeta["toolToggles"];
  /** Extension tool toggle state stored in the seed. */
  extensionToolToggles: ProjectMeta["extensionToolToggles"];
}>;

/** Parameters required to build the initial workspace metadata seed. */
export type CreateProjectMetaSeedParams = Readonly<{
  /** Storage paths for the active workspace. */
  projectStorage: ProjectStorageInfo;
  /** Persisted Galaxy config used as the baseline seed state. */
  config: GalaxyConfig;
  /** Override values applied to the initial workspace metadata. */
  overrides: ProjectMetaSeedOverrides;
}>;

/** Optional flags accepted when applying quality preferences from provider-owned actions. */
export type ApplyQualityPreferencesOptions = Readonly<{
  /** Whether the effective state should be mirrored back into VS Code settings. */
  syncVsCodeSettings?: boolean;
  /** Optional runtime log line emitted after state has been updated. */
  logMessage?: string;
}>;

/** Optional runtime-log payload accepted when mutating tool capability or toggle state. */
export type ApplyToolStateOptions = Readonly<{
  /** Optional runtime log line emitted after state has been updated. */
  logMessage?: string;
}>;

/** Provider-owned callbacks and state accessors required to build quality action helpers. */
export type ProviderQualityActionBindings = Readonly<{
  /** Storage paths for the active workspace. */
  projectStorage: ProjectStorageInfo;
  /** Returns the latest extension tool groups used to compute effective toggle state. */
  getExtensionToolGroups: () => readonly ExtensionToolGroup[];
  /** Returns the latest effective quality preferences from provider state. */
  getQualityPreferences: () => QualityPreferences;
  /** Stores the latest effective quality preferences in provider state. */
  setQualityPreferences: (next: QualityPreferences) => void;
  /** Stores the latest effective tool capability state in provider state. */
  setToolCapabilities: (next: ToolCapabilities) => void;
  /** Stores the latest effective built-in tool toggles in provider state. */
  setToolToggles: (next: ToolToggles) => void;
  /** Stores the latest effective extension tool toggles in provider state. */
  setExtensionToolToggles: (next: Readonly<Record<string, boolean>>) => void;
  /** Posts one host-side state update message back into the webview. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Appends one runtime log entry describing the applied state change. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
}>;

/** Provider-bound quality actions exposed by extracted host helpers. */
export type ProviderQualityActions = Readonly<{
  /** Reads quality preferences from VS Code settings using current state as fallback defaults. */
  readQualityPreferencesFromVsCodeSettings: () => QualityPreferences;
  /** Mirrors the latest effective quality preferences back into VS Code settings. */
  syncQualityPreferencesToVsCodeSettings: () => Promise<void>;
  /** Applies quality preference changes originating from VS Code settings. */
  handleVsCodeQualitySettingsChange: () => Promise<void>;
  /** Toggles review quality preference state from the command palette. */
  toggleReviewPreference: () => Promise<void>;
  /** Toggles validation quality preference state from the command palette. */
  toggleValidationPreference: () => Promise<void>;
  /** Applies effective quality preference state and broadcasts updates to the webview. */
  applyQualityPreferences: (
    next: QualityPreferences,
    opts?: ApplyQualityPreferencesOptions,
  ) => Promise<void>;
  /** Applies effective tool capability state and broadcasts updates to the webview. */
  applyToolCapabilities: (
    next: ToolCapabilities,
    opts?: ApplyToolStateOptions,
  ) => Promise<void>;
  /** Applies effective built-in tool toggles and broadcasts updates to the webview. */
  applyToolToggles: (
    next: ToolToggles,
    opts?: ApplyToolStateOptions,
  ) => Promise<void>;
  /** Applies effective extension tool toggles and broadcasts updates to the webview. */
  applyExtensionToolToggles: (
    next: Readonly<Record<string, boolean>>,
    opts?: ApplyToolStateOptions,
  ) => Promise<void>;
}>;
