/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound command stream and background completion actions.
 */

import type { CommandTerminalRegistry } from "../runtime/command-terminal-registry";
import type {
  ActiveShellSessionState,
  BackgroundCommandCompletion,
  RepairTurnRequest,
  RepairTurnResult,
} from "./extension-host";
import type {
  AgentType,
  CommandStreamChunkPayload,
  CommandStreamEndPayload,
  CommandStreamStartPayload,
  HostMessage,
  LogEntry,
} from "./protocol";
import type { GalaxyConfig } from "./config";

/** Provider-owned callbacks and state accessors required to build command actions. */
export type ProviderCommandActionBindings = Readonly<{
  /** Registry that owns buffered VS Code pseudoterminals for tool calls. */
  commandTerminalRegistry: CommandTerminalRegistry;
  /** In-memory shell session state mirrored into the webview. */
  activeShellSessions: Map<string, ActiveShellSessionState>;
  /** Absolute path to the persisted command-context file. */
  commandContextPath: string;
  /** Runtime log sink used to surface command status changes. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  /** Webview bridge used to post host messages. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Converts an absolute path to a workspace-relative label. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Returns whether the main provider is already processing a turn. */
  getIsRunning: () => boolean;
  /** Returns whether a background completion follow-up is already running. */
  getBackgroundCompletionRunning: () => boolean;
  /** Updates the in-memory flag guarding background completion processing. */
  setBackgroundCompletionRunning: (value: boolean) => void;
  /** Returns the queued background completions awaiting follow-up. */
  getPendingBackgroundCompletions: () => readonly BackgroundCommandCompletion[];
  /** Replaces the queued background completions awaiting follow-up. */
  setPendingBackgroundCompletions: (
    completions: readonly BackgroundCommandCompletion[],
  ) => void;
  /** Updates the provider status text shown in the UI and status bar. */
  setStatusText: (statusText: string) => void;
  /** Reports one progress-line update to the active progress reporter. */
  reportProgress: (statusText: string) => void;
  /** Posts the latest running/idle state into the webview. */
  postRunState: () => Promise<void>;
  /** Returns the latest effective runtime config snapshot. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Returns the currently selected agent type. */
  getSelectedAgent: () => AgentType;
  /** Executes one internal repair turn for a completed background command. */
  runInternalRepairTurn: (
    request: RepairTurnRequest,
  ) => Promise<RepairTurnResult>;
  /** Runs the post-repair validation/review quality gate when needed. */
  runValidationAndReviewFlow: (agentType: AgentType) => Promise<unknown>;
}>;

/** Provider-bound command actions exposed by extracted host helpers. */
export type ProviderCommandActions = Readonly<{
  /** Reveals the VS Code terminal associated with one tool call id. */
  revealShellTerminal: (toolCallId: string) => Promise<void>;
  /** Mirrors one command start event into the terminal registry and webview. */
  emitCommandStreamStart: (payload: CommandStreamStartPayload) => Promise<void>;
  /** Mirrors one command chunk event into the terminal registry. */
  emitCommandStreamChunk: (payload: CommandStreamChunkPayload) => Promise<void>;
  /** Mirrors one command end event into the terminal registry and webview. */
  emitCommandStreamEnd: (payload: CommandStreamEndPayload) => Promise<void>;
  /** Enqueues one completed background command and triggers follow-up repair. */
  handleBackgroundCommandCompletion: (
    payload: BackgroundCommandCompletion,
  ) => Promise<void>;
  /** Flushes queued background command completions one at a time. */
  flushBackgroundCommandCompletions: () => Promise<void>;
}>;
