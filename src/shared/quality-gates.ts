/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for validation and review quality-gate orchestration.
 */

import type {
  ProjectMeta,
  ProjectStorageInfo,
} from "../context/entities/project-store";
import type { GalaxyConfig } from "./config";
import type {
  AgentType,
  ChatMessage,
  CommandStreamChunkPayload,
  CommandStreamEndPayload,
  CommandStreamStartPayload,
  LogEntry,
  QualityDetails,
} from "./protocol";
import type { RepairTurnRequest, RepairTurnResult } from "./extension-host";

/** Host callbacks required to run the blocking quality gate outside the provider class. */
export type QualityGateCallbacks = Readonly<{
  /** Returns the latest effective config snapshot for the workspace. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Updates status text, progress UI, and posted run state together. */
  updateStatus: (statusText: string) => Promise<void>;
  /** Appends one runtime log entry. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  /** Pushes quality summaries and findings into the webview state. */
  updateQualityDetails: (update: Partial<QualityDetails>) => void;
  /** Persists workspace metadata patches. */
  persistProjectMetaPatch: (
    mutate: (previous: ProjectMeta | null) => ProjectMeta | null,
  ) => void;
  /** Adds one transcript message to the session and webview. */
  addMessage: (message: ChatMessage) => Promise<void>;
  /** Runs one internal repair turn using the selected agent. */
  runInternalRepairTurn: (
    request: RepairTurnRequest,
  ) => Promise<RepairTurnResult>;
  /** Emits validation-command start events into the UI. */
  emitCommandStreamStart: (payload: CommandStreamStartPayload) => Promise<void>;
  /** Emits validation-command output chunks into the UI. */
  emitCommandStreamChunk: (payload: CommandStreamChunkPayload) => Promise<void>;
  /** Emits validation-command end events into the UI. */
  emitCommandStreamEnd: (payload: CommandStreamEndPayload) => Promise<void>;
}>;

/** Parameters required by the extracted validation and review quality gate runner. */
export type RunQualityGatesParams = Readonly<{
  /** Absolute workspace path used for validation and task-memory records. */
  workspacePath: string;
  /** Project storage info used for metadata persistence. */
  projectStorage: ProjectStorageInfo;
  /** Agent used for review and automatic repair turns. */
  agentType: AgentType;
  /** Host callbacks needed to keep UI and runtime state in sync. */
  callbacks: QualityGateCallbacks;
}>;

/** Provider-owned bindings used to run quality gates without building the callback object inline. */
export type ProviderQualityGateBindings = Readonly<{
  /** Absolute workspace path used for validation and task-memory records. */
  workspacePath: string;
  /** Project storage info used for metadata persistence. */
  projectStorage: ProjectStorageInfo;
  /** Agent used for review and automatic repair turns. */
  agentType: AgentType;
  /** Returns the latest effective config snapshot for the workspace. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Stores one new status text value in provider state. */
  setStatusText: (statusText: string) => void;
  /** Reports one progress-line update to the active progress reporter. */
  reportProgress: (statusText: string) => void;
  /** Posts the latest running/idle state into the webview. */
  postRunState: () => Promise<void>;
  /** Appends one runtime log entry. */
  appendLog: (kind: LogEntry["kind"], text: string) => void;
  /** Pushes quality summaries and findings into the webview state. */
  updateQualityDetails: (update: Partial<QualityDetails>) => void;
  /** Persists workspace metadata patches. */
  persistProjectMetaPatch: (
    mutate: (previous: ProjectMeta | null) => ProjectMeta | null,
  ) => void;
  /** Adds one transcript message to the session and webview. */
  addMessage: (message: ChatMessage) => Promise<void>;
  /** Runs one internal repair turn using the selected agent. */
  runInternalRepairTurn: (
    request: RepairTurnRequest,
  ) => Promise<RepairTurnResult>;
  /** Emits validation-command start events into the UI. */
  emitCommandStreamStart: (payload: CommandStreamStartPayload) => Promise<void>;
  /** Emits validation-command output chunks into the UI. */
  emitCommandStreamChunk: (payload: CommandStreamChunkPayload) => Promise<void>;
  /** Emits validation-command end events into the UI. */
  emitCommandStreamEnd: (payload: CommandStreamEndPayload) => Promise<void>;
}>;
