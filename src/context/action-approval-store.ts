/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workspace-local command approval persistence for the VS Code extension runtime.
 */

import fs from 'node:fs';
import type { CommandPermission, LocalPermissionSettings } from './entities/action-approval';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';

/**
 * Creates the default empty workspace permission settings.
 *
 * @returns Frozen permission settings with no stored approvals.
 */
function createDefaultSettings(): LocalPermissionSettings {
  return Object.freeze({
    permissions: Object.freeze({
      allow: Object.freeze([]),
      deny: Object.freeze([]),
      ask: Object.freeze([]),
    }),
  });
}

/**
 * Normalizes a parsed JSON value into a string list.
 *
 * @param value Unknown parsed JSON value.
 * @returns Frozen string list safe for permission storage.
 */
function normalizeList(value: unknown): readonly string[] {
  return Object.freeze(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  );
}

/**
 * Loads workspace-local permission settings from disk.
 *
 * @param workspacePath Absolute workspace path.
 * @returns Persisted settings or the default empty settings when unavailable.
 */
function loadSettings(workspacePath: string): LocalPermissionSettings {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);

  if (!fs.existsSync(storage.localSettingsPath)) {
    return createDefaultSettings();
  }

  try {
    const raw = fs.readFileSync(storage.localSettingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      permissions?: {
        allow?: unknown;
        deny?: unknown;
        ask?: unknown;
      };
    };

    return Object.freeze({
      permissions: Object.freeze({
        allow: normalizeList(parsed.permissions?.allow),
        deny: normalizeList(parsed.permissions?.deny),
        ask: normalizeList(parsed.permissions?.ask),
      }),
    });
  } catch {
    return createDefaultSettings();
  }
}

/**
 * Persists workspace-local permission settings to disk.
 *
 * @param workspacePath Absolute workspace path.
 * @param settings Normalized settings to persist.
 * @returns The same frozen settings after saving.
 */
function saveSettings(workspacePath: string, settings: LocalPermissionSettings): LocalPermissionSettings {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  fs.writeFileSync(storage.localSettingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  return settings;
}

/**
 * Resolves the current permission state for a command.
 *
 * @param workspacePath Absolute workspace path.
 * @param command Command string to look up.
 * @returns Stored permission state for the command or `unset`.
 */
export function getCommandPermission(workspacePath: string, command: string): CommandPermission {
  const normalized = command.trim();
  const settings = loadSettings(workspacePath);
  if (settings.permissions.allow.includes(normalized)) {
    return 'allow';
  }
  if (settings.permissions.deny.includes(normalized)) {
    return 'deny';
  }
  if (settings.permissions.ask.includes(normalized)) {
    return 'ask';
  }
  return 'unset';
}

/**
 * Saves a concrete permission decision for a command.
 *
 * @param workspacePath Absolute workspace path.
 * @param command Command string being updated.
 * @param permission Concrete permission state to persist.
 * @returns Updated workspace permission settings.
 */
function savePermission(
  workspacePath: string,
  command: string,
  permission: Exclude<CommandPermission, 'unset'>,
): LocalPermissionSettings {
  const normalized = command.trim();
  const current = loadSettings(workspacePath);
  const next: LocalPermissionSettings = Object.freeze({
    permissions: Object.freeze({
      allow: Object.freeze(
        permission === 'allow'
          ? [...current.permissions.allow.filter((item) => item !== normalized), normalized]
          : current.permissions.allow.filter((item) => item !== normalized),
      ),
      deny: Object.freeze(
        permission === 'deny'
          ? [...current.permissions.deny.filter((item) => item !== normalized), normalized]
          : current.permissions.deny.filter((item) => item !== normalized),
      ),
      ask: Object.freeze(
        permission === 'ask'
          ? [...current.permissions.ask.filter((item) => item !== normalized), normalized]
          : current.permissions.ask.filter((item) => item !== normalized),
      ),
    }),
  });

  return saveSettings(workspacePath, next);
}

/**
 * Grants permanent approval for a command in the current workspace.
 *
 * @param workspacePath Absolute workspace path.
 * @param command Command string being granted.
 * @param _toolName Tool name kept for signature compatibility.
 * @returns Updated workspace permission settings.
 */
export function grantActionApproval(workspacePath: string, command: string, _toolName: string): LocalPermissionSettings {
  return savePermission(workspacePath, command, 'allow');
}

/**
 * Stores a deny decision for a command in the current workspace.
 *
 * @param workspacePath Absolute workspace path.
 * @param command Command string being denied.
 * @returns Updated workspace permission settings.
 */
export function denyActionApproval(workspacePath: string, command: string): LocalPermissionSettings {
  return savePermission(workspacePath, command, 'deny');
}

/**
 * Stores an ask-always decision for a command in the current workspace.
 *
 * @param workspacePath Absolute workspace path.
 * @param command Command string that should keep asking.
 * @returns Updated workspace permission settings.
 */
export function askActionApproval(workspacePath: string, command: string): LocalPermissionSettings {
  return savePermission(workspacePath, command, 'ask');
}

/**
 * Clears all stored command approvals for the workspace.
 *
 * @param workspacePath Absolute workspace path.
 * @returns Reset workspace permission settings.
 */
export function clearActionApprovals(workspacePath: string): LocalPermissionSettings {
  return saveSettings(workspacePath, createDefaultSettings());
}

/**
 * Builds a prompt block describing commands the user has explicitly denied.
 *
 * @param workspacePath Absolute workspace path.
 * @returns Prompt block content or an empty string when there are no denied commands.
 */
export function buildPermissionContextBlock(workspacePath: string): string {
  const settings = loadSettings(workspacePath);
  if (settings.permissions.deny.length === 0) {
    return '';
  }

  return [
    'Workspace command permission constraints:',
    'The following commands have been explicitly denied by the user in this workspace. Do not call them again unless the user changes permissions.',
    ...settings.permissions.deny.map((command) => `- ${command}`),
  ].join('\n');
}
