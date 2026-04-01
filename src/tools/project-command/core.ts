/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Core helpers for resolving, validating, and classifying project commands in the VS Code runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findProjectCommand, getOrCreateProjectCommandProfile } from '../../context/project-command-store';
import type { ProjectCommandDefinition } from '../../context/entities/project-command';
import { tryResolveDirectCommand } from '../../runtime/direct-command';
import { checkCommandAvailability } from '../../runtime/shell-resolver';
import type { ToolResult } from '../entities/file-tools';
import type { ManagedCommandRecord, ProjectCommandMeta, ResolvedProjectCommand } from '../entities/project-command';
import { ASYNC_FINITE_COMMAND_PATTERNS, BACKGROUND_READY_PATTERNS, MAX_MANAGED_COMMANDS } from './constants';
import { managedCommands } from './state';

/**
 * Builds a random runtime id for one managed command instance.
 *
 * @returns Unique command id.
 */
export function createCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Converts raw command output into a tail buffer and truncation flag.
 *
 * @param raw Full raw output.
 * @param maxChars Maximum number of characters to retain.
 * @returns Tail output buffer plus truncation metadata.
 */
export function buildTailOutput(raw: string, maxChars: number): Readonly<{ tailOutput: string; truncated: boolean }> {
  const normalized = raw.trim() || '(no output)';
  const truncated = normalized.length > maxChars;
  return Object.freeze({
    tailOutput: truncated
      ? `${normalized.slice(-maxChars)}\n...[truncated ${normalized.length - maxChars} chars earlier]`
      : normalized,
    truncated,
  });
}

/**
 * Removes old completed commands when the in-memory registry grows too large.
 *
 * @returns Nothing.
 */
export function pruneManagedCommands(): void {
  if (managedCommands.size <= MAX_MANAGED_COMMANDS) {
    return;
  }
  const completed = [...managedCommands.values()]
    .filter((record) => record.completed)
    .sort((a, b) => a.startedAt - b.startedAt);
  while (managedCommands.size > MAX_MANAGED_COMMANDS && completed.length > 0) {
    const next = completed.shift();
    if (next) {
      managedCommands.delete(next.commandId);
    }
  }
}

/**
 * Extracts the leading binary token from a shell command string.
 *
 * @param command Raw command text.
 * @returns Leading binary token or an empty string.
 */
export function getCommandBinary(command: string): string {
  return command.trim().split(/\s+/)[0] ?? '';
}

/**
 * Checks whether a binary exists either as a relative file or on PATH.
 *
 * @param binary Binary or relative executable path.
 * @param cwd Absolute working directory used for relative resolution.
 * @returns True when the command can be launched.
 */
export function commandExists(binary: string, cwd: string): boolean {
  if (binary.startsWith('./') || binary.includes('/')) {
    return fs.existsSync(path.resolve(cwd, binary));
  }
  return checkCommandAvailability(binary, cwd);
}

/**
 * Determines whether a command behaves like a long-running background process.
 *
 * @param commandText Raw command text.
 * @returns True when the command should be treated as background.
 */
export function isBackgroundCommand(commandText: string): boolean {
  const normalized = commandText.trim().toLowerCase();
  return /\b(?:dev|serve|watch|start)\b/.test(normalized)
    || normalized.includes('tauri dev')
    || normalized.includes('vite')
    || normalized.includes('next dev')
    || normalized.includes('nuxt dev')
    || normalized.includes('astro dev');
}

/**
 * Checks whether captured output looks like a ready signal for background handoff.
 *
 * @param output Rolling command output.
 * @returns True when output indicates readiness.
 */
export function looksLikeReadyOutput(output: string): boolean {
  return BACKGROUND_READY_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * Determines whether a command is finite but should still be handed off asynchronously.
 *
 * @param commandText Raw command text.
 * @returns True when the command matches the async finite heuristic.
 */
export function isAsyncFiniteCommand(commandText: string): boolean {
  const normalized = commandText.trim().toLowerCase();
  if (isBackgroundCommand(normalized)) {
    return false;
  }
  return ASYNC_FINITE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns the persisted project-command profile for one workspace.
 *
 * @param workspacePath Absolute workspace root.
 * @returns Existing or newly created command profile.
 */
export function getProjectCommandProfileTool(workspacePath: string): ReturnType<typeof getOrCreateProjectCommandProfile> {
  return getOrCreateProjectCommandProfile(workspacePath);
}

/**
 * Resolves one project command definition by id.
 *
 * @param workspacePath Absolute workspace root.
 * @param commandId Project command id.
 * @returns Matching command definition or null.
 */
export function resolveProjectCommand(workspacePath: string, commandId: string): ProjectCommandDefinition | null {
  return findProjectCommand(workspacePath, commandId);
}

/**
 * Resolves a safe working directory inside the workspace.
 *
 * @param workspacePath Absolute workspace root.
 * @param rawCwd Optional relative or absolute cwd input.
 * @returns Absolute cwd clamped to the workspace root.
 */
export function resolveCwd(workspacePath: string, rawCwd?: string): string {
  if (!rawCwd) {
    return workspacePath;
  }
  const target = path.isAbsolute(rawCwd) ? path.resolve(rawCwd) : path.resolve(workspacePath, rawCwd);
  const relative = path.relative(workspacePath, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return workspacePath;
  }
  return target;
}

/**
 * Resolves command text, label, cwd, and direct-command execution plan for one request.
 *
 * @param workspacePath Absolute workspace root.
 * @param commandOrId Raw command text or a project-command id.
 * @param rawCwd Optional cwd override.
 * @returns Either a tool error payload or the resolved command execution plan.
 */
export function resolveProjectCommandExecution(
  workspacePath: string,
  commandOrId: string,
  rawCwd?: string,
): ToolResult | ResolvedProjectCommand {
  const startedAt = Date.now();
  const commandId = commandOrId.trim();
  const resolvedCwd = resolveCwd(workspacePath, rawCwd);
  const command = resolveProjectCommand(workspacePath, commandId);
  const commandText = command?.command ?? commandOrId.trim();
  const commandLabel = command?.label ?? commandText;
  const commandCategory = command?.category ?? 'custom';
  const commandCwd = command?.cwd ?? resolvedCwd;
  const directCommand = tryResolveDirectCommand(commandText, commandCwd);
  const effectiveCommandText = directCommand?.displayCommandText ?? commandText;
  if (!commandText) {
    return Object.freeze({
      success: false,
      content: '',
      error: 'Command is required.',
    });
  }
  const binary = directCommand?.binary ?? getCommandBinary(commandText);
  if (!binary || !commandExists(binary, commandCwd)) {
    return Object.freeze({
      success: false,
      content: '',
      error: `Required command is not available: ${binary || commandText}`,
      meta: Object.freeze({
        commandId: command?.id ?? commandText,
        commandLabel,
        commandText: effectiveCommandText,
        category: commandCategory,
        cwd: commandCwd,
        exitCode: 127,
        durationMs: Date.now() - startedAt,
        truncated: false,
      }),
    });
  }
  return Object.freeze({
    commandId: command?.id ?? commandText,
    commandText: effectiveCommandText,
    commandLabel,
    commandCategory,
    commandCwd,
    ...(directCommand ? { directCommand } : {}),
  });
}

/**
 * Builds the shared metadata payload for one managed command record.
 *
 * @param record Managed command record.
 * @param tailOutput Tail output buffer.
 * @param truncated Whether output was truncated.
 * @returns Immutable metadata payload.
 */
export function buildManagedMeta(
  record: Readonly<{
    commandId: string;
    commandLabel: string;
    commandText: string;
    category: string;
    cwd: string;
    totalChars: number;
    startedAt: number;
    exitCode?: number;
    durationMs?: number;
  }>,
  tailOutput: string,
  truncated: boolean,
): ProjectCommandMeta {
  return Object.freeze({
    commandId: record.commandId,
    commandLabel: record.commandLabel,
    commandText: record.commandText,
    category: record.category,
    cwd: record.cwd,
    exitCode: record.exitCode ?? 0,
    durationMs: record.durationMs ?? (Date.now() - record.startedAt),
    truncated,
    totalChars: record.totalChars,
    tailOutput,
    background: true,
  });
}
