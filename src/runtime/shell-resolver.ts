/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Resolve shell profiles and execution environments used by runtime commands across POSIX, PowerShell, and CMD.
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { COMMAND_AVAILABILITY_TIMEOUT_MS } from '../shared/constants';
import type { ShellProfile, TerminalProfileConfig } from '../shared/runtime';

/**
 * Splits and normalizes a PATH-like environment variable into absolute candidate directories.
 *
 * @param rawPath Raw PATH string from the environment.
 * @returns Normalized path entries suitable for binary lookup.
 */
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

/**
 * Builds extra Windows PATH entries that commonly contain developer shells and Git binaries.
 *
 * @param baseEnv Base environment used to derive Windows home and program directories.
 * @returns Additional preferred PATH entries.
 */
function getWindowsPreferredEntries(baseEnv: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') {
    return [];
  }

  const homeDir = baseEnv.USERPROFILE?.trim() || os.homedir();
  const localAppData = baseEnv.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local');
  const programFiles = baseEnv.ProgramFiles?.trim() || 'C:\\Program Files';
  const programFilesX86 = baseEnv['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)';

  return [
    path.join(programFiles, 'Git', 'cmd'),
    path.join(programFiles, 'Git', 'bin'),
    path.join(programFilesX86, 'Git', 'cmd'),
    path.join(programFilesX86, 'Git', 'bin'),
    path.join(localAppData, 'Programs', 'Git', 'cmd'),
    path.join(localAppData, 'Programs', 'Git', 'bin'),
    path.join(homeDir, 'scoop', 'shims'),
  ];
}

/**
 * Reads VS Code terminal environment overrides for the current platform.
 *
 * @returns Environment variables configured in `terminal.integrated.env.*`.
 */
function getVsCodeTerminalEnvOverrides(): NodeJS.ProcessEnv {
  try {
    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const envSection =
      process.platform === 'win32'
        ? (terminalConfig.get<Record<string, string | null>>('env.windows') ?? {})
        : process.platform === 'darwin'
          ? (terminalConfig.get<Record<string, string | null>>('env.osx') ?? {})
          : (terminalConfig.get<Record<string, string | null>>('env.linux') ?? {});
    const next: NodeJS.ProcessEnv = {};
    Object.entries(envSection).forEach(([key, value]) => {
      if (typeof value === 'string') {
        next[key] = value;
      }
    });
    return next;
  } catch {
    return {};
  }
}

/**
 * Builds the shell environment used for command execution and binary availability checks.
 *
 * @param overrides Optional environment overrides for one execution.
 * @returns Merged environment with normalized PATH entries.
 */
export function buildShellEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const baseEnv = { ...process.env, ...getVsCodeTerminalEnvOverrides(), ...overrides };
  const homeDir = baseEnv.HOME?.trim() || os.homedir();
  const preferredEntries = [
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...getWindowsPreferredEntries(baseEnv),
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

/**
 * Checks whether a candidate path points to an executable file.
 *
 * @param targetPath Absolute file path to inspect.
 * @returns `true` when the path exists and is a file.
 */
function isExecutableFile(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Attempts to resolve a binary by searching a list of directories and candidate extensions.
 *
 * @param binary Binary name without directory information.
 * @param entries Candidate PATH directories.
 * @param extensions Candidate executable suffixes.
 * @returns Resolved absolute binary path, or `null` when not found.
 */
function resolveBinaryFromEntries(binary: string, entries: readonly string[], extensions: readonly string[]): string | null {
  for (const entry of entries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${binary}${extension}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Checks whether a binary exists on PATH using the current platform's shell conventions.
 *
 * @param binary Binary name to probe.
 * @returns `true` when the binary can be resolved on PATH.
 */
function commandExistsOnPath(binary: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [binary] : ['-v', binary];
  const result = spawnSync(checker, args, {
    stdio: 'pipe',
    shell: process.platform !== 'win32',
    timeout: COMMAND_AVAILABILITY_TIMEOUT_MS,
    env: buildShellEnvironment(),
  });
  return !result.error && result.status === 0;
}

/**
 * Creates a POSIX shell profile without extra configured arguments.
 *
 * @param executable Shell executable path or binary name.
 * @returns POSIX shell profile.
 */
function createPosixShell(executable: string): ShellProfile {
  return Object.freeze({
    executable,
    kind: 'posix',
    commandArgs: (commandText: string) => Object.freeze(['-lc', commandText]),
    availabilityArgs: (binary: string) => Object.freeze(['-lc', `command -v ${binary}`]),
  });
}

/**
 * Creates a POSIX shell profile with configured base arguments.
 *
 * @param executable Shell executable path or binary name.
 * @param baseArgs Additional shell arguments configured by the user.
 * @returns POSIX shell profile.
 */
function createPosixShellWithArgs(executable: string, baseArgs: readonly string[]): ShellProfile {
  return Object.freeze({
    executable,
    kind: 'posix',
    commandArgs: (commandText: string) => Object.freeze([...baseArgs, '-lc', commandText]),
    availabilityArgs: (binary: string) => Object.freeze([...baseArgs, '-lc', `command -v ${binary}`]),
  });
}

/**
 * Creates a PowerShell profile without extra configured arguments.
 *
 * @param executable PowerShell executable path or binary name.
 * @returns PowerShell shell profile.
 */
function createPowerShell(executable: string): ShellProfile {
  return Object.freeze({
    executable,
    kind: 'powershell',
    commandArgs: (commandText: string) =>
      Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', commandText]),
    availabilityArgs: (binary: string) =>
      Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Get-Command ${binary} | Out-Null`]),
  });
}

/**
 * Creates a PowerShell profile with configured base arguments.
 *
 * @param executable PowerShell executable path or binary name.
 * @param baseArgs Additional shell arguments configured by the user.
 * @returns PowerShell shell profile.
 */
function createPowerShellWithArgs(executable: string, baseArgs: readonly string[]): ShellProfile {
  return Object.freeze({
    executable,
    kind: 'powershell',
    commandArgs: (commandText: string) =>
      Object.freeze([...baseArgs, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', commandText]),
    availabilityArgs: (binary: string) =>
      Object.freeze([...baseArgs, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Get-Command ${binary} | Out-Null`]),
  });
}

/**
 * Creates a Command Prompt shell profile using the default `cmd.exe`.
 *
 * @returns CMD shell profile.
 */
function createCmdShell(): ShellProfile {
  return Object.freeze({
    executable: 'cmd.exe',
    kind: 'cmd',
    commandArgs: (commandText: string) => Object.freeze(['/d', '/s', '/c', commandText]),
    availabilityArgs: (binary: string) => Object.freeze(['/d', '/s', '/c', `where ${binary}`]),
  });
}

/**
 * Creates a Command Prompt profile with configured base arguments.
 *
 * @param executable Command Prompt executable path or binary name.
 * @param baseArgs Additional shell arguments configured by the user.
 * @returns CMD shell profile.
 */
function createCmdShellWithArgs(executable: string, baseArgs: readonly string[]): ShellProfile {
  return Object.freeze({
    executable,
    kind: 'cmd',
    commandArgs: (commandText: string) => Object.freeze([...baseArgs, '/d', '/s', '/c', commandText]),
    availabilityArgs: (binary: string) => Object.freeze([...baseArgs, '/d', '/s', '/c', `where ${binary}`]),
  });
}

/**
 * Resolves a configured executable field that may contain one or many candidate paths.
 *
 * @param executable Configured path or list of fallback paths.
 * @returns Resolved executable path when one candidate exists.
 */
function resolveConfiguredExecutable(executable: string | readonly string[] | undefined): string | null {
  if (!executable) {
    return null;
  }
  const candidates = Array.isArray(executable) ? executable : [executable];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
      return trimmed;
    }
    const resolved = resolveCommandBinary(trimmed, process.cwd());
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

/**
 * Resolves the most appropriate Windows terminal profile from VS Code terminal settings.
 *
 * @returns Preferred Windows shell profile, or `null` when settings do not select a usable shell.
 */
function resolveVsCodeWindowsTerminalProfile(): ShellProfile | null {
  try {
    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const automationProfile = terminalConfig.get<TerminalProfileConfig>('automationProfile.windows');
    const defaultProfileName = terminalConfig.get<string>('defaultProfile.windows');
    const profiles = terminalConfig.get<Record<string, TerminalProfileConfig>>('profiles.windows') ?? {};
    const deprecatedShell = terminalConfig.get<string>('shell.windows');
    const deprecatedArgs = terminalConfig.get<string[]>('shellArgs.windows') ?? [];
    const selected = automationProfile ?? (defaultProfileName ? profiles[defaultProfileName] : undefined);
    const configuredExecutable =
      resolveConfiguredExecutable(selected?.path) ??
      resolveConfiguredExecutable(deprecatedShell);
    const baseArgs = Object.freeze([...(selected?.args ?? deprecatedArgs)]);

    const configuredSource = selected?.source?.toLowerCase() ?? '';
    const executableName = (configuredExecutable ?? '').toLowerCase();
    if (configuredExecutable) {
      if (
        configuredSource.includes('powershell') ||
        executableName.endsWith('pwsh.exe') ||
        executableName.endsWith('powershell.exe') ||
        executableName === 'pwsh' ||
        executableName === 'powershell'
      ) {
        return createPowerShellWithArgs(configuredExecutable, baseArgs);
      }
      if (
        configuredSource.includes('command prompt') ||
        executableName.endsWith('cmd.exe') ||
        executableName === 'cmd'
      ) {
        return createCmdShellWithArgs(configuredExecutable, baseArgs);
      }
      if (
        configuredSource.includes('git bash') ||
        executableName.endsWith('bash.exe') ||
        executableName.endsWith('zsh.exe') ||
        executableName.endsWith('sh.exe')
      ) {
        return createPosixShellWithArgs(configuredExecutable, baseArgs);
      }
    }

    if (configuredSource.includes('powershell')) {
      if (commandExistsOnPath('pwsh')) {
        return createPowerShellWithArgs('pwsh', baseArgs);
      }
      if (commandExistsOnPath('powershell')) {
        return createPowerShellWithArgs('powershell', baseArgs);
      }
    }
    if (configuredSource.includes('command prompt')) {
      return createCmdShellWithArgs('cmd.exe', baseArgs);
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Resolves the preferred shell profile for the current platform.
 *
 * @returns Shell profile used by runtime command execution.
 */
export function resolveShellProfile(): ShellProfile {
  if (process.platform === 'win32') {
    const configuredProfile = resolveVsCodeWindowsTerminalProfile();
    if (configuredProfile) {
      return configuredProfile;
    }
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

/**
 * Checks whether a binary is available in the resolved shell environment.
 *
 * @param binary Binary name to probe.
 * @param cwd Working directory used for path-based resolution.
 * @returns `true` when the binary is available.
 */
export function checkCommandAvailability(binary: string, cwd: string): boolean {
  return resolveCommandBinary(binary, cwd) !== null;
}

/**
 * Resolves a binary name or path into the executable that should be spawned directly.
 *
 * @param binary Binary name or relative/absolute path.
 * @param cwd Working directory used for relative path resolution.
 * @returns Resolved executable path or binary name, or `null` when unavailable.
 */
export function resolveCommandBinary(binary: string, cwd: string): string | null {
  const trimmed = binary.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.includes('/') || trimmed.includes('\\')) {
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
    return isExecutableFile(resolved) ? resolved : null;
  }

  if (process.platform === 'win32') {
    const env = buildShellEnvironment();
    const pathEntries = normalizePathEntries(env.PATH);
    const pathExts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const candidateExts = trimmed.includes('.')
      ? ['']
      : ['', ...pathExts];

    const preferred = resolveBinaryFromEntries(trimmed, pathEntries, candidateExts);
    if (preferred) {
      return preferred;
    }

    const whereResult = spawnSync('where.exe', [trimmed], {
      cwd,
      stdio: 'pipe',
      timeout: COMMAND_AVAILABILITY_TIMEOUT_MS,
      env,
    });
    if (!whereResult.error && whereResult.status === 0) {
      const output = String(whereResult.stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const firstExisting = output.find((candidate) => isExecutableFile(candidate));
      if (firstExisting) {
        return firstExisting;
      }
    }
    return null;
  }

  const shell = resolveShellProfile();
  const result = spawnSync(shell.executable, [...shell.availabilityArgs(binary)], {
    cwd,
    stdio: 'pipe',
    timeout: COMMAND_AVAILABILITY_TIMEOUT_MS,
    env: buildShellEnvironment(),
  });
  return !result.error && result.status === 0 ? trimmed : null;
}
