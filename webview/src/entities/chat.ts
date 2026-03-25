/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Chat and transcript entities used by the Galaxy Code webview.
 */

import type { AgentType, ChatMessage } from "@shared/protocol";

/**
 * One entry parsed from a list_dir tool response.
 */
export type ListDirEntry = Readonly<{
  /** Stable React key for the rendered entry. */
  key: string;
  /** Display label of the file or directory. */
  label: string;
  /** Relative path inside the current workspace. */
  filePath: string;
  /** Whether the entry points to a directory. */
  isDir: boolean;
  /** Tree depth inferred from list_dir indentation. */
  depth: number;
}>;

/**
 * Pending user request while waiting for the host/agent response.
 */
export type PendingRequest = Readonly<{
  /** User message id already appended in the transcript. */
  messageId: string;
  /** Raw user prompt content. */
  content: string;
  /** Agent selected for this request. */
  agent: AgentType;
  /** Explicitly selected workspace files. */
  selectedFiles: readonly string[];
  /** Attached Figma import ids. */
  figmaImportIds: readonly string[];
  /** Attached local/figma attachment ids. */
  attachmentIds: readonly string[];
  /** Whether code review is enabled for this run. */
  reviewEnabled: boolean;
  /** Whether validation is enabled for this run. */
  validateEnabled: boolean;
  /** Whether high-risk tools can bypass approval. */
  fullAccessEnabled: boolean;
  /** Whether the host has already replied to this request. */
  hasServerResponse: boolean;
}>;

/**
 * One action row grouped under an assistant turn.
 */
export type ActionItem = Readonly<{
  /** Stable key for grouped rendering. */
  key: string;
  /** Action kind controls icon/body renderer. */
  kind: "thinking" | "tool";
  /** Source chat message for this action. */
  message: ChatMessage;
}>;

/**
 * Live shell execution state mirrored from command-stream host messages.
 */
export type ActiveShellSession = Readonly<{
  /** Tool call id associated with this shell session. */
  toolCallId: string;
  /** Exact command text shown in the UI. */
  commandText: string;
  /** Effective cwd used for the command. */
  cwd: string;
  /** Start timestamp of the command. */
  startedAt: number;
  /** Streamed stdout/stderr accumulated in the webview. */
  output: string;
  /** Native VS Code terminal title when available. */
  terminalTitle?: string;
  /** Final success state when the process exits. */
  success?: boolean;
  /** Final exit code when the process exits. */
  exitCode?: number;
  /** Final duration once the process ends. */
  durationMs?: number;
  /** Whether control was handed back before the process fully exited. */
  background?: boolean;
}>;

/**
 * Flattened item fed into the transcript renderer.
 */
export type RenderItem =
  | Readonly<{ type: "message"; key: string; message: ChatMessage }>
  | Readonly<{ type: "actions"; key: string; items: readonly ActionItem[] }>
  | Readonly<{ type: "live-shell"; key: string; session: ActiveShellSession }>;

/**
 * Evidence confirmation state for one manual read-plan step.
 */
export type ManualReadPlanProgress = Readonly<{
  /** Human-readable label shown in logs/UI. */
  label: string;
  /** Whether this step has been confirmed by evidence. */
  confirmed: boolean;
  /** Optional short summary of matching evidence. */
  evidenceSummary?: string;
  /** File path targeted by this step. */
  targetPath: string;
  /** Symbol name associated with the step when available. */
  symbolName?: string;
  /** Tool kind expected for the step. */
  tool: "read_file" | "grep";
}>;

/**
 * Manual planning block derived from prompt/evidence context.
 */
export type ManualPromptPlan = Readonly<{
  /** Symbols the manual agent should inspect first. */
  focusSymbols: readonly string[];
  /** Human-readable summary of the current plan. */
  summary: string;
  /** Batched read/grep suggestions for the current turn. */
  batchItems: readonly string[];
  /** Per-step confirmation status derived from evidence. */
  progressItems: readonly ManualReadPlanProgress[];
  /** Number of confirmed plan steps. */
  confirmedCount: number;
}>;
