/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Foreground and auto-handoff project command execution helpers for the VS Code runtime.
 */

import { spawn } from 'node:child_process';
import { buildShellEnvironment, resolveShellProfile } from '../../runtime/shell-resolver';
import type { ToolResult } from '../entities/file-tools';
import type { RunProjectCommandOptions } from '../entities/project-command';
import { ASYNC_COMMAND_HANDOFF_MS, BACKGROUND_STARTUP_GRACE_MS, MAX_CAPTURED_OUTPUT_CHARS } from './constants';
import { buildTailOutput, isAsyncFiniteCommand, isBackgroundCommand, looksLikeReadyOutput, resolveProjectCommandExecution } from './core';
import { startManagedCommandTool } from './managed';

/**
 * Executes one project command in the foreground, with optional background handoff heuristics.
 *
 * @param workspacePath Absolute workspace root.
 * @param commandOrId Raw command text or a project-command id.
 * @param options Optional cwd, stream hooks, output limits, and handoff flags.
 * @returns Tool result describing command success, failure, or background handoff.
 */
export async function runProjectCommandTool(
  workspacePath: string,
  commandOrId: string,
  options?: RunProjectCommandOptions,
): Promise<ToolResult> {
  if (options?.asyncStartOnly) {
    return startManagedCommandTool(workspacePath, commandOrId, options);
  }
  const startedAt = Date.now();
  const resolved = resolveProjectCommandExecution(workspacePath, commandOrId, options?.cwd);
  if ('success' in resolved) {
    return resolved;
  }
  const commandText = resolved.commandText;
  const commandLabel = resolved.commandLabel;
  const commandCategory = resolved.commandCategory;
  const commandCwd = resolved.commandCwd;
  const backgroundMode = isBackgroundCommand(commandText);
  const asyncFiniteMode = isAsyncFiniteCommand(commandText);
  await options?.stream?.onStart?.({ commandText, cwd: commandCwd, startedAt });
  const maxChars = Math.max(options?.maxChars ?? 8_000, 500);
  return await new Promise<ToolResult>((resolve) => {
    const child = resolved.directCommand
      ? spawn(resolved.directCommand.resolvedBinary, [...resolved.directCommand.args], {
          cwd: commandCwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildShellEnvironment(),
          shell: false,
          ...(backgroundMode ? { detached: true } : {}),
        })
      : (() => {
          const shell = resolveShellProfile();
          return spawn(shell.executable, [...shell.commandArgs(commandText)], {
            cwd: commandCwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildShellEnvironment(),
            ...(backgroundMode ? { detached: true } : {}),
          });
        })();
    let totalChars = 0;
    let timedOut = false;
    let settled = false;
    let releasedToBackground = false;
    let capturedOutput = '';
    const timeoutMs = 120_000;
    const appendChunk = async (chunk: string): Promise<void> => {
      if (!chunk) {return;}
      totalChars += chunk.length;
      capturedOutput = `${capturedOutput}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
      await options?.stream?.onChunk?.({ chunk });
      if (backgroundMode && !releasedToBackground && looksLikeReadyOutput(capturedOutput)) {
        finalizeAsBackground();
      }
    };
    const finalize = async (result: ToolResult): Promise<void> => {
      if (settled) {return;}
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
      if (releasedToBackground) {return;}
      releasedToBackground = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const raw = capturedOutput.trim() || '(background command started)';
      const truncated = raw.length > maxChars;
      const tailOutput = truncated ? `${raw.slice(-maxChars)}\n...[truncated ${raw.length - maxChars} chars earlier]` : raw;
      if (backgroundMode) {
        child.unref();
      }
      void finalize(Object.freeze({
        success: true,
        content: '[background] Command handed off to a VS Code terminal.\nUse View terminal to inspect live output while Galaxy continues working.',
        meta: Object.freeze({
          commandId: resolved.commandId,
          commandLabel,
          commandText,
          category: commandCategory,
          cwd: commandCwd,
          exitCode: 0,
          durationMs,
          truncated,
          totalChars,
          background: true,
          tailOutput,
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
          commandId: resolved.commandId,
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
        await options?.stream?.onEnd?.({ exitCode: 1, success: false, durationMs, background: true });
        await options?.stream?.onComplete?.({ commandText, cwd: commandCwd, exitCode: 1, success: false, durationMs, output: String(error), background: true });
        return;
      }
      await finalize(failure);
    });
    child.on('close', async (code) => {
      if (settled && !releasedToBackground) {return;}
      const durationMs = Date.now() - startedAt;
      const raw = capturedOutput.trim() || (timedOut ? '(command timed out)' : '(no output)');
      const truncated = raw.length > maxChars;
      const tailOutput = truncated ? `${raw.slice(-maxChars)}\n...[truncated ${raw.length - maxChars} chars earlier]` : raw;
      const exitCode = timedOut ? 124 : Number(code ?? 0);
      const success = exitCode === 0;
      const result = Object.freeze({
        success,
        content: success ? 'Command completed. Use View terminal for the full output.' : 'Command failed. Use View terminal for the full output.',
        ...(success ? {} : { error: timedOut ? `Project command timed out: ${commandLabel}` : `Project command failed: ${commandLabel}` }),
        meta: Object.freeze({
          commandId: resolved.commandId,
          commandLabel,
          commandText,
          category: commandCategory,
          cwd: commandCwd,
          exitCode,
          durationMs,
          truncated,
          totalChars,
          tailOutput,
          ...(releasedToBackground ? { background: true } : {}),
        }),
      });
      if (releasedToBackground) {
        await options?.stream?.onEnd?.({ exitCode, success, durationMs, background: true });
        await options?.stream?.onComplete?.({ commandText, cwd: commandCwd, exitCode, success, durationMs, output: tailOutput, background: true });
        return;
      }
      await finalize(result);
    });
  });
}
