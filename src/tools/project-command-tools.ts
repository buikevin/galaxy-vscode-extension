import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findProjectCommand, getOrCreateProjectCommandProfile } from '../context/project-command-store';
import { tryResolveDirectCommand, type DirectCommand } from '../runtime/direct-command';
import { buildShellEnvironment, checkCommandAvailability, resolveCommandBinary, resolveShellProfile } from '../runtime/shell-resolver';
import type { ProjectCommandDefinition } from '../context/project-command-detector';
import type { ToolResult } from './file-tools';

const BACKGROUND_STARTUP_GRACE_MS = 15_000;
const ASYNC_COMMAND_HANDOFF_MS = 12_000;
const MAX_CAPTURED_OUTPUT_CHARS = 20_000;
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

const MAX_MANAGED_COMMANDS = 32;

type ProjectCommandMeta = Readonly<{
  commandId: string;
  commandLabel: string;
  commandText: string;
  category: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  totalChars: number;
  tailOutput: string;
  background?: boolean;
}>;

type ManagedCommandRecord = {
  commandId: string;
  commandText: string;
  commandLabel: string;
  category: string;
  cwd: string;
  startedAt: number;
  child: ReturnType<typeof spawn>;
  output: string;
  totalChars: number;
  completed: boolean;
  success?: boolean;
  exitCode?: number;
  durationMs?: number;
  toolCallId?: string;
  completionPromise: Promise<ProjectCommandMeta>;
  resolveCompletion: (value: ProjectCommandMeta) => void;
};

const managedCommands = new Map<string, ManagedCommandRecord>();

function createCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildTailOutput(raw: string, maxChars: number): Readonly<{ tailOutput: string; truncated: boolean }> {
  const normalized = raw.trim() || '(no output)';
  const truncated = normalized.length > maxChars;
  return Object.freeze({
    tailOutput: truncated
      ? `${normalized.slice(-maxChars)}\n...[truncated ${normalized.length - maxChars} chars earlier]`
      : normalized,
    truncated,
  });
}

function pruneManagedCommands(): void {
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

function commandExists(binary: string, cwd: string): boolean {
  if (binary.startsWith('./') || binary.includes('/')) {
    return fs.existsSync(path.resolve(cwd, binary));
  }
  return checkCommandAvailability(binary, cwd);
}

async function runDirectBinaryTool(opts: Readonly<{
  workspacePath: string;
  cwd?: string;
  binary: string;
  args: readonly string[];
  label: string;
  category: string;
  maxChars?: number;
}>): Promise<ToolResult> {
  const startedAt = Date.now();
  const commandCwd = resolveCwd(opts.workspacePath, opts.cwd);
  const resolvedBinary = resolveCommandBinary(opts.binary, commandCwd);
  if (!resolvedBinary) {
    return Object.freeze({
      success: false,
      content: '',
      error: `Required command is not available: ${opts.binary}`,
      meta: Object.freeze({
        commandId: opts.binary,
        commandLabel: opts.label,
        commandText: `${opts.binary} ${opts.args.join(' ')}`.trim(),
        category: opts.category,
        cwd: commandCwd,
        exitCode: 127,
        durationMs: Date.now() - startedAt,
        truncated: false,
      }),
    });
  }

  const maxChars = Math.max(opts.maxChars ?? 8_000, 500);
  return await new Promise<ToolResult>((resolve) => {
    const child = spawn(resolvedBinary, [...opts.args], {
      cwd: commandCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildShellEnvironment(),
      shell: false,
    });

    let totalChars = 0;
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 120_000);

    const append = (chunk: string): void => {
      totalChars += chunk.length;
      output = `${output}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
    };

    child.stdout.on('data', (data: Buffer | string) => append(String(data)));
    child.stderr.on('data', (data: Buffer | string) => append(String(data)));
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Object.freeze({
        success: false,
        content: String(error),
        error: `${opts.label} failed.`,
        meta: Object.freeze({
          commandId: opts.binary,
          commandLabel: opts.label,
          commandText: `${opts.binary} ${opts.args.join(' ')}`.trim(),
          category: opts.category,
          cwd: commandCwd,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          truncated: false,
        }),
      }));
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const { tailOutput, truncated } = buildTailOutput(output, maxChars);
      const exitCode = Number(code ?? 0);
      resolve(Object.freeze({
        success: exitCode === 0,
        content: tailOutput,
        ...(exitCode === 0 ? {} : { error: `${opts.label} failed.` }),
        meta: Object.freeze({
          commandId: opts.binary,
          commandLabel: opts.label,
          commandText: `${opts.binary} ${opts.args.join(' ')}`.trim(),
          category: opts.category,
          cwd: commandCwd,
          exitCode,
          durationMs,
          truncated,
          totalChars,
          tailOutput,
        }),
      }));
    });
  });
}

export function gitStatusTool(
  workspacePath: string,
  options?: Readonly<{ cwd?: string; short?: boolean; pathspec?: string }>,
): Promise<ToolResult> {
  const args = options?.short ? ['status', '--short'] : ['status'];
  if (options?.pathspec?.trim()) {
    args.push('--', options.pathspec.trim());
  }
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: 'git',
    args,
    label: 'git status',
    category: 'git',
  });
}

export function gitDiffTool(
  workspacePath: string,
  options?: Readonly<{ cwd?: string; pathspec?: string; staged?: boolean; maxChars?: number }>,
): Promise<ToolResult> {
  const args = ['diff'];
  if (options?.staged) {
    args.push('--staged');
  }
  if (options?.pathspec?.trim()) {
    args.push('--', options.pathspec.trim());
  }
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: 'git',
    args,
    label: options?.staged ? 'git diff --staged' : 'git diff',
    category: 'git',
    ...(typeof options?.maxChars === 'number' ? { maxChars: options.maxChars } : {}),
  });
}

export function gitAddTool(
  workspacePath: string,
  paths: readonly string[],
  options?: Readonly<{ cwd?: string }>,
): Promise<ToolResult> {
  const normalizedPaths = paths.map((item) => item.trim()).filter(Boolean);
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: 'git',
    args: ['add', ...(normalizedPaths.length > 0 ? normalizedPaths : ['.'])],
    label: 'git add',
    category: 'git',
  });
}

export function gitCommitTool(
  workspacePath: string,
  message: string,
  options?: Readonly<{ cwd?: string; all?: boolean }>,
): Promise<ToolResult> {
  const args = ['commit'];
  if (options?.all) {
    args.push('-a');
  }
  args.push('-m', message);
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: 'git',
    args,
    label: 'git commit',
    category: 'git',
  });
}

export function gitPushTool(
  workspacePath: string,
  options?: Readonly<{ cwd?: string; remote?: string; branch?: string }>,
): Promise<ToolResult> {
  const args = ['push'];
  if (options?.remote?.trim()) {
    args.push(options.remote.trim());
  }
  if (options?.branch?.trim()) {
    args.push(options.branch.trim());
  }
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: 'git',
    args,
    label: 'git push',
    category: 'git',
  });
}

export function gitPullTool(
  workspacePath: string,
  options?: Readonly<{ cwd?: string; remote?: string; branch?: string }>,
): Promise<ToolResult> {
  const args = ['pull'];
  if (options?.remote?.trim()) {
    args.push(options.remote.trim());
  }
  if (options?.branch?.trim()) {
    args.push(options.branch.trim());
  }
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: 'git',
    args,
    label: 'git pull',
    category: 'git',
  });
}

export function gitCheckoutTool(
  workspacePath: string,
  ref: string,
  options?: Readonly<{ cwd?: string; createBranch?: boolean }>,
): Promise<ToolResult> {
  const args = ['checkout'];
  if (options?.createBranch) {
    args.push('-b');
  }
  args.push(ref);
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: 'git',
    args,
    label: 'git checkout',
    category: 'git',
  });
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

export function startManagedCommandTool(
  workspacePath: string,
  commandOrId: string,
  options?: { cwd?: string; maxChars?: number; stream?: ProjectCommandStreamHandlers; toolCallId?: string },
): ToolResult {
  return startManagedCommand(workspacePath, commandOrId, options);
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

type ResolvedProjectCommand = Readonly<{
  commandId: string;
  commandText: string;
  commandLabel: string;
  commandCategory: string;
  commandCwd: string;
  directCommand?: DirectCommand;
}>;

function resolveProjectCommandExecution(
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

function startManagedCommand(
  workspacePath: string,
  commandOrId: string,
  options?: { cwd?: string; maxChars?: number; stream?: ProjectCommandStreamHandlers; toolCallId?: string },
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

  void options?.stream?.onStart?.({
    commandText: resolved.commandText,
    cwd: resolved.commandCwd,
    startedAt,
  });

  const appendChunk = async (chunk: string): Promise<void> => {
    if (!chunk) {
      return;
    }
    record.totalChars += chunk.length;
    record.output = `${record.output}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
    await options?.stream?.onChunk?.({ chunk });
  };

  const finalize = async (meta: ProjectCommandMeta): Promise<void> => {
    if (record.completed) {
      return;
    }
    record.completed = true;
    record.success = meta.exitCode === 0;
    record.exitCode = meta.exitCode;
    record.durationMs = meta.durationMs;
    record.resolveCompletion(meta);
    await options?.stream?.onEnd?.({
      exitCode: meta.exitCode,
      success: meta.exitCode === 0,
      durationMs: meta.durationMs,
      background: true,
    });
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
    void finalize(Object.freeze({
      commandId,
      commandLabel: record.commandLabel,
      commandText: record.commandText,
      category: record.category,
      cwd: record.cwd,
      exitCode: 1,
      durationMs,
      truncated,
      totalChars: record.totalChars,
      tailOutput,
      background: true,
    }));
  });
  child.on('close', (code) => {
    const durationMs = Date.now() - startedAt;
    const { tailOutput, truncated } = buildTailOutput(record.output, maxChars);
    void finalize(Object.freeze({
      commandId,
      commandLabel: record.commandLabel,
      commandText: record.commandText,
      category: record.category,
      cwd: record.cwd,
      exitCode: Number(code ?? 0),
      durationMs,
      truncated,
      totalChars: record.totalChars,
      tailOutput,
      background: true,
    }));
  });

  child.unref();

  return Object.freeze({
    success: true,
    content:
      `[started] Command handed off to a VS Code terminal.\n` +
      `Use View terminal to inspect live output while Galaxy continues working.`,
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
      running: true,
      background: true,
    }),
  });
}

export async function awaitManagedProjectCommandTool(
  commandId: string,
  options?: { timeoutMs?: number; maxChars?: number },
): Promise<ToolResult> {
  const record = managedCommands.get(commandId);
  if (!record) {
    return Object.freeze({
      success: false,
      content: '',
      error: `Unknown command id: ${commandId}`,
    });
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

export function getManagedProjectCommandOutputTool(
  commandId: string,
  options?: { maxChars?: number },
): ToolResult {
  const record = managedCommands.get(commandId);
  if (!record) {
    return Object.freeze({
      success: false,
      content: '',
      error: `Unknown command id: ${commandId}`,
    });
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
      ...(record.completed ? {} : { running: true }),
      background: true,
    }),
  });
}

export function killManagedProjectCommandTool(commandId: string): ToolResult {
  const record = managedCommands.get(commandId);
  if (!record) {
    return Object.freeze({
      success: false,
      content: '',
      error: `Unknown command id: ${commandId}`,
    });
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
      running: true,
      background: true,
    }),
  });
}

export async function runProjectCommandTool(
  workspacePath: string,
  commandOrId: string,
  options?: { cwd?: string; maxChars?: number; stream?: ProjectCommandStreamHandlers; asyncStartOnly?: boolean },
): Promise<ToolResult> {
  if (options?.asyncStartOnly) {
    return startManagedCommand(workspacePath, commandOrId, options);
  }
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

  await options?.stream?.onStart?.({
    commandText: effectiveCommandText,
    cwd: commandCwd,
    startedAt,
  });

  const maxChars = Math.max(options?.maxChars ?? 8_000, 500);

  return await new Promise<ToolResult>((resolve) => {
    const child = directCommand
      ? spawn(directCommand.resolvedBinary, [...directCommand.args], {
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
    const timeoutMs = command?.timeoutMs ?? 120_000;

    const appendChunk = async (chunk: string): Promise<void> => {
      if (!chunk) {
        return;
      }

      totalChars += chunk.length;
      capturedOutput = `${capturedOutput}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
      await options?.stream?.onChunk?.({ chunk });

      if (backgroundMode && !releasedToBackground && looksLikeReadyOutput(capturedOutput)) {
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
      const raw = capturedOutput.trim() || '(background command started)';
      const truncated = raw.length > maxChars;
      const tailOutput = truncated
        ? `${raw.slice(-maxChars)}\n...[truncated ${raw.length - maxChars} chars earlier]`
        : raw;
      if (backgroundMode) {
        child.unref();
      }
      void finalize(Object.freeze({
        success: true,
        content:
          `[background] Command handed off to a VS Code terminal.\n` +
          `Use View terminal to inspect live output while Galaxy continues working.`,
        meta: Object.freeze({
          commandId: command?.id ?? effectiveCommandText,
          commandLabel,
          commandText: effectiveCommandText,
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
          commandId: command?.id ?? effectiveCommandText,
          commandLabel,
          commandText: effectiveCommandText,
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
          commandText: effectiveCommandText,
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
      const raw = capturedOutput.trim() || (timedOut ? '(command timed out)' : '(no output)');
      const truncated = raw.length > maxChars;
      const tailOutput = truncated
        ? `${raw.slice(-maxChars)}\n...[truncated ${raw.length - maxChars} chars earlier]`
        : raw;
      const exitCode = timedOut ? 124 : Number(code ?? 0);
      const success = exitCode === 0;
      const content = success
        ? 'Command completed. Use View terminal for the full output.'
        : 'Command failed. Use View terminal for the full output.';

      const result = Object.freeze({
        success,
        content,
        ...(success ? {} : { error: timedOut ? `Project command timed out: ${commandLabel}` : `Project command failed: ${commandLabel}` }),
        meta: Object.freeze({
          commandId: command?.id ?? effectiveCommandText,
          commandLabel,
          commandText: effectiveCommandText,
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
        await options?.stream?.onEnd?.({
          exitCode,
          success,
          durationMs,
          background: true,
        });
        await options?.stream?.onComplete?.({
          commandText: effectiveCommandText,
          cwd: commandCwd,
          exitCode,
          success,
          durationMs,
          output: tailOutput,
          background: true,
        });
        return;
      }

      await finalize(result);
    });
  });
}
