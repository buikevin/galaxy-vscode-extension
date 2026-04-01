/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared entities for managed project command execution in the VS Code runtime.
 */

import type { ChildProcess } from 'node:child_process';
import type { DirectCommand } from '../../shared/runtime';

export type ProjectCommandMeta = Readonly<{
  /** Unique runtime command id used to query status and output. */
  commandId: string;
  /** Human-readable command label shown to the user. */
  commandLabel: string;
  /** Effective command text executed by the runtime. */
  commandText: string;
  /** Command category used for routing and UI grouping. */
  category: string;
  /** Absolute working directory for the command. */
  cwd: string;
  /** Exit code reported by the command. */
  exitCode: number;
  /** Elapsed wall-clock time in milliseconds. */
  durationMs: number;
  /** Whether the returned output was truncated. */
  truncated: boolean;
  /** Total number of captured characters before truncation. */
  totalChars: number;
  /** Tail output retained for display and follow-up analysis. */
  tailOutput: string;
  /** Whether the command was released to background handling. */
  background?: boolean;
}>;

export type ProjectCommandStreamHandlers = Readonly<{
  /** Optional callback fired when command execution starts. */
  onStart?: (payload: Readonly<{ commandText: string; cwd: string; startedAt: number }>) => Promise<void> | void;
  /** Optional callback fired for each output chunk. */
  onChunk?: (payload: Readonly<{ chunk: string }>) => Promise<void> | void;
  /** Optional callback fired once the command reaches an end state. */
  onEnd?: (payload: Readonly<{ exitCode: number; success: boolean; durationMs: number; background?: boolean }>) => Promise<void> | void;
  /** Optional callback fired after the full completion payload is available. */
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

export type StartManagedCommandOptions = Readonly<{
  /** Optional working directory relative to the workspace root. */
  cwd?: string;
  /** Maximum tail output characters retained for the command. */
  maxChars?: number;
  /** Optional stream callbacks that mirror command lifecycle events. */
  stream?: ProjectCommandStreamHandlers;
  /** Optional tool call id used to link command state back to a tool invocation. */
  toolCallId?: string;
}>;

export type RunProjectCommandOptions = Readonly<{
  /** Optional working directory relative to the workspace root. */
  cwd?: string;
  /** Maximum tail output characters retained for the command. */
  maxChars?: number;
  /** Optional stream callbacks that mirror command lifecycle events. */
  stream?: ProjectCommandStreamHandlers;
  /** When true, immediately hand the command off to background management. */
  asyncStartOnly?: boolean;
}>;

export type ManagedCommandRecord = {
  /** Unique runtime command id used to retrieve the record later. */
  commandId: string;
  /** Effective command text executed by the runtime. */
  commandText: string;
  /** Human-readable command label shown to the user. */
  commandLabel: string;
  /** Command category used for routing and UI grouping. */
  category: string;
  /** Absolute working directory for the command. */
  cwd: string;
  /** Epoch timestamp in milliseconds when execution started. */
  startedAt: number;
  /** Child process handle for the running command. */
  child: ChildProcess;
  /** Rolling output buffer retained for the command. */
  output: string;
  /** Total number of captured characters before truncation. */
  totalChars: number;
  /** Whether the command has already reached a terminal state. */
  completed: boolean;
  /** Final success state once completion is known. */
  success?: boolean;
  /** Exit code once the command finishes. */
  exitCode?: number;
  /** Duration in milliseconds once the command finishes. */
  durationMs?: number;
  /** Optional tool call id that initiated this command. */
  toolCallId?: string;
  /** Promise that resolves when the command reaches a terminal state. */
  completionPromise: Promise<ProjectCommandMeta>;
  /** Resolver paired with completionPromise. */
  resolveCompletion: (value: ProjectCommandMeta) => void;
};

export type ResolvedProjectCommand = Readonly<{
  /** Stable command id derived from project-command definitions or the raw command. */
  commandId: string;
  /** Effective command text shown to the user. */
  commandText: string;
  /** Human-readable command label shown to the user. */
  commandLabel: string;
  /** Command category used for routing and UI grouping. */
  commandCategory: string;
  /** Absolute working directory for the command. */
  commandCwd: string;
  /** Optional direct-command execution plan for shell-free execution. */
  directCommand?: DirectCommand;
}>;
