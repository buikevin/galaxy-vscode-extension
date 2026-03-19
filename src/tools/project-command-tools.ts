import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findProjectCommand, getOrCreateProjectCommandProfile } from '../context/project-command-store';
import { checkCommandAvailability, resolveShellProfile } from '../runtime/shell-resolver';
import type { ProjectCommandDefinition } from '../context/project-command-detector';
import type { ToolResult } from './file-tools';

function commandExists(binary: string, cwd: string): boolean {
  if (binary.startsWith('./') || binary.includes('/')) {
    return fs.existsSync(path.resolve(cwd, binary));
  }
  return checkCommandAvailability(binary, cwd);
}

function getCommandBinary(command: string): string {
  return command.trim().split(/\s+/)[0] ?? '';
}

export function getProjectCommandProfileTool(workspacePath: string): ReturnType<typeof getOrCreateProjectCommandProfile> {
  return getOrCreateProjectCommandProfile(workspacePath);
}

type ProjectCommandStreamHandlers = Readonly<{
  onStart?: (payload: Readonly<{ commandText: string; cwd: string; startedAt: number }>) => Promise<void> | void;
  onChunk?: (payload: Readonly<{ chunk: string }>) => Promise<void> | void;
  onEnd?: (payload: Readonly<{ exitCode: number; success: boolean; durationMs: number }>) => Promise<void> | void;
}>;

export function resolveProjectCommand(workspacePath: string, commandId: string): ProjectCommandDefinition | null {
  return findProjectCommand(workspacePath, commandId);
}

function resolveCwd(workspacePath: string, rawCwd?: string): string {
  const target = rawCwd
    ? (path.isAbsolute(rawCwd) ? path.resolve(rawCwd) : path.resolve(workspacePath, rawCwd))
    : workspacePath;
  const relative = path.relative(workspacePath, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`cwd must stay inside the workspace: ${rawCwd}`);
  }
  return target;
}

export async function runProjectCommandTool(
  workspacePath: string,
  commandOrId: string,
  options?: { cwd?: string; maxChars?: number; stream?: ProjectCommandStreamHandlers },
): Promise<ToolResult> {
  const startedAt = Date.now();
  const commandId = commandOrId.trim();
  const resolvedCwd = resolveCwd(workspacePath, options?.cwd);
  const command = resolveProjectCommand(workspacePath, commandId);
  const commandText = command?.command ?? commandOrId.trim();
  const commandLabel = command?.label ?? commandText;
  const commandCategory = command?.category ?? 'custom';
  const commandCwd = command?.cwd ?? resolvedCwd;

  if (!commandText) {
    return Object.freeze({
      success: false,
      content: '',
      error: 'Command is required.',
    });
  }

  const binary = getCommandBinary(commandText);
  if (!binary || !commandExists(binary, commandCwd)) {
    return Object.freeze({
      success: false,
      content: '',
      error: `Required command is not available: ${binary || commandText}`,
      meta: Object.freeze({
        commandId: command?.id ?? commandText,
        commandLabel,
        commandText,
        category: commandCategory,
        cwd: commandCwd,
        exitCode: 127,
        durationMs: Date.now() - startedAt,
        truncated: false,
      }),
    });
  }

  await options?.stream?.onStart?.({
    commandText,
    cwd: commandCwd,
    startedAt,
  });

  const maxChars = Math.max(options?.maxChars ?? 8_000, 500);
  const shell = resolveShellProfile();

  return await new Promise<ToolResult>((resolve) => {
    const child = spawn(shell.executable, [...shell.commandArgs(commandText)], {
      cwd: commandCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: string[] = [];
    let totalChars = 0;
    let timedOut = false;
    const timeoutMs = command?.timeoutMs ?? 120_000;

    const appendChunk = async (chunk: string): Promise<void> => {
      if (!chunk) {
        return;
      }

      chunks.push(chunk);
      totalChars += chunk.length;
      await options?.stream?.onChunk?.({ chunk });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer | string) => {
      void appendChunk(String(data));
    });

    child.stderr.on('data', (data: Buffer | string) => {
      void appendChunk(String(data));
    });

    child.on('error', async (error) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      await options?.stream?.onEnd?.({
        exitCode: 1,
        success: false,
        durationMs,
      });
      resolve(Object.freeze({
        success: false,
        content: String(error),
        error: `Project command failed: ${commandLabel}`,
        meta: Object.freeze({
          commandId: command?.id ?? commandText,
          commandLabel,
          commandText,
          category: commandCategory,
          cwd: commandCwd,
          exitCode: 1,
          durationMs,
          truncated: false,
        }),
      }));
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const raw = chunks.join('').trim() || (timedOut ? '(command timed out)' : '(no output)');
      const truncated = raw.length > maxChars;
      const content = truncated
        ? `${raw.slice(0, maxChars)}\n...[truncated ${raw.length - maxChars} chars]`
        : raw;
      const exitCode = timedOut ? 124 : Number(code ?? 0);
      const success = exitCode === 0;

      await options?.stream?.onEnd?.({
        exitCode,
        success,
        durationMs,
      });

      resolve(Object.freeze({
        success,
        content,
        ...(success ? {} : { error: timedOut ? `Project command timed out: ${commandLabel}` : `Project command failed: ${commandLabel}` }),
        meta: Object.freeze({
          commandId: command?.id ?? commandText,
          commandLabel,
          commandText,
          category: commandCategory,
          cwd: commandCwd,
          exitCode,
          durationMs,
          truncated,
          totalChars,
        }),
      }));
    });
  });
}
