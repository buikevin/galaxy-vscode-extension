/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Provider-bound runtime log bindings for message-runtime helpers.
 */

import type * as vscode from "vscode";
import type { HostMessage, LogEntry } from "./protocol";

/** Provider-owned bindings required to append one runtime log entry outside the provider class. */
export type ProviderRuntimeLogBindings = Readonly<{
  /** Factory used to create stable ids for runtime log entries. */
  createMessageId: () => string;
  /** Current in-memory runtime log snapshot. */
  runtimeLogs: readonly LogEntry[];
  /** Stores the next runtime log snapshot in provider state. */
  setRuntimeLogs: (runtimeLogs: readonly LogEntry[]) => void;
  /** Absolute path to the runtime debug log file. */
  debugLogPath: string;
  /** Shared output channel used for host runtime logs. */
  outputChannel: vscode.OutputChannel;
  /** Webview bridge used to post updated runtime logs. */
  postMessage: (message: HostMessage) => Promise<void>;
}>;
