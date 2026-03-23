import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findProjectCommand, getOrCreateProjectCommandProfile } from '../context/project-command-store';
import { buildShellEnvironment, checkCommandAvailability, resolveShellProfile } from '../runtime/shell-resolver';
import type { ProjectCommandDefinition } from '../context/project-command-detector';
import type { ToolResult } from './file-tools';

const BACKGROUND_STARTUP_GRACE_MS = 15_000;
const ASYNC_COMMAND_HANDOFF_MS = 12_000;
const BACKGROUND_READY_PATTERNS = [
  /ready in \d+/i,
  /compiled successfully/i,
  /local:\s+https?:\/\//i,
  /listening on/i,
  /server running/i,
  /app ready/i,
  /tauri app started/i,
  /watching for file changes/i,
] as const;

const ASYNC_FINITE_COMMAND_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+install\b/i,
  /\b(?:cargo|cargo-tauri|tauri)\s+(?:build|check|test)\b/i,
  /\b(?:pip|pip3|uv)\s+(?:install|sync)\b/i,
  /\b(?:poetry)\s+install\b/i,
] as const;

function commandExists(binary: string, cwd: string): boolean {
  if (binary.startsWith('./') || binary.includes('/')) {
    return fs.existsSync(path.resolve(cwd, binary));
  }
  return checkCommandAvailability(binary, cwd);
}

function getCommandBinary(command: string): string {
  return command.trim().split(/\s+/)[0] ?? '';
}

function isBackgroundCommand(commandText: string): boolean {
  const normalized = commandText.trim().toLowerCase();
  return /\b(?:dev|serve|watch|start)\b/.test(normalized)
    || normalized.includes('tauri dev')
    || normalized.includes('vite')
    || normalized.includes('next dev')
    || normalized.includes('nuxt dev')
    || normalized.includes('astro dev');
}

function looksLikeReadyOutput(output: string): boolean {
  return BACKGROUND_READY_PATTERNS.some((pattern) => pattern.test(output));
}

function isAsyncFiniteCommand(commandText: string): boolean {
  const normalized = commandText.trim().toLowerCase();
  if (isBackgroundCommand(normalized)) {
    return false;
  }
  return ASYNC_FINITE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getProjectCommandProfileTool(workspacePath: string): ReturnType<typeof getOrCreateProjectCommandProfile> {
  return getOrCreateProjectCommandProfile(workspacePath);
}

type ProjectCommandStreamHandlers = Readonly<{
  onStart?: (payload: Readonly<{ commandText: string; cwd: string; startedAt: number }>) => Promise<void> | void;
  onChunk?: (payload: Readonly<{ chunk: string }>) => Promise<void> | void;
  onEnd?: (payload: Readonly<{ exitCode: number; success: boolean; durationMs: number; background?: boolean }>) => Promise<void> | void;
  onComplete?: (payload: Readonly<{
    commandText: string;
    cwd: string;
    exitCode: number;
    success: boolean;
    durationMs: number;
    output: string;
    background: boolean;
  }>) => Promise<void> | void;
}>;

export function resolveProjectCommand(workspacePath: string, commandId: string): ProjectCommandDefinition | null {
  return findProjectCommand(workspacePath, commandId);
}

function resolveCwd(workspacePath: string, rawCwd?: string): string {
  if (!rawCwd) {
    return workspacePath;
  }

  const target = rawCwd
    ? (path.isAbsolute(rawCwd) ? path.resolve(rawCwd) : path.resolve(workspacePath, rawCwd))
    : workspacePath;
  const relative = path.relative(workspacePath, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return workspacePath;
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
  const backgroundMode = isBackgroundCommand(commandText);
  const asyncFiniteMode = isAsyncFiniteCommand(commandText);

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
      env: buildShellEnvironment(),
      ...(backgroundMode ? { detached: true } : {}),
    });

    const chunks: string[] = [];
    let totalChars = 0;
    let timedOut = false;
    let settled = false;
    let releasedToBackground = false;
    const timeoutMs = command?.timeoutMs ?? 120_000;

    const appendChunk = async (chunk: string): Promise<void> => {
      if (!chunk) {
        return;
      }

      chunks.push(chunk);
      totalChars += chunk.length;
      await options?.stream?.onChunk?.({ chunk });

      if (backgroundMode && !releasedToBackground && looksLikeReadyOutput(chunks.join(''))) {
        finalizeAsBackground();
      }
    };

    const finalize = async (result: ToolResult): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      if (!releasedToBackground) {
        clearTimeout(timer);
        await options?.stream?.onEnd?.({
          exitCode: Number(result.meta?.exitCode ?? (result.success ? 0 : 1)),
          success: result.success,
          durationMs: Number(result.meta?.durationMs ?? Date.now() - startedAt),
          background: false,
        });
      }
      resolve(result);
    };

    const finalizeAsBackground = (): void => {
      if (releasedToBackground) {
        return;
      }
      releasedToBackground = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const raw = chunks.join('').trim() || '(background command started)';
      const truncated = raw.length > maxChars;
      const content = truncated
        ? `${raw.slice(0, maxChars)}\n...[truncated ${raw.length - maxChars} chars]`
        : raw;
      if (backgroundMode) {
        child.unref();
      }
      void finalize(Object.freeze({
        success: true,
        content:
          `${content}\n\n` +
          `[background] Command handed off. Galaxy will continue now and resume when the command completes.`,
        meta: Object.freeze({
          commandId: command?.id ?? commandText,
          commandLabel,
          commandText,
          category: commandCategory,
          cwd: commandCwd,
          exitCode: 0,
          durationMs,
          truncated,
          totalChars,
          background: true,
        }),
      }));
    };

    const timer = setTimeout(() => {
      if (backgroundMode || asyncFiniteMode) {
        finalizeAsBackground();
        return;
      }
      timedOut = true;
      child.kill('SIGTERM');
    }, backgroundMode ? BACKGROUND_STARTUP_GRACE_MS : asyncFiniteMode ? ASYNC_COMMAND_HANDOFF_MS : timeoutMs);

    child.stdout.on('data', (data: Buffer | string) => {
      void appendChunk(String(data));
    });

    child.stderr.on('data', (data: Buffer | string) => {
      void appendChunk(String(data));
    });

    child.on('error', async (error) => {
      const durationMs = Date.now() - startedAt;
      const failure = Object.freeze({
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
      });

      if (releasedToBackground) {
        await options?.stream?.onEnd?.({
          exitCode: 1,
          success: false,
          durationMs,
          background: true,
        });
        await options?.stream?.onComplete?.({
          commandText,
          cwd: commandCwd,
          exitCode: 1,
          success: false,
          durationMs,
          output: String(error),
          background: true,
        });
        return;
      }

      await finalize(failure);
    });

    child.on('close', async (code) => {
      if (settled && !releasedToBackground) {
        return;
      }
      const durationMs = Date.now() - startedAt;
      const raw = chunks.join('').trim() || (timedOut ? '(command timed out)' : '(no output)');
      const truncated = raw.length > maxChars;
      const content = truncated
        ? `${raw.slice(0, maxChars)}\n...[truncated ${raw.length - maxChars} chars]`
        : raw;
      const exitCode = timedOut ? 124 : Number(code ?? 0);
      const success = exitCode === 0;

      const result = Object.freeze({
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
          ...(releasedToBackground ? { background: true } : {}),
        }),
      });

      if (releasedToBackground) {
        await options?.stream?.onEnd?.({
          exitCode,
          success,
          durationMs,
          background: true,
        });
        await options?.stream?.onComplete?.({
          commandText,
          cwd: commandCwd,
          exitCode,
          success,
          durationMs,
          output: content,
          background: true,
        });
        return;
      }

      await finalize(result);
    });
  });
}
