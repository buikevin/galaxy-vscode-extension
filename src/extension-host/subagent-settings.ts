/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-09
 * @modify date 2026-05-09
 * @desc Host-side helpers for subagent orchestration preferences.
 */

import { loadConfig, saveConfig } from "../config/manager";
import type { GalaxyConfig, SubagentRoleOverridesConfig } from "../shared/config";
import type {
  SubagentPreferences,
  SubagentRoleKey,
  SubagentRolePreference,
} from "../shared/protocol";
import {
  SUBAGENT_ROLE_REGISTRY,
  isSubagentRoleId,
  resolveSubagentModelProfile,
} from "../shared/subagents";

const SUBAGENT_ROLE_ORDER: readonly SubagentRoleKey[] = Object.freeze([
  "main",
  "ba",
  "profiler",
  "planning",
  "sa",
  "coding",
  "testing",
  "review",
]);

/** Builds webview-ready subagent preferences from the effective config. */
export function buildSubagentPreferences(
  config: GalaxyConfig = loadConfig(),
): SubagentPreferences {
  return Object.freeze({
    enabled: config.subagent,
    roles: Object.freeze(
      SUBAGENT_ROLE_ORDER.map((roleId): SubagentRolePreference => {
        const role = SUBAGENT_ROLE_REGISTRY[roleId];
        const modelProfile = resolveSubagentModelProfile(config, roleId);
        return Object.freeze({
          role: roleId,
          title: role.title,
          model: modelProfile.model,
          defaultModel: role.model.model,
          ...(modelProfile.baseUrl ? { baseUrl: modelProfile.baseUrl } : {}),
          ...(role.model.baseUrl ? { defaultBaseUrl: role.model.baseUrl } : {}),
        });
      }),
    ),
  });
}

/** Persists subagent preferences and returns the normalized effective state. */
export function applySubagentPreferencesState(
  next: SubagentPreferences,
): SubagentPreferences {
  const current = loadConfig();
  const subagentRoles: SubagentRoleOverridesConfig = Object.freeze(
    Object.fromEntries(
      next.roles
        .filter((role) => isSubagentRoleId(role.role))
        .map((role) => {
          const defaultRole = SUBAGENT_ROLE_REGISTRY[role.role];
          const model = role.model.trim();
          const baseUrl = role.baseUrl?.trim() ?? "";
          return [
            role.role,
            Object.freeze({
              ...(model && model !== defaultRole.model.model ? { model } : {}),
              ...(baseUrl && baseUrl !== defaultRole.model.baseUrl
                ? { baseUrl }
                : {}),
            }),
          ] as const;
        })
        .filter(([, override]) => Boolean(override.model || override.baseUrl)),
    ),
  );

  saveConfig({
    ...current,
    subagent: next.enabled,
    subagentRoles,
  });
  return buildSubagentPreferences(loadConfig());
}
