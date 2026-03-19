import fs from 'node:fs';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';

type LocalPermissionSettings = Readonly<{
  permissions: Readonly<{
    allow: readonly string[];
    deny: readonly string[];
    ask: readonly string[];
  }>;
}>;

export type CommandPermission = 'allow' | 'deny' | 'ask' | 'unset';

function createDefaultSettings(): LocalPermissionSettings {
  return Object.freeze({
    permissions: Object.freeze({
      allow: Object.freeze([]),
      deny: Object.freeze([]),
      ask: Object.freeze([]),
    }),
  });
}

function normalizeList(value: unknown): readonly string[] {
  return Object.freeze(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  );
}

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

function saveSettings(workspacePath: string, settings: LocalPermissionSettings): LocalPermissionSettings {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  fs.writeFileSync(storage.localSettingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  return settings;
}

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

export function grantActionApproval(workspacePath: string, command: string, _toolName: string): LocalPermissionSettings {
  return savePermission(workspacePath, command, 'allow');
}

export function denyActionApproval(workspacePath: string, command: string): LocalPermissionSettings {
  return savePermission(workspacePath, command, 'deny');
}

export function askActionApproval(workspacePath: string, command: string): LocalPermissionSettings {
  return savePermission(workspacePath, command, 'ask');
}

export function clearActionApprovals(workspacePath: string): LocalPermissionSettings {
  return saveSettings(workspacePath, createDefaultSettings());
}

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
