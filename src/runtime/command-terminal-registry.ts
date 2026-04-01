/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-24
 * @modify date 2026-03-24
 * @desc Lightweight VS Code terminal registry used to mirror long-running command output in native terminals instead of streaming full output into the webview.
 */

import * as vscode from 'vscode';
import { MAX_TERMINAL_BUFFER_CHARS } from '../shared/constants';
import type { CommandTerminalCompletion, CommandTerminalRecord } from '../shared/runtime';

/**
 * Normalizes output chunks for VS Code pseudoterminal line endings.
 *
 * @param chunk Raw terminal output chunk.
 * @returns Normalized chunk using CRLF line endings.
 */
function normalizeTerminalChunk(chunk: string): string {
  return chunk.replace(/\r?\n/g, '\r\n');
}

/**
 * Shortens long commands for terminal tab labels.
 *
 * @param commandText Full command text.
 * @returns Truncated command label suitable for a terminal title.
 */
function shortenCommand(commandText: string): string {
  const trimmed = commandText.trim();
  if (trimmed.length <= 72) {
    return trimmed;
  }
  return `${trimmed.slice(0, 69)}...`;
}

/**
 * Creates one pseudoterminal-backed registry record for a tool call.
 *
 * @param toolCallId Stable tool call id used to reveal the correct terminal later.
 * @param commandText Full command text shown in the terminal.
 * @param cwd Working directory displayed in the terminal header.
 * @returns Terminal registry record with append/finalize hooks.
 */
function createTerminalRecord(toolCallId: string, commandText: string, cwd: string): CommandTerminalRecord {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  let opened = false;
  let finished = false;
  let buffer = '';

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      opened = true;
      if (buffer) {
        writeEmitter.fire(buffer);
      }
    },
    close: () => {
      opened = false;
    },
  };

  const title = `Galaxy Shell: ${shortenCommand(commandText)}`;
  const terminal = vscode.window.createTerminal({
    name: title,
    pty,
    isTransient: true,
  });

  const append = (chunk: string): void => {
    if (!chunk) {
      return;
    }

    const normalized = normalizeTerminalChunk(chunk);
    buffer = `${buffer}${normalized}`.slice(-MAX_TERMINAL_BUFFER_CHARS);
    if (opened) {
      writeEmitter.fire(normalized);
    }
  };

  append(`[Galaxy] Run Shell\r\n$ ${commandText}\r\ncwd: ${cwd}\r\n\r\n`);

  const finalize = (opts: CommandTerminalCompletion): void => {
    if (finished) {
      return;
    }
    finished = true;
    append(
      `\r\n[Galaxy] Command ${opts.success ? 'completed' : 'failed'} ` +
      `(exit ${opts.exitCode}, ${Math.max(0, Math.round(opts.durationMs / 1000))}s)\r\n`,
    );
  };

  return Object.freeze({
    toolCallId,
    title,
    terminal,
    append,
    finalize,
  });
}

/**
 * Keep a short-lived mapping from tool call ids to VS Code terminals so the webview can reveal the native terminal later.
 */
export class CommandTerminalRegistry {
  private readonly records = new Map<string, CommandTerminalRecord>();

  /**
   * Opens a new buffered terminal entry for one tool call.
   *
   * @param toolCallId Stable tool call id that owns the terminal session.
   * @param commandText Full command text rendered in the terminal header.
   * @param cwd Working directory used by the command.
   * @returns User-facing terminal title created for the session.
   */
  start(toolCallId: string, commandText: string, cwd: string): string {
    this.dispose(toolCallId);
    const record = createTerminalRecord(toolCallId, commandText, cwd);
    this.records.set(toolCallId, record);
    return record.title;
  }

  /**
   * Appends one streamed output chunk into the registered terminal.
   *
   * @param toolCallId Stable tool call id that owns the terminal session.
   * @param chunk Output chunk to append.
   */
  append(toolCallId: string, chunk: string): void {
    this.records.get(toolCallId)?.append(chunk);
  }

  /**
   * Finalizes one terminal session when its command completes.
   *
   * @param toolCallId Stable tool call id that owns the terminal session.
   * @param opts Completion metadata shown in the terminal footer.
   */
  complete(
    toolCallId: string,
    opts: CommandTerminalCompletion,
  ): void {
    this.records.get(toolCallId)?.finalize(opts);
  }

  /**
   * Reveals the terminal associated with one tool call.
   *
   * @param toolCallId Stable tool call id that owns the terminal session.
   * @returns `true` when the terminal existed and was shown.
   */
  reveal(toolCallId: string): boolean {
    const record = this.records.get(toolCallId);
    if (!record) {
      return false;
    }
    record.terminal.show(true);
    return true;
  }

  /**
   * Disposes the terminal associated with one tool call.
   *
   * @param toolCallId Stable tool call id that owns the terminal session.
   */
  dispose(toolCallId: string): void {
    const record = this.records.get(toolCallId);
    if (!record) {
      return;
    }
    this.records.delete(toolCallId);
    record.terminal.dispose();
  }

  /** Disposes every tracked terminal session. */
  clear(): void {
    const ids = [...this.records.keys()];
    ids.forEach((toolCallId) => this.dispose(toolCallId));
  }
}
