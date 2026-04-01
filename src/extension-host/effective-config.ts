/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Effective-config helpers extracted from the VS Code extension host entrypoint.
 */

import type { GalaxyConfig } from "../shared/config";
import { DEFAULT_CONFIG } from "../shared/constants";
import { loadConfig } from "../config/manager";
import type { ProjectMeta } from "../context/entities/project-store";
import type { ProjectStorageInfo } from "../context/entities/project-store";
import { loadProjectMeta } from "../context/project-store";
import type {
  ExtensionToolGroup,
  QualityPreferences,
  ToolCapabilities,
  ToolToggles,
} from "../shared/protocol";

/** Merge runtime capability toggles from global config and workspace metadata. */
export function getWorkspaceToolCapabilities(
  config: GalaxyConfig,
  meta: ProjectMeta | null,
): ToolCapabilities {
  return Object.freeze({
    ...config.toolCapabilities,
    ...(meta?.toolCapabilities ?? {}),
  });
}

/** Merge runtime tool toggles from global config and workspace metadata. */
export function getWorkspaceToolToggles(
  config: GalaxyConfig,
  meta: ProjectMeta | null,
): ToolToggles {
  return Object.freeze({
    ...config.toolToggles,
    ...((meta?.toolToggles ?? {}) as Partial<ToolToggles>),
  });
}

/** Build recommended default enablement for discovered extension-provided tools. */
export function getDefaultExtensionToolToggles(
  groups: readonly ExtensionToolGroup[],
): Readonly<Record<string, boolean>> {
  return Object.freeze(
    Object.fromEntries(
      groups.flatMap((group) =>
        group.recommended || group.source === "mcp_curated"
          ? group.tools.map((tool) => [tool.key, true] as const)
          : [],
      ),
    ),
  );
}

/** Merge extension-tool toggles from defaults, global config, and workspace metadata. */
export function getWorkspaceExtensionToolToggles(
  config: GalaxyConfig,
  meta: ProjectMeta | null,
  groups: readonly ExtensionToolGroup[],
): Readonly<Record<string, boolean>> {
  return Object.freeze({
    ...getDefaultExtensionToolToggles(groups),
    ...config.extensionToolToggles,
    ...(meta?.extensionToolToggles ?? {}),
  });
}

/** Derive persisted quality preferences from current capability state. */
export function getQualityPreferencesForWorkspace(
  config: GalaxyConfig,
  capabilities: ToolCapabilities,
): QualityPreferences {
  return Object.freeze({
    reviewEnabled: capabilities.review,
    validateEnabled: capabilities.validation,
    fullAccessEnabled: isFullAccessEnabled(config),
  });
}

/** Build the final config passed into runtime chat, review, and validation flows. */
export function buildEffectiveConfig(
  config: GalaxyConfig,
  meta: ProjectMeta | null,
  qualityPreferences: QualityPreferences,
  availableExtensionToolGroups: readonly ExtensionToolGroup[],
): GalaxyConfig {
  const toolCapabilities = getWorkspaceToolCapabilities(config, meta);
  const toolToggles = getWorkspaceToolToggles(config, meta);
  const quality = {
    ...config.quality,
    review: qualityPreferences.reviewEnabled,
    test: qualityPreferences.validateEnabled,
  };

  return Object.freeze({
    ...config,
    quality,
    toolSafety: applyFullAccessToToolSafety(
      {
        ...config,
        quality,
        toolCapabilities,
        toolToggles,
      },
      qualityPreferences.fullAccessEnabled,
    ),
    toolCapabilities: Object.freeze({
      ...toolCapabilities,
      review: qualityPreferences.reviewEnabled,
      validation: qualityPreferences.validateEnabled,
      runCommands: toolCapabilities.runCommands,
    }),
    toolToggles,
    extensionToolToggles: getWorkspaceExtensionToolToggles(
      config,
      meta,
      availableExtensionToolGroups,
    ),
    availableExtensionToolGroups,
  });
}

/** Loads persisted workspace metadata and returns the effective runtime config. */
export function getEffectiveConfigForWorkspace(
  projectStorage: ProjectStorageInfo,
  qualityPreferences: QualityPreferences,
  availableExtensionToolGroups: readonly ExtensionToolGroup[],
): GalaxyConfig {
  return buildEffectiveConfig(
    loadConfig(),
    loadProjectMeta(projectStorage),
    qualityPreferences,
    availableExtensionToolGroups,
  );
}

/** Determine whether all approval-gated write actions are effectively unrestricted. */
export function isFullAccessEnabled(config: GalaxyConfig): boolean {
  return (
    !config.toolSafety.requireApprovalForGitPull &&
    !config.toolSafety.requireApprovalForGitPush &&
    !config.toolSafety.requireApprovalForGitCheckout &&
    !config.toolSafety.requireApprovalForDeletePath &&
    !config.toolSafety.requireApprovalForScaffold &&
    !config.toolSafety.requireApprovalForProjectCommand
  );
}

/** Toggle approval requirements to match the requested full-access mode. */
export function applyFullAccessToToolSafety(
  config: GalaxyConfig,
  enabled: boolean,
): GalaxyConfig["toolSafety"] {
  if (enabled) {
    return {
      ...config.toolSafety,
      requireApprovalForGitPull: false,
      requireApprovalForGitPush: false,
      requireApprovalForGitCheckout: false,
      requireApprovalForDeletePath: false,
      requireApprovalForScaffold: false,
      requireApprovalForProjectCommand: false,
    };
  }

  return {
    ...config.toolSafety,
    requireApprovalForGitPull:
      DEFAULT_CONFIG.toolSafety.requireApprovalForGitPull,
    requireApprovalForGitPush:
      DEFAULT_CONFIG.toolSafety.requireApprovalForGitPush,
    requireApprovalForGitCheckout:
      DEFAULT_CONFIG.toolSafety.requireApprovalForGitCheckout,
    requireApprovalForDeletePath:
      DEFAULT_CONFIG.toolSafety.requireApprovalForDeletePath,
    requireApprovalForScaffold:
      DEFAULT_CONFIG.toolSafety.requireApprovalForScaffold,
    requireApprovalForProjectCommand:
      DEFAULT_CONFIG.toolSafety.requireApprovalForProjectCommand,
  };
}
