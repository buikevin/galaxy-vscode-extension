/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Background managed command lifecycle helpers for the VS Code runtime.
 */

import { spawn } from 'node:child_process';
import { buildShellEnvironment, resolveShellProfile } from '../../runtime/shell-resolver';
import type { ToolResult } from '../entities/file-tools';
import type { ManagedCommandRecord, ProjectCommandMeta, StartManagedCommandOptions } from '../entities/project-command';
import { MAX_CAPTURED_OUTPUT_CHARS } from './constants';
import { buildManagedMeta, buildTailOutput, createCommandId, pruneManagedCommands, resolveProjectCommandExecution } from './core';
import { managedCommands } from './state';

/**
 * Starts one command under managed background tracking.
 *
 * @param workspacePath Absolute workspace root.
 * @param commandOrId Raw command text or a project-command id.
 * @param options Optional cwd, output limits, and stream callbacks.
 * @returns Tool result containing the managed command id.
 */
export function startManagedCommandTool(
  workspacePath: string,
  commandOrId: string,
  options?: StartManagedCommandOptions,
): ToolResult {
  const startedAt = Date.now();
  const resolved = resolveProjectCommandExecution(workspacePath, commandOrId, options?.cwd);
  if ('success' in resolved) {
    return resolved;
  }
  const commandId = createCommandId();
  const maxChars = Math.max(options?.maxChars ?? 8_000, 500);
  const child = resolved.directCommand
    ? spawn(resolved.directCommand.resolvedBinary, [...resolved.directCommand.args], {
        cwd: resolved.commandCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildShellEnvironment(),
        detached: true,
        shell: false,
      })
    : (() => {
        const shell = resolveShellProfile();
        return spawn(shell.executable, [...shell.commandArgs(resolved.commandText)], {
          cwd: resolved.commandCwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildShellEnvironment(),
          detached: true,
        });
      })();
  let resolveCompletion!: (value: ProjectCommandMeta) => void;
  const completionPromise = new Promise<ProjectCommandMeta>((resolve) => {
    resolveCompletion = resolve;
  });
  const record: ManagedCommandRecord = {
    commandId,
    commandText: resolved.commandText,
    commandLabel: resolved.commandLabel,
    category: resolved.commandCategory,
    cwd: resolved.commandCwd,
    startedAt,
    child,
    output: '',
    totalChars: 0,
    completed: false,
    ...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
    completionPromise,
    resolveCompletion,
  };
  managedCommands.set(commandId, record);
  pruneManagedCommands();
  void options?.stream?.onStart?.({ commandText: resolved.commandText, cwd: resolved.commandCwd, startedAt });
  const appendChunk = async (chunk: string): Promise<void> => {
    if (!chunk) {return;}
    record.totalChars += chunk.length;
    record.output = `${record.output}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
    await options?.stream?.onChunk?.({ chunk });
  };
  const finalize = async (meta: ProjectCommandMeta): Promise<void> => {
    if (record.completed) {return;}
    record.completed = true;
    record.success = meta.exitCode === 0;
    record.exitCode = meta.exitCode;
    record.durationMs = meta.durationMs;
    record.resolveCompletion(meta);
    await options?.stream?.onEnd?.({ exitCode: meta.exitCode, success: meta.exitCode === 0, durationMs: meta.durationMs, background: true });
    await options?.stream?.onComplete?.({
      commandText: record.commandText,
      cwd: record.cwd,
      exitCode: meta.exitCode,
      success: meta.exitCode === 0,
      durationMs: meta.durationMs,
      output: meta.tailOutput,
      background: true,
    });
  };
  child.stdout.on('data', (data: Buffer | string) => {
    void appendChunk(String(data));
  });
  child.stderr.on('data', (data: Buffer | string) => {
    void appendChunk(String(data));
  });
  child.on('error', (error) => {
    const durationMs = Date.now() - startedAt;
    const { tailOutput, truncated } = buildTailOutput(String(error), maxChars);
    void finalize(buildManagedMeta({ ...record, durationMs, exitCode: 1 }, tailOutput, truncated));
  });
  child.on('close', (code) => {
    const durationMs = Date.now() - startedAt;
    const { tailOutput, truncated } = buildTailOutput(record.output, maxChars);
    void finalize(buildManagedMeta({ ...record, durationMs, exitCode: Number(code ?? 0) }, tailOutput, truncated));
  });
  child.unref();
  return Object.freeze({
    success: true,
    content: '[started] Command handed off to a VS Code terminal.\nUse View terminal to inspect live output while Galaxy continues working.',
    meta: Object.freeze({
      commandId,
      commandLabel: resolved.commandLabel,
      commandText: resolved.commandText,
      category: resolved.commandCategory,
      cwd: resolved.commandCwd,
      exitCode: 0,
      durationMs: 0,
      truncated: false,
      totalChars: 0,
      tailOutput: '(command started)',
      commandState: 'running',
      running: true,
      background: true,
    }),
  });
}

/**
 * Waits for one managed background command to complete or times out.
 *
 * @param commandId Managed command id.
 * @param options Optional timeout and output limit.
 * @returns Tool result with either running state or final status.
 */
export async function awaitManagedProjectCommandTool(commandId: string, options?: { timeoutMs?: number; maxChars?: number }): Promise<ToolResult> {
  const record = managedCommands.get(commandId);
  if (!record) {
    return Object.freeze({ success: false, content: '', error: `Unknown command id: ${commandId}` });
  }
  const timeoutMs = Math.max(options?.timeoutMs ?? 15_000, 100);
  const meta = await Promise.race<ProjectCommandMeta | null>([
    record.completionPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!meta) {
    const { tailOutput, truncated } = buildTailOutput(record.output, Math.max(options?.maxChars ?? 8_000, 500));
    return Object.freeze({
      success: true,
      content: 'Command is still running. Use View terminal for live output.',
      meta: Object.freeze({
        commandId: record.commandId,
        commandLabel: record.commandLabel,
        commandText: record.commandText,
        category: record.category,
        cwd: record.cwd,
        exitCode: 0,
        durationMs: Date.now() - record.startedAt,
        truncated,
        totalChars: record.totalChars,
        tailOutput,
        commandState: 'running',
        running: true,
        background: true,
      }),
    });
  }
  return Object.freeze({
    success: meta.exitCode === 0,
    content: meta.exitCode === 0 ? 'Command completed.' : 'Command failed.',
    ...(meta.exitCode === 0 ? {} : { error: `Project command failed: ${meta.commandLabel}` }),
    meta,
  });
}

/**
 * Reads the current tail output of one managed background command.
 *
 * @param commandId Managed command id.
 * @param options Optional output limit.
 * @returns Tool result containing tail output and current status.
 */
export function getManagedProjectCommandOutputTool(commandId: string, options?: { maxChars?: number }): ToolResult {
  const record = managedCommands.get(commandId);
  if (!record) {
    return Object.freeze({ success: false, content: '', error: `Unknown command id: ${commandId}` });
  }
  const { tailOutput, truncated } = buildTailOutput(record.output, Math.max(options?.maxChars ?? 8_000, 500));
  return Object.freeze({
    success: true,
    content: tailOutput,
    meta: Object.freeze({
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
      commandState: record.completed ? ((record.exitCode ?? 1) === 0 ? 'completed' : 'failed') : 'running',
      ...(record.completed ? {} : { running: true }),
      background: true,
    }),
  });
}

/**
 * Sends SIGTERM to one managed background command when it is still running.
 *
 * @param commandId Managed command id.
 * @returns Tool result describing the kill request.
 */
export function killManagedProjectCommandTool(commandId: string): ToolResult {
  const record = managedCommands.get(commandId);
  if (!record) {
    return Object.freeze({ success: false, content: '', error: `Unknown command id: ${commandId}` });
  }
  if (record.completed) {
    return Object.freeze({
      success: true,
      content: 'Command already completed.',
      meta: Object.freeze({
        commandId: record.commandId,
        commandLabel: record.commandLabel,
        commandText: record.commandText,
        category: record.category,
        cwd: record.cwd,
        exitCode: record.exitCode ?? 0,
        durationMs: record.durationMs ?? (Date.now() - record.startedAt),
        truncated: false,
        totalChars: record.totalChars,
        tailOutput: buildTailOutput(record.output, 500).tailOutput,
        commandState: (record.exitCode ?? 1) === 0 ? 'completed' : 'failed',
        background: true,
      }),
    });
  }
  record.child.kill('SIGTERM');
  return Object.freeze({
    success: true,
    content: 'Kill signal sent to command.',
    meta: Object.freeze({
      commandId: record.commandId,
      commandLabel: record.commandLabel,
      commandText: record.commandText,
      category: record.category,
      cwd: record.cwd,
      exitCode: 0,
      durationMs: Date.now() - record.startedAt,
      truncated: false,
      totalChars: record.totalChars,
      tailOutput: buildTailOutput(record.output, 500).tailOutput,
      commandState: 'running',
      running: true,
      background: true,
    }),
  });
}
