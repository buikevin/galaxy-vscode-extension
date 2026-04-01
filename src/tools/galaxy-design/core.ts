/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Core Galaxy Design project detection and action-planning helpers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  GalaxyDesignActionPlan,
  GalaxyDesignCanonicalFramework,
  GalaxyDesignFramework,
  GalaxyDesignProjectInfo,
  GalaxyDesignRunner,
} from '../entities/galaxy-design';
import { buildShellEnvironment } from '../../runtime/shell-resolver';
import {
  GALAXY_DESIGN_TOOL_PACKAGE_SPEC,
} from './constants';

/**
 * Returns whether one absolute path stays inside the expected base directory.
 *
 * @param targetPath Absolute path to validate.
 * @param basePath Absolute base directory.
 * @returns True when the target path remains inside the base path.
 */
function isWithinDirectory(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves an optional workspace-relative path while enforcing workspace boundaries.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath Optional user-provided project path.
 * @returns Absolute path or a structured error when the path escapes the workspace.
 */
function resolveWorkspacePath(
  workspaceRoot: string,
  rawPath?: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const resolved = path.resolve(rawPath?.trim() ? path.resolve(workspaceRoot, rawPath) : workspaceRoot);
  if (!isWithinDirectory(resolved, workspaceRoot)) {
    return {
      ok: false,
      error: `Galaxy Design tools must stay inside the current workspace: ${workspaceRoot}`,
    };
  }
  return { ok: true, value: resolved };
}

/**
 * Maps framework aliases to the canonical registry framework key.
 *
 * @param framework Detected project framework.
 * @returns Canonical framework used for registry lookup.
 */
export function canonicalFramework(framework: GalaxyDesignFramework): GalaxyDesignCanonicalFramework {
  if (framework === 'nextjs') {
    return 'react';
  }
  if (framework === 'nuxtjs') {
    return 'vue';
  }
  return framework;
}

/**
 * Reads and parses a JSON file when it exists.
 *
 * @param filePath Absolute JSON file path.
 * @returns Parsed object or null when the file is missing or invalid.
 */
function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Detects the current project's framework from config files and package dependencies.
 *
 * @param targetPath Absolute project directory.
 * @returns Detected framework or unknown.
 */
function detectFramework(targetPath: string): GalaxyDesignFramework | 'unknown' {
  const componentsConfigPath = path.join(targetPath, 'components.json');
  const componentsConfig = readJsonFile(componentsConfigPath);
  const configuredFramework = componentsConfig?.framework;
  if (
    configuredFramework === 'react' ||
    configuredFramework === 'nextjs' ||
    configuredFramework === 'vue' ||
    configuredFramework === 'nuxtjs' ||
    configuredFramework === 'angular' ||
    configuredFramework === 'react-native' ||
    configuredFramework === 'flutter'
  ) {
    return configuredFramework;
  }
  if (fs.existsSync(path.join(targetPath, 'pubspec.yaml'))) {
    return 'flutter';
  }
  const packageJson = readJsonFile(path.join(targetPath, 'package.json'));
  if (!packageJson) {
    return 'unknown';
  }
  const dependencies = {
    ...((packageJson.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((packageJson.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };
  if (typeof dependencies['react-native'] === 'string') {return 'react-native';}
  if (typeof dependencies.next === 'string') {return 'nextjs';}
  if (typeof dependencies.nuxt === 'string' || typeof dependencies.nuxt3 === 'string') {return 'nuxtjs';}
  if (typeof dependencies['@angular/core'] === 'string') {return 'angular';}
  if (typeof dependencies.react === 'string') {return 'react';}
  if (typeof dependencies.vue === 'string') {return 'vue';}
  return 'unknown';
}

/**
 * Detects which package manager should execute Galaxy Design commands.
 *
 * @param targetPath Absolute project directory.
 * @returns Package manager and the evidence source used to infer it.
 */
function detectPackageManager(targetPath: string): Pick<
  GalaxyDesignProjectInfo,
  'packageManager' | 'packageManagerSource'
> {
  const packageJson = readJsonFile(path.join(targetPath, 'package.json'));
  const packageManagerField = packageJson?.packageManager;
  if (typeof packageManagerField === 'string') {
    const name = packageManagerField.split('@')[0]?.trim().toLowerCase();
    if (name === 'bun' || name === 'pnpm' || name === 'yarn' || name === 'npm') {
      return { packageManager: name, packageManagerSource: 'package-json' };
    }
  }
  if (fs.existsSync(path.join(targetPath, 'bun.lock')) || fs.existsSync(path.join(targetPath, 'bun.lockb'))) {
    return { packageManager: 'bun', packageManagerSource: 'bun-lock' };
  }
  if (fs.existsSync(path.join(targetPath, 'pnpm-lock.yaml'))) {
    return { packageManager: 'pnpm', packageManagerSource: 'pnpm-lock' };
  }
  if (fs.existsSync(path.join(targetPath, 'yarn.lock'))) {
    return { packageManager: 'yarn', packageManagerSource: 'yarn-lock' };
  }
  if (fs.existsSync(path.join(targetPath, 'package-lock.json'))) {
    return { packageManager: 'npm', packageManagerSource: 'npm-lock' };
  }
  return { packageManager: 'npm', packageManagerSource: 'fallback' };
}

/**
 * Checks whether one executable can run successfully with the provided arguments.
 *
 * @param executable Binary to execute.
 * @param args Argument list for the probe command.
 * @returns True when the command is available.
 */
function isCommandAvailable(executable: string, args: readonly string[]): boolean {
  try {
    const result = spawnSync(executable, [...args], {
      stdio: 'ignore',
      encoding: 'utf-8',
      env: buildShellEnvironment(),
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Returns the executable used by the selected package manager.
 *
 * @param runner Selected package manager.
 * @returns Executable name used to launch Galaxy Design.
 */
function getRunnerExecutable(runner: GalaxyDesignRunner): string {
  switch (runner) {
    case 'bun':
      return 'bunx';
    case 'pnpm':
      return 'pnpm';
    case 'yarn':
      return 'yarn';
    case 'npm':
      return 'npx';
  }
}

/**
 * Checks whether the runner executable exists on the current machine.
 *
 * @param runner Selected package manager.
 * @returns True when the matching executable is available.
 */
function isRunnerAvailable(runner: GalaxyDesignRunner): boolean {
  return isCommandAvailable(getRunnerExecutable(runner), ['--version']);
}

/**
 * Quotes one shell argument for preview output.
 *
 * @param value Raw shell argument.
 * @returns Shell-safe preview string.
 */
function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the runner executable and arguments for one Galaxy Design action.
 *
 * @param runner Package manager runner selected for the machine.
 * @param action Galaxy Design action being prepared.
 * @param targetPath Absolute project path.
 * @param components Components requested for add operations.
 * @returns Executable, args, and a shell-safe preview string.
 */
function buildRunnerCommand(
  runner: GalaxyDesignRunner,
  action: 'init' | 'add',
  targetPath: string,
  components: readonly string[],
): Readonly<{ executable: string; args: readonly string[]; commandPreview: string }> {
  const cliArgs = action === 'init' ? ['init', '--yes', '--cwd', targetPath] : ['add', ...components, '--cwd', targetPath];
  if (runner === 'bun') {
    const args = [GALAXY_DESIGN_TOOL_PACKAGE_SPEC, ...cliArgs];
    return Object.freeze({ executable: 'bunx', args: Object.freeze(args), commandPreview: ['bunx', ...args].map(shellQuote).join(' ') });
  }
  if (runner === 'pnpm') {
    const args = ['dlx', GALAXY_DESIGN_TOOL_PACKAGE_SPEC, ...cliArgs];
    return Object.freeze({ executable: 'pnpm', args: Object.freeze(args), commandPreview: ['pnpm', ...args].map(shellQuote).join(' ') });
  }
  if (runner === 'yarn') {
    const args = ['dlx', GALAXY_DESIGN_TOOL_PACKAGE_SPEC, ...cliArgs];
    return Object.freeze({ executable: 'yarn', args: Object.freeze(args), commandPreview: ['yarn', ...args].map(shellQuote).join(' ') });
  }
  const args = ['-y', GALAXY_DESIGN_TOOL_PACKAGE_SPEC, ...cliArgs];
  return Object.freeze({ executable: 'npx', args: Object.freeze(args), commandPreview: ['npx', ...args].map(shellQuote).join(' ') });
}

/**
 * Normalizes component input from either a string or an array.
 *
 * @param raw Raw component input from tool params.
 * @returns Clean component names.
 */
function normalizeComponents(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    return Object.freeze(raw.map((item) => String(item ?? '').trim()).filter(Boolean));
  }
  if (typeof raw === 'string') {
    return Object.freeze(raw.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean));
  }
  return Object.freeze([]);
}

/**
 * Collects project-level Galaxy Design metadata for the target path.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param pathInput Optional user-provided project path.
 * @returns Structured project info or an error payload.
 */
export function getGalaxyDesignProjectInfo(
  workspaceRoot: string,
  pathInput?: string,
): GalaxyDesignProjectInfo | { error: string } {
  const resolved = resolveWorkspacePath(workspaceRoot, pathInput);
  if (!resolved.ok) {
    return { error: resolved.error };
  }
  const targetPath = resolved.value;
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    return { error: `Project path not found: ${targetPath}` };
  }
  const framework = detectFramework(targetPath);
  const { packageManager, packageManagerSource } = detectPackageManager(targetPath);
  const componentsConfigPath = path.join(targetPath, 'components.json');
  const galaxyDesignInitialized = fs.existsSync(componentsConfigPath);
  return Object.freeze({
    targetPath,
    framework,
    packageManager,
    packageManagerSource,
    galaxyDesignInitialized,
    ...(galaxyDesignInitialized ? { componentsConfigPath } : {}),
    ...(framework !== 'unknown' ? { registryFramework: canonicalFramework(framework) } : {}),
  });
}

/**
 * Prepares one Galaxy Design init/add action without executing it yet.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param action Galaxy Design action being prepared.
 * @param options Optional path and component inputs.
 * @returns Executable action plan or an error payload.
 */
export function prepareGalaxyDesignAction(
  workspaceRoot: string,
  action: 'init' | 'add',
  options?: {
    path?: string;
    components?: readonly string[] | string;
  },
): GalaxyDesignActionPlan | { error: string } {
  const info = getGalaxyDesignProjectInfo(workspaceRoot, options?.path);
  if ('error' in info) {
    return info;
  }
  if (info.framework === 'unknown') {
    return {
      error:
        `Could not detect the framework for ${info.targetPath}. ` +
        'Galaxy Design init/add requires a detectable React, Next.js, Vue, Nuxt.js, Angular, React Native, or Flutter project.',
    };
  }
  const components = normalizeComponents(options?.components);
  if (action === 'add' && components.length === 0) {
    return { error: 'galaxy_design_add requires at least one component name.' };
  }
  if (action === 'init' && info.galaxyDesignInitialized) {
    return { error: `Galaxy Design is already initialized at ${info.targetPath} (components.json already exists).` };
  }
  if (action === 'add' && !info.galaxyDesignInitialized) {
    return { error: `Galaxy Design is not initialized at ${info.targetPath}. Run galaxy_design_init first.` };
  }
  const runnerPackageManager = info.packageManager;
  if (!isRunnerAvailable(runnerPackageManager)) {
    return {
      error:
        `Project package manager is ${info.packageManager}, but the required runner ` +
        `"${getRunnerExecutable(runnerPackageManager)}" is not available on this machine. ` +
        'Install the matching package manager first instead of falling back to a different one.',
    };
  }
  const command = buildRunnerCommand(runnerPackageManager, action, info.targetPath, components);
  return Object.freeze({
    action,
    targetPath: info.targetPath,
    framework: info.framework,
    registryFramework: canonicalFramework(info.framework),
    packageManager: info.packageManager,
    runnerPackageManager,
    packageManagerSource: info.packageManagerSource,
    componentsConfigExists: info.galaxyDesignInitialized,
    executable: command.executable,
    args: command.args,
    commandPreview: command.commandPreview,
    components,
  });
}
