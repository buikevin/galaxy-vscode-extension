import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export type ShellKind = 'posix' | 'powershell' | 'cmd';

export type ShellProfile = Readonly<{
  executable: string;
  kind: ShellKind;
  commandArgs(commandText: string): readonly string[];
  availabilityArgs(binary: string): readonly string[];
}>;

function normalizePathEntries(rawPath: string | undefined): string[] {
  if (!rawPath) {
    return [];
  }

  const entries = rawPath.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  return entries.map((entry) => {
    if (entry === '~') {
      return os.homedir();
    }
    if (entry.startsWith('~/')) {
      return path.join(os.homedir(), entry.slice(2));
    }
    return entry;
  });
}

export function buildShellEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const baseEnv = { ...process.env, ...overrides };
  const homeDir = baseEnv.HOME?.trim() || os.homedir();
  const preferredEntries = [
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const existingEntries = normalizePathEntries(baseEnv.PATH);
  const mergedEntries = [...preferredEntries, ...existingEntries].filter(Boolean);
  const dedupedEntries = mergedEntries.filter((entry, index) => mergedEntries.indexOf(entry) === index);
  return {
    ...baseEnv,
    HOME: homeDir,
    PATH: dedupedEntries.join(path.delimiter),
  };
}

function commandExistsOnPath(binary: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [binary] : ['-v', binary];
  const result = spawnSync(checker, args, {
    stdio: 'pipe',
    shell: process.platform !== 'win32',
    timeout: 5_000,
    env: buildShellEnvironment(),
  });
  return !result.error && result.status === 0;
}

function createPosixShell(executable: string): ShellProfile {
  return Object.freeze({
    executable,
    kind: 'posix',
    commandArgs: (commandText: string) => Object.freeze(['-lc', commandText]),
    availabilityArgs: (binary: string) => Object.freeze(['-lc', `command -v ${binary}`]),
  });
}

function createPowerShell(executable: string): ShellProfile {
  return Object.freeze({
    executable,
    kind: 'powershell',
    commandArgs: (commandText: string) => Object.freeze(['-NoLogo', '-NonInteractive', '-Command', commandText]),
    availabilityArgs: (binary: string) =>
      Object.freeze(['-NoLogo', '-NonInteractive', '-Command', `Get-Command ${binary} | Out-Null`]),
  });
}

function createCmdShell(): ShellProfile {
  return Object.freeze({
    executable: 'cmd.exe',
    kind: 'cmd',
    commandArgs: (commandText: string) => Object.freeze(['/d', '/s', '/c', commandText]),
    availabilityArgs: (binary: string) => Object.freeze(['/d', '/s', '/c', `where ${binary}`]),
  });
}

export function resolveShellProfile(): ShellProfile {
  if (process.platform === 'win32') {
    if (commandExistsOnPath('pwsh')) {
      return createPowerShell('pwsh');
    }
    if (commandExistsOnPath('powershell')) {
      return createPowerShell('powershell');
    }
    return createCmdShell();
  }

  if (fs.existsSync('/bin/zsh')) {
    return createPosixShell('/bin/zsh');
  }

  const envShell = process.env.SHELL?.trim();
  if (envShell && fs.existsSync(envShell)) {
    return createPosixShell(envShell);
  }

  return createPosixShell('/bin/sh');
}

export function checkCommandAvailability(binary: string, cwd: string): boolean {
  const shell = resolveShellProfile();
  const result = spawnSync(shell.executable, [...shell.availabilityArgs(binary)], {
    cwd,
    stdio: 'pipe',
    timeout: 5_000,
    env: buildShellEnvironment(),
  });
  return !result.error && result.status === 0;
}
