/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Persistence helpers for Galaxy quality preferences and tool toggle state.
 */

import * as vscode from "vscode";
import { loadConfig, saveConfig } from "../config/manager";
import { loadProjectMeta, saveProjectMeta } from "../context/project-store";
import type {
  ProjectMeta,
  ProjectStorageInfo,
} from "../context/entities/project-store";
import {
  GALAXY_CONFIGURATION_SECTION,
  QUALITY_FULL_ACCESS_SETTING_KEY,
  QUALITY_REVIEW_SETTING_KEY,
  QUALITY_VALIDATE_SETTING_KEY,
} from "../shared/constants";
import type { GalaxyConfig } from "../shared/config";
import type {
  ExtensionToolGroup,
  QualityPreferences,
  ToolCapabilities,
  ToolToggles,
} from "../shared/protocol";
import type {
  ApplyExtensionToolTogglesStateParams,
  ApplyQualityPreferencesStateParams,
  ApplyToolCapabilitiesStateParams,
  ApplyToolTogglesStateParams,
  CreateProjectMetaSeedParams,
  PersistedToolingState,
  ProjectMetaSeedOverrides,
  ToolStateContext,
} from "../shared/quality-settings";
import {
  applyFullAccessToToolSafety,
  getWorkspaceExtensionToolToggles,
  getWorkspaceToolCapabilities,
  getWorkspaceToolToggles,
  isFullAccessEnabled,
} from "./effective-config";

/** Read persisted quality settings from VS Code settings with current values as defaults. */
export function readQualityPreferencesFromVsCodeSettings(
  current: QualityPreferences,
): QualityPreferences {
  const configuration = vscode.workspace.getConfiguration(
    GALAXY_CONFIGURATION_SECTION,
  );
  return Object.freeze({
    reviewEnabled: configuration.get<boolean>(
      QUALITY_REVIEW_SETTING_KEY,
      current.reviewEnabled,
    ),
    validateEnabled: configuration.get<boolean>(
      QUALITY_VALIDATE_SETTING_KEY,
      current.validateEnabled,
    ),
    fullAccessEnabled: configuration.get<boolean>(
      QUALITY_FULL_ACCESS_SETTING_KEY,
      current.fullAccessEnabled,
    ),
  });
}

/** Push the effective quality preferences back into VS Code user settings. */
export async function syncQualityPreferencesToVsCodeSettings(
  preferences: QualityPreferences,
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(
    GALAXY_CONFIGURATION_SECTION,
  );
  const updates: Thenable<void>[] = [];

  if (
    configuration.get<boolean>(QUALITY_REVIEW_SETTING_KEY) !==
    preferences.reviewEnabled
  ) {
    updates.push(
      configuration.update(
        QUALITY_REVIEW_SETTING_KEY,
        preferences.reviewEnabled,
        vscode.ConfigurationTarget.Global,
      ),
    );
  }

  if (
    configuration.get<boolean>(QUALITY_VALIDATE_SETTING_KEY) !==
    preferences.validateEnabled
  ) {
    updates.push(
      configuration.update(
        QUALITY_VALIDATE_SETTING_KEY,
        preferences.validateEnabled,
        vscode.ConfigurationTarget.Global,
      ),
    );
  }

  if (
    configuration.get<boolean>(QUALITY_FULL_ACCESS_SETTING_KEY) !==
    preferences.fullAccessEnabled
  ) {
    updates.push(
      configuration.update(
        QUALITY_FULL_ACCESS_SETTING_KEY,
        preferences.fullAccessEnabled,
        vscode.ConfigurationTarget.Global,
      ),
    );
  }

  if (updates.length > 0) {
    await Promise.all(updates);
  }
}

/** Persist the user's quality preferences and recalculate effective runtime tool state. */
export async function applyQualityPreferencesState(
  context: ApplyQualityPreferencesStateParams,
): Promise<PersistedToolingState> {
  const qualityPreferences = Object.freeze({
    reviewEnabled: context.next.reviewEnabled,
    validateEnabled: context.next.validateEnabled,
    fullAccessEnabled: context.next.fullAccessEnabled,
  });

  const config = loadConfig();
  const previousMeta = loadProjectMeta(context.projectStorage);
  saveConfig({
    ...config,
    quality: {
      ...config.quality,
      review: qualityPreferences.reviewEnabled,
      test: qualityPreferences.validateEnabled,
    },
    toolSafety: {
      ...applyFullAccessToToolSafety(
        config,
        qualityPreferences.fullAccessEnabled,
      ),
    },
  });
  saveProjectMeta(
    context.projectStorage,
    previousMeta
      ? {
          ...previousMeta,
          toolCapabilities: {
            ...(previousMeta.toolCapabilities ?? {}),
            review: qualityPreferences.reviewEnabled,
            validation: qualityPreferences.validateEnabled,
          },
          toolToggles: previousMeta.toolToggles,
          extensionToolToggles: previousMeta.extensionToolToggles,
        }
      : null,
  );

  const persisted = loadConfig();
  const meta = loadProjectMeta(context.projectStorage);
  const toolCapabilities = getWorkspaceToolCapabilities(persisted, meta);
  const toolToggles = getWorkspaceToolToggles(persisted, meta);
  const extensionToolToggles = getWorkspaceExtensionToolToggles(
    persisted,
    meta,
    context.extensionToolGroups,
  );

  if (context.syncVsCodeSettings) {
    await syncQualityPreferencesToVsCodeSettings(qualityPreferences);
  }

  return Object.freeze({
    qualityPreferences,
    toolCapabilities,
    toolToggles,
    extensionToolToggles,
  });
}

/** Persist effective tool capabilities and derive the resulting quality/tool state. */
export async function applyToolCapabilitiesState(
  context: ApplyToolCapabilitiesStateParams,
): Promise<PersistedToolingState> {
  const config = loadConfig();
  const previousMeta = loadProjectMeta(context.projectStorage);
  saveConfig({
    ...config,
    quality: {
      ...config.quality,
      review: context.next.review,
      test: context.next.validation,
    },
    toolSafety: {
      ...config.toolSafety,
      enableProjectCommandTool: context.next.runCommands,
    },
    toolCapabilities: {
      ...config.toolCapabilities,
      ...context.next,
    },
  });

  const seededConfig = loadConfig();
  saveProjectMeta(
    context.projectStorage,
    previousMeta
      ? {
          ...previousMeta,
          toolCapabilities: context.next,
          toolToggles: previousMeta.toolToggles,
          extensionToolToggles: previousMeta.extensionToolToggles,
        }
      : createProjectMetaSeed(context.projectStorage, seededConfig, {
          toolCapabilities: context.next,
          toolToggles: seededConfig.toolToggles,
          extensionToolToggles: seededConfig.extensionToolToggles,
        }),
  );

  const persisted = loadConfig();
  const meta = loadProjectMeta(context.projectStorage);
  const toolCapabilities = getWorkspaceToolCapabilities(persisted, meta);
  const toolToggles = getWorkspaceToolToggles(persisted, meta);
  const extensionToolToggles = getWorkspaceExtensionToolToggles(
    persisted,
    meta,
    context.extensionToolGroups,
  );
  const qualityPreferences = Object.freeze({
    reviewEnabled: toolCapabilities.review,
    validateEnabled: toolCapabilities.validation,
    fullAccessEnabled: isFullAccessEnabled(persisted),
  });

  await syncQualityPreferencesToVsCodeSettings(qualityPreferences);

  return Object.freeze({
    qualityPreferences,
    toolCapabilities,
    toolToggles,
    extensionToolToggles,
  });
}

/** Persist built-in tool toggles and return the resulting effective toggle state. */
export function applyToolTogglesState(
  context: ApplyToolTogglesStateParams,
): ToolToggles {
  const config = loadConfig();
  const previousMeta = loadProjectMeta(context.projectStorage);
  saveConfig({
    ...config,
    toolToggles: context.next,
  });

  const seededConfig = loadConfig();
  saveProjectMeta(
    context.projectStorage,
    previousMeta
      ? {
          ...previousMeta,
          toolCapabilities: previousMeta.toolCapabilities,
          toolToggles: context.next,
          extensionToolToggles: previousMeta.extensionToolToggles,
        }
      : createProjectMetaSeed(context.projectStorage, seededConfig, {
          toolCapabilities: undefined,
          toolToggles: context.next,
          extensionToolToggles: seededConfig.extensionToolToggles,
        }),
  );

  return getWorkspaceToolToggles(
    loadConfig(),
    loadProjectMeta(context.projectStorage),
  );
}

/** Persist extension-contributed tool toggles and return the resulting effective state. */
export function applyExtensionToolTogglesState(
  context: ApplyExtensionToolTogglesStateParams,
): Readonly<Record<string, boolean>> {
  const config = loadConfig();
  const previousMeta = loadProjectMeta(context.projectStorage);
  saveConfig({
    ...config,
    extensionToolToggles: context.next,
  });

  const seededConfig = loadConfig();
  saveProjectMeta(
    context.projectStorage,
    previousMeta
      ? {
          ...previousMeta,
          toolCapabilities: previousMeta.toolCapabilities,
          toolToggles: previousMeta.toolToggles,
          extensionToolToggles: context.next,
        }
      : createProjectMetaSeed(context.projectStorage, seededConfig, {
          toolCapabilities: undefined,
          toolToggles: seededConfig.toolToggles,
          extensionToolToggles: context.next,
        }),
  );

  return getWorkspaceExtensionToolToggles(
    loadConfig(),
    loadProjectMeta(context.projectStorage),
    context.extensionToolGroups,
  );
}

/** Create an initial project meta document when overrides are first persisted. */
function createProjectMetaSeed(
  projectStorage: CreateProjectMetaSeedParams["projectStorage"],
  config: CreateProjectMetaSeedParams["config"],
  overrides: ProjectMetaSeedOverrides,
): ProjectMeta {
  return {
    workspaceId: projectStorage.workspaceId,
    workspaceName: projectStorage.workspaceName,
    workspacePath: projectStorage.workspacePath,
    projectDirName: projectStorage.projectDirName,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    storageVersion: 1,
    toolCapabilities: overrides.toolCapabilities,
    toolToggles: overrides.toolToggles ?? config.toolToggles,
    extensionToolToggles:
      overrides.extensionToolToggles ?? config.extensionToolToggles,
  };
}
