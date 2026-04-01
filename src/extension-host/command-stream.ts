/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Command-stream and background terminal completion orchestration extracted from the extension host entrypoint.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { CommandTerminalRegistry } from "../runtime/command-terminal-registry";
import { getSessionFiles } from "../runtime/session-tracker";
import { MAX_COMMAND_CONTEXT_OUTPUT_CHARS } from "../shared/constants";
import type {
  ProviderBackgroundCommandBindings,
  ProviderCommandStreamBindings,
} from "../shared/command-stream";
import type {
  ActiveShellSessionState,
  BackgroundCommandCallbacks,
  BackgroundCommandCompletion,
  CommandContextWritePayload,
  CommandStreamCallbacks,
  CommandContextFile,
  RepairTurnRequest,
  RepairTurnResult,
} from "../shared/extension-host";
import type {
  CommandStreamChunkPayload,
  CommandStreamEndPayload,
  CommandStreamStartPayload,
} from "../shared/protocol";

function buildCommandStreamCallbacks(
  bindings: ProviderCommandStreamBindings,
): CommandStreamCallbacks {
  return {
    commandTerminalRegistry: bindings.commandTerminalRegistry,
    activeShellSessions: bindings.activeShellSessions,
    commandContextPath: bindings.commandContextPath,
    appendLog: bindings.appendLog,
    postMessage: bindings.postMessage,
  };
}

function buildBackgroundCommandCallbacks(
  bindings: ProviderBackgroundCommandBindings,
): BackgroundCommandCallbacks {
  return {
    commandContextPath: bindings.commandContextPath,
    appendLog: bindings.appendLog,
    asWorkspaceRelative: bindings.asWorkspaceRelative,
    getIsRunning: bindings.getIsRunning,
    getBackgroundCompletionRunning: bindings.getBackgroundCompletionRunning,
    setBackgroundCompletionRunning: bindings.setBackgroundCompletionRunning,
    getPendingBackgroundCompletions: bindings.getPendingBackgroundCompletions,
    setPendingBackgroundCompletions: bindings.setPendingBackgroundCompletions,
    setStatusText: bindings.setStatusText,
    reportProgress: bindings.reportProgress,
    postRunState: bindings.postRunState,
    getEffectiveConfig: bindings.getEffectiveConfig,
    getSelectedAgent: bindings.getSelectedAgent,
    runInternalRepairTurn: bindings.runInternalRepairTurn,
    runValidationAndReviewFlow: bindings.runValidationAndReviewFlow,
  };
}

function truncateCommandContextOutput(value: string): string {
  if (value.length <= MAX_COMMAND_CONTEXT_OUTPUT_CHARS) {
    return value;
  }
  return value.slice(-MAX_COMMAND_CONTEXT_OUTPUT_CHARS);
}

/** Persists one compact terminal-context snapshot for follow-up repair turns. */
export function writeCommandContextFile(
  commandContextPath: string,
  payload: CommandContextWritePayload,
): CommandContextFile {
  const trimmedOutput = truncateCommandContextOutput(
    (payload.output ?? "").trim(),
  );
  const status: CommandContextFile["status"] = payload.running
    ? "running"
    : payload.success === false
      ? "failed"
      : "completed";
  const summary = payload.running
    ? "Command is still running in the VS Code terminal."
    : payload.success === false
      ? `Command failed with exit code ${payload.exitCode ?? 1}.`
      : `Command completed with exit code ${payload.exitCode ?? 0}.`;
  const nowIso = new Date().toISOString();
  const record: CommandContextFile = Object.freeze({
    command: payload.commandText,
    cwd: payload.cwd,
    status,
    ...(typeof payload.exitCode === "number"
      ? { exitCode: payload.exitCode }
      : {}),
    ...(typeof payload.durationMs === "number"
      ? { durationMs: payload.durationMs }
      : {}),
    tailOutput: trimmedOutput,
    summary,
    changedFiles: Object.freeze([...(payload.changedFiles ?? [])]),
    updatedAt: nowIso,
    ...(!payload.running ? { completedAt: nowIso } : {}),
  });
  fs.writeFileSync(
    commandContextPath,
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  return record;
}

/** Reveals the native VS Code terminal for one command-stream session. */
export async function revealShellTerminal(
  commandTerminalRegistry: CommandTerminalRegistry,
  toolCallId: string,
): Promise<void> {
  if (commandTerminalRegistry.reveal(toolCallId)) {
    return;
  }
  await vscode.window.showWarningMessage(
    "Terminal for this command is no longer available.",
  );
}

/** Mirrors command start events into the terminal registry, context file, and webview. */
export async function emitCommandStreamStart(
  callbacks: CommandStreamCallbacks,
  payload: CommandStreamStartPayload,
): Promise<void> {
  const terminalTitle = callbacks.commandTerminalRegistry.start(
    payload.toolCallId,
    payload.commandText,
    payload.cwd,
  );
  callbacks.activeShellSessions.set(
    payload.toolCallId,
    Object.freeze({
      toolCallId: payload.toolCallId,
      commandText: payload.commandText,
      cwd: payload.cwd,
      startedAt: payload.startedAt,
      output: "",
      terminalTitle,
    }),
  );
  writeCommandContextFile(callbacks.commandContextPath, {
    commandText: payload.commandText,
    cwd: payload.cwd,
    running: true,
  });
  callbacks.appendLog(
    "status",
    `Terminal command started: ${payload.commandText} (cwd: ${payload.cwd}). Open the VS Code terminal to follow live output.`,
  );
  await callbacks.postMessage({
    type: "command-stream-start",
    payload: {
      ...payload,
      terminalTitle,
    },
  });
}

/** Mirrors provider-owned command start bindings into the extracted command-stream helper. */
export async function emitProviderCommandStreamStart(
  bindings: ProviderCommandStreamBindings,
  payload: CommandStreamStartPayload,
): Promise<void> {
  await emitCommandStreamStart(buildCommandStreamCallbacks(bindings), payload);
}

/** Appends streamed command output into the terminal registry. */
export async function emitCommandStreamChunk(
  callbacks: CommandStreamCallbacks,
  payload: CommandStreamChunkPayload,
): Promise<void> {
  callbacks.commandTerminalRegistry.append(payload.toolCallId, payload.chunk);
}

/** Mirrors provider-owned command chunk bindings into the extracted command-stream helper. */
export async function emitProviderCommandStreamChunk(
  bindings: ProviderCommandStreamBindings,
  payload: CommandStreamChunkPayload,
): Promise<void> {
  await emitCommandStreamChunk(buildCommandStreamCallbacks(bindings), payload);
}

/** Finalizes one command-stream session and posts its completion into the webview. */
export async function emitCommandStreamEnd(
  callbacks: CommandStreamCallbacks,
  payload: CommandStreamEndPayload,
): Promise<void> {
  const current = callbacks.activeShellSessions.get(payload.toolCallId);
  if (current) {
    const next = Object.freeze({
      ...current,
      success: payload.success,
      exitCode: payload.exitCode,
      durationMs: payload.durationMs,
      ...(payload.background ? { background: true } : {}),
    });
    callbacks.activeShellSessions.set(payload.toolCallId, next);
    callbacks.appendLog(
      payload.success ? "status" : "error",
      `Terminal command ${payload.success ? "completed" : "failed"}: ${current.commandText} ` +
        `(exit ${payload.exitCode}, ${Math.max(0, Math.round(payload.durationMs / 1000))}s).`,
    );
  }
  callbacks.commandTerminalRegistry.complete(payload.toolCallId, payload);
  await callbacks.postMessage({
    type: "command-stream-end",
    payload,
  });
}

/** Mirrors provider-owned command end bindings into the extracted command-stream helper. */
export async function emitProviderCommandStreamEnd(
  bindings: ProviderCommandStreamBindings,
  payload: CommandStreamEndPayload,
): Promise<void> {
  await emitCommandStreamEnd(buildCommandStreamCallbacks(bindings), payload);
}

/** Enqueues one finished background command and triggers the follow-up repair flow. */
export async function handleBackgroundCommandCompletion(
  callbacks: BackgroundCommandCallbacks,
  payload: BackgroundCommandCompletion,
): Promise<void> {
  writeCommandContextFile(callbacks.commandContextPath, {
    commandText: payload.commandText,
    cwd: payload.cwd,
    success: payload.success,
    exitCode: payload.exitCode,
    durationMs: payload.durationMs,
    output: payload.output,
    changedFiles: getSessionFiles().map((file) =>
      callbacks.asWorkspaceRelative(file.filePath),
    ),
  });
  callbacks.setPendingBackgroundCompletions([
    ...callbacks.getPendingBackgroundCompletions(),
    payload,
  ]);
  callbacks.appendLog(
    "status",
    `Background command completed: ${payload.commandText} (${payload.success ? `exit ${payload.exitCode}` : `failed exit ${payload.exitCode}`}). Context saved to ${path.basename(callbacks.commandContextPath)}.`,
  );
  await flushBackgroundCommandCompletions(callbacks);
}

/** Processes one finished background command using provider-owned bindings. */
export async function handleProviderBackgroundCommandCompletion(
  bindings: ProviderBackgroundCommandBindings,
  payload: BackgroundCommandCompletion,
): Promise<void> {
  await handleBackgroundCommandCompletion(
    buildBackgroundCommandCallbacks(bindings),
    payload,
  );
}

/** Runs queued follow-up repair turns for finished background commands one at a time. */
export async function flushBackgroundCommandCompletions(
  callbacks: BackgroundCommandCallbacks,
): Promise<void> {
  if (
    callbacks.getIsRunning() ||
    callbacks.getBackgroundCompletionRunning() ||
    callbacks.getPendingBackgroundCompletions().length === 0
  ) {
    return;
  }

  const [next, ...rest] = callbacks.getPendingBackgroundCompletions();
  if (!next) {
    return;
  }
  callbacks.setPendingBackgroundCompletions(rest);
  callbacks.setBackgroundCompletionRunning(true);
  callbacks.setStatusText("Processing completed background command");
  callbacks.reportProgress("Processing completed background command");
  await callbacks.postRunState();

  const contextRecord = writeCommandContextFile(callbacks.commandContextPath, {
    commandText: next.commandText,
    cwd: next.cwd,
    success: next.success,
    exitCode: next.exitCode,
    durationMs: next.durationMs,
    output: next.output,
    changedFiles: getSessionFiles().map((file) =>
      callbacks.asWorkspaceRelative(file.filePath),
    ),
  });

  const agentType = callbacks.getSelectedAgent();
  const result = await callbacks.runInternalRepairTurn({
    config: callbacks.getEffectiveConfig(),
    agentType,
    userMessage: Object.freeze({
      id: `background-complete-${Date.now()}`,
      role: "user",
      content:
        `Background command completed.\n` +
        `Command: ${next.commandText}\n` +
        `cwd: ${next.cwd}\n` +
        `Exit code: ${next.exitCode}\n` +
        `Success: ${String(next.success)}\n` +
        `Context file: context.json\n` +
        `Summary: ${contextRecord.summary}\n` +
        `Tail output:\n${contextRecord.tailOutput || "(no output)"}\n\n` +
        "Continue from the updated workspace state. If you need the full command context, read context.json. Do not rerun the same command unless the context above proves it is necessary.",
      timestamp: Date.now(),
    }),
  });

  callbacks.setBackgroundCompletionRunning(false);
  if (result.filesWritten.length > 0 && !result.hadError) {
    await callbacks.runValidationAndReviewFlow(agentType);
  }
  await flushBackgroundCommandCompletions(callbacks);
}

/** Flushes queued background command completions using provider-owned bindings. */
export async function flushProviderBackgroundCommandCompletions(
  bindings: ProviderBackgroundCommandBindings,
): Promise<void> {
  await flushBackgroundCommandCompletions(
    buildBackgroundCommandCallbacks(bindings),
  );
}
