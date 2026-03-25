/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-24
 * @modify date 2026-03-24
 * @desc Lightweight VS Code terminal registry used to mirror long-running command output in native terminals instead of streaming full output into the webview.
 */

import * as vscode from 'vscode';

const MAX_TERMINAL_BUFFER_CHARS = 200_000;

type CommandTerminalRecord = Readonly<{
  toolCallId: string;
  title: string;
  terminal: vscode.Terminal;
  append: (chunk: string) => void;
  finalize: (opts: Readonly<{ exitCode: number; success: boolean; durationMs: number }>) => void;
}>;

function normalizeTerminalChunk(chunk: string): string {
  return chunk.replace(/\r?\n/g, '\r\n');
}

function shortenCommand(commandText: string): string {
  const trimmed = commandText.trim();
  if (trimmed.length <= 72) {
    return trimmed;
  }
  return `${trimmed.slice(0, 69)}...`;
}

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

  const finalize = (opts: Readonly<{ exitCode: number; success: boolean; durationMs: number }>): void => {
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

  start(toolCallId: string, commandText: string, cwd: string): string {
    this.dispose(toolCallId);
    const record = createTerminalRecord(toolCallId, commandText, cwd);
    this.records.set(toolCallId, record);
    return record.title;
  }

  append(toolCallId: string, chunk: string): void {
    this.records.get(toolCallId)?.append(chunk);
  }

  complete(
    toolCallId: string,
    opts: Readonly<{ exitCode: number; success: boolean; durationMs: number }>,
  ): void {
    this.records.get(toolCallId)?.finalize(opts);
  }

  reveal(toolCallId: string): boolean {
    const record = this.records.get(toolCallId);
    if (!record) {
      return false;
    }
    record.terminal.show(true);
    return true;
  }

  dispose(toolCallId: string): void {
    const record = this.records.get(toolCallId);
    if (!record) {
      return;
    }
    this.records.delete(toolCallId);
    record.terminal.dispose();
  }

  clear(): void {
    const ids = [...this.records.keys()];
    ids.forEach((toolCallId) => this.dispose(toolCallId));
  }
}
