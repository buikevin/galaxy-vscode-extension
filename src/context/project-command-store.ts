import fs from 'node:fs';
import path from 'node:path';
import { detectProjectCommands, type ProjectCommandDefinition, type ProjectCommandProfile } from './project-command-detector';
import { ensureProjectStorage, getProjectStorageInfo } from './project-store';

type PersistedProjectCommandProfile = Readonly<{
  workspaceId: string;
  workspacePath: string;
  commands: readonly ProjectCommandDefinition[];
  detectedStack: readonly string[];
  updatedAt: number;
}>;

export function loadProjectCommandProfile(workspacePath: string): ProjectCommandProfile | null {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  if (!fs.existsSync(storage.projectCommandsPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(storage.projectCommandsPath, 'utf-8');
    return JSON.parse(raw) as ProjectCommandProfile;
  } catch {
    return null;
  }
}

export function saveProjectCommandProfile(workspacePath: string, profile: PersistedProjectCommandProfile): ProjectCommandProfile {
  const storage = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(storage);
  const normalized: ProjectCommandProfile = Object.freeze({
    workspaceId: profile.workspaceId,
    workspacePath: path.resolve(profile.workspacePath),
    commands: Object.freeze([...profile.commands]),
    detectedStack: Object.freeze([...profile.detectedStack]),
    updatedAt: profile.updatedAt,
  });
  fs.writeFileSync(storage.projectCommandsPath, JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

export function getOrCreateProjectCommandProfile(workspacePath: string): ProjectCommandProfile {
  const resolvedWorkspace = path.resolve(workspacePath);
  const storage = getProjectStorageInfo(resolvedWorkspace);
  const existing = loadProjectCommandProfile(resolvedWorkspace);
  const detected = detectProjectCommands(resolvedWorkspace);

  const mergedCommands = new Map<string, ProjectCommandDefinition>();
  for (const command of existing?.commands ?? []) {
    mergedCommands.set(command.id, command);
  }
  for (const command of detected.commands) {
    const previous = mergedCommands.get(command.id);
    mergedCommands.set(command.id, previous ? Object.freeze({ ...command, enabled: previous.enabled }) : command);
  }

  return saveProjectCommandProfile(resolvedWorkspace, {
    workspaceId: storage.workspaceId,
    workspacePath: resolvedWorkspace,
    commands: Object.freeze([...mergedCommands.values()]),
    detectedStack: detected.detectedStack,
    updatedAt: Date.now(),
  });
}

export function findProjectCommand(workspacePath: string, commandId: string): ProjectCommandDefinition | null {
  const profile = getOrCreateProjectCommandProfile(workspacePath);
  return profile.commands.find((command) => command.id === commandId && command.enabled) ?? null;
}

export function buildProjectCommandsContextBlock(workspacePath: string): string {
  const profile = getOrCreateProjectCommandProfile(workspacePath);
  const enabledCommands = profile.commands.filter((command) => command.enabled);
  if (enabledCommands.length === 0) {
    return '';
  }

  const lines = ['[PROJECT COMMANDS]'];
  for (const command of enabledCommands.slice(0, 12)) {
    lines.push(`- ${command.id}: ${command.label} (${command.category}${command.risk === 'confirm' ? ', approval required' : ''})`);
  }
  return lines.join('\n');
}
