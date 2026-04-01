/**
 * @author Bui Trong Hieu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared contracts for provider-bound review and review-panel actions extracted from the extension entrypoint.
 */

import type {
  ProjectMeta,
  ProjectStorageInfo,
} from "../context/entities/project-store";
import type { ToolResult } from "../tools/entities/file-tools";
import type { GalaxyConfig } from "./config";
import type { RepairTurnRequest, RepairTurnResult } from "./extension-host";
import type {
  AgentType,
  HostMessage,
  QualityDetails,
  WebviewMessage,
} from "./protocol";
import type { SessionChangeSummary } from "./runtime";

/** Provider-owned callbacks and state accessors required to build review actions. */
export type ProviderReviewActionBindings = Readonly<{
  /** Absolute workspace path used by review-finding helpers and task-memory updates. */
  workspacePath: string;
  /** Storage paths for the active workspace. */
  projectStorage: ProjectStorageInfo;
  /** Returns whether the provider is already processing another turn. */
  isRunning: () => boolean;
  /** Posts one host-side message back into the webview. */
  postMessage: (message: HostMessage) => Promise<void>;
  /** Clears transient streaming buffers before a focused repair turn. */
  clearStreamingBuffers: () => void;
  /** Updates in-memory provider run-state before it is broadcast. */
  setRunningState: (isRunning: boolean, statusText: string) => void;
  /** Posts the latest running/idle state into the webview. */
  postRunState: () => Promise<void>;
  /** Returns the latest effective runtime config snapshot. */
  getEffectiveConfig: () => GalaxyConfig;
  /** Returns the currently selected agent type. */
  getSelectedAgent: () => AgentType;
  /** Executes one focused internal repair turn. */
  runInternalRepairTurn: (
    request: RepairTurnRequest,
  ) => Promise<RepairTurnResult>;
  /** Persists project-meta mutations back to workspace storage. */
  persistProjectMetaPatch: (
    mutate: (previous: ProjectMeta | null) => ProjectMeta | null,
  ) => void;
  /** Pushes updated review findings into provider quality state. */
  updateQualityDetails: (update: Partial<QualityDetails>) => void;
  /** Runs validation and review after a finding has been applied. */
  runValidationAndReviewFlow: (agentType: AgentType) => Promise<unknown>;
  /** Returns the latest tracked session summary used to render the review panel. */
  getSummary: () => SessionChangeSummary;
  /** Formats an absolute path into a workspace-relative label. */
  asWorkspaceRelative: (filePath: string) => string;
  /** Creates a unique id used as the review-panel nonce. */
  createMessageId: () => string;
  /** Routes review-panel messages back into the provider. */
  handleMessage: (message: WebviewMessage) => Promise<void>;
  /** Refreshes tracked workspace file state before rebuilding the review panel. */
  refreshWorkspaceFiles: () => Promise<void>;
}>;

/** Provider-bound review actions exposed by extracted host helpers. */
export type ProviderReviewActions = Readonly<{
  /** Returns the latest stored test failure artifact. */
  getLatestTestFailureTool: () => Promise<ToolResult>;
  /** Returns the latest stored review findings artifact. */
  getLatestReviewFindingsTool: () => Promise<ToolResult>;
  /** Returns the next actionable stored review finding. */
  getNextReviewFindingTool: () => Promise<ToolResult>;
  /** Dismisses one stored review finding and updates workspace metadata. */
  dismissReviewFindingTool: (findingId: string) => Promise<ToolResult>;
  /** Applies one stored review finding through a focused repair turn. */
  applyReviewFinding: (findingId: string) => Promise<void>;
  /** Opens the native review panel for tracked workspace changes. */
  openNativeReview: () => Promise<void>;
}>;
