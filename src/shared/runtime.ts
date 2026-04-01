/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared runtime entities reused across extension runtime modules, validation, and tool orchestration.
 */

import type { AgentType, ChatMessage } from './protocol';
import type { ToolCall } from '../tools/entities/file-tools';

/** Parsed direct command information used when the host bypasses shell parsing. */
export type DirectCommand = Readonly<{
  /** Original binary token extracted from the command text. */
  binary: string;
  /** Parsed argument tokens passed directly to the binary. */
  args: readonly string[];
  /** Absolute or PATH-resolved binary path used for execution. */
  resolvedBinary: string;
  /** Human-readable command string shown in logs and approvals. */
  displayCommandText: string;
}>;

/** Shell families supported by the extension runtime. */
export type ShellKind = 'posix' | 'powershell' | 'cmd';

/** Resolved shell profile used to run or probe commands. */
export type ShellProfile = Readonly<{
  /** Executable path or binary name used to spawn the shell. */
  executable: string;
  /** Normalized shell family used to choose quoting and availability checks. */
  kind: ShellKind;
  /** Builds argument list for executing a command string inside the shell. */
  commandArgs(commandText: string): readonly string[];
  /** Builds argument list for probing whether a binary exists inside the shell. */
  availabilityArgs(binary: string): readonly string[];
}>;

/** Terminal profile fragment read from VS Code settings. */
export type TerminalProfileConfig = Readonly<{
  /** Configured executable path or candidate paths. */
  path?: string | readonly string[];
  /** VS Code profile source label such as PowerShell or Git Bash. */
  source?: string;
  /** Additional arguments configured for the shell profile. */
  args?: readonly string[];
}>;

/** One file changed by the current AI session. */
export type TrackedFile = Readonly<{
  /** Absolute path of the tracked file. */
  filePath: string;
  /** Human-readable language label used in summaries and review prompts. */
  language: string;
  /** Unix timestamp in milliseconds when the file was last modified by the session. */
  modifiedAt: number;
  /** Whether the file did not exist before the session started editing it. */
  wasNew: boolean;
}>;

/** Original on-disk snapshot captured before the session edited a file. */
export type OriginalSnapshot = Readonly<{
  /** Original file content, or `null` when the file did not exist. */
  content: string | null;
  /** Unix timestamp in milliseconds when the snapshot was captured. */
  savedAt: number;
}>;

/** Workspace snapshot entry captured for change detection across the tree. */
export type WorkspaceFileSnapshot = Readonly<{
  /** Absolute path of the workspace file. */
  filePath: string;
  /** Last modification time in milliseconds used for quick change detection. */
  mtimeMs: number;
  /** File size in bytes used as an additional change signal. */
  size: number;
  /** Full file content when it can be read as UTF-8 text. */
  content: string | null;
}>;

/** Detailed diff summary for one file in the current session. */
export type ChangedFileSummary = Readonly<{
  /** Absolute path of the changed file. */
  filePath: string;
  /** Human-readable language label for display and review context. */
  language: string;
  /** Whether the file was created during the current session. */
  wasNew: boolean;
  /** Number of added lines in the unified diff. */
  addedLines: number;
  /** Number of removed lines in the unified diff. */
  deletedLines: number;
  /** Original content captured before the session changed the file. */
  originalContent: string | null;
  /** Current file content after session edits. */
  currentContent: string | null;
  /** Unified diff text comparing original and current content. */
  diffText: string;
}>;

/** Aggregate summary of workspace changes tracked during the current session. */
export type SessionChangeSummary = Readonly<{
  /** Number of changed files in the current session. */
  fileCount: number;
  /** Number of newly created files in the current session. */
  createdCount: number;
  /** Total number of added lines across all tracked files. */
  addedLines: number;
  /** Total number of removed lines across all tracked files. */
  deletedLines: number;
  /** Per-file summaries used by UI panels and quality steps. */
  files: readonly ChangedFileSummary[];
}>;

/** Result of reverting a single tracked file. */
export type RevertResult =
  | Readonly<{
      /** Whether the revert operation succeeded. */
      success: true;
      /** Whether the reverted file was originally created during the session. */
      wasNew: boolean;
      /** Absolute file path that was reverted. */
      filePath: string;
    }>
  | Readonly<{
      /** Whether the revert operation failed. */
      success: false;
      /** Human-readable reason describing the failure. */
      reason: string;
    }>;

/** Result of reverting every tracked file in the session. */
export type RevertAllResult = Readonly<{
  /** Files that were reverted successfully. */
  revertedPaths: readonly string[];
  /** Failure reasons for files that could not be reverted. */
  failedReasons: readonly string[];
}>;

/** Completion payload written into a native terminal when one command ends. */
export type CommandTerminalCompletion = Readonly<{
  /** Process exit code reported by the finished command. */
  exitCode: number;
  /** Whether the command finished successfully. */
  success: boolean;
  /** Total runtime in milliseconds for the command. */
  durationMs: number;
}>;

/** Buffered terminal entry stored for one running or finished command tab. */
export type CommandTerminalRecord = Readonly<{
  /** Stable tool call id associated with the command. */
  toolCallId: string;
  /** User-facing terminal title shown in VS Code. */
  title: string;
  /** Live terminal handle used to reveal or dispose the tab. */
  terminal: import('vscode').Terminal;
  /** Appends one output chunk into the buffered terminal transcript. */
  append: (chunk: string) => void;
  /** Finalizes the command transcript with the terminal completion summary. */
  finalize: (opts: CommandTerminalCompletion) => void;
}>;

/** Scope bucket used to split a broad task into selective multi-agent subtasks. */
export type SubtaskScope = 'backend' | 'frontend' | 'integration';

/** One scoped subtask emitted by the selective multi-agent planner. */
export type SelectiveMultiAgentSubtask = Readonly<{
  /** Stable scope id used to order and label the subtask. */
  id: SubtaskScope;
  /** Human-readable subtask title shown in orchestration messages. */
  title: string;
  /** Objective the sub-agent should complete in this scope. */
  objective: string;
  /** Acceptance criteria used to stop the sub-agent at the right boundary. */
  acceptanceCriteria: readonly string[];
  /** Optional extra scope notes that narrow how the subtask should proceed. */
  scopeNotes?: readonly string[];
}>;

/** Multi-agent execution plan for one broad implementation request. */
export type SelectiveMultiAgentPlan = Readonly<{
  /** Reason why the runtime decided to split the work. */
  reason: string;
  /** User-facing summary of the generated scoped plan. */
  summary: string;
  /** Ordered subtask list to execute or display. */
  subtasks: readonly SelectiveMultiAgentSubtask[];
}>;

/** Parsed review finding extracted from reviewer output. */
export type RuntimeReviewFinding = Readonly<{
  /** Severity used to prioritize fixes. */
  severity: 'critical' | 'warning' | 'info';
  /** File or location string associated with the finding. */
  location: string;
  /** Human-readable finding message. */
  message: string;
}>;

/** Aggregated result returned by the runtime reviewer. */
export type RuntimeReviewResult = Readonly<{
  /** Whether the reviewer completed successfully. */
  success: boolean;
  /** Raw formatted review text returned by the reviewer. */
  review: string;
  /** Number of files included in the review request. */
  filesReviewed: number;
  /** Whether any critical finding was reported. */
  hadCritical: boolean;
  /** Whether any warning finding was reported. */
  hadWarnings: boolean;
  /** Parsed structured findings extracted from the review text. */
  findings: readonly RuntimeReviewFinding[];
}>;

/** Reviewer chat message sent to the external review model. */
export type ReviewMessage = Readonly<{
  /** Chat role used in the reviewer prompt exchange. */
  role: 'system' | 'user';
  /** Prompt body content for this message. */
  content: string;
}>;

/** One review batch request derived from recently changed files. */
export type ReviewBatchRequest = Readonly<{
  /** Full user prompt sent to the reviewer for this batch. */
  userPrompt: string;
  /** Number of files included in this batch. */
  fileCount: number;
  /** Number of files skipped before batching because they could not be read. */
  skipped: number;
  /** One-based batch index for progress reporting. */
  batchIndex: number;
  /** Total number of batches in the review run. */
  batchCount: number;
}>;

/** Approval payload used while a tool call waits for user confirmation. */
export type PendingActionApproval = Readonly<{
  /** Approval cache key used to reuse a prior decision. */
  approvalKey: string;
  /** Tool name requesting approval. */
  toolName: string;
  /** Short title rendered in the approval prompt. */
  title: string;
  /** Primary user-facing approval message. */
  message: string;
  /** Extra contextual details shown under the approval message. */
  details: readonly string[];
}>;

/** Final result returned by one extension chat execution. */
export type RunResult = Readonly<{
  /** Final assistant text accumulated during the turn. */
  assistantText: string;
  /** Final assistant thinking text accumulated during the turn. */
  assistantThinking: string;
  /** Optional terminal or runtime error message for the turn. */
  errorMessage?: string;
  /** Files written or modified by the turn. */
  filesWritten: readonly string[];
}>;

/** Input required to build a selected-files context note. */
export type BuildSelectedFilesContextOptions = Readonly<{
  /** File paths selected in the UI or current composer state. */
  selectedFiles: readonly string[];
  /** Optional workspace root used to render relative labels. */
  workspaceRoot?: string;
}>;

/** Runtime transcript message passed into provider drivers. */
export type RuntimeMessage = ChatMessage;

/** Stream chunk emitted by provider drivers during one chat turn. */
export type StreamChunk =
  | Readonly<{ type: 'text'; delta: string }>
  | Readonly<{ type: 'thinking'; delta: string }>
  | Readonly<{ type: 'tool_call'; call: ToolCall }>
  | Readonly<{ type: 'done' }>
  | Readonly<{ type: 'error'; message: string }>;

/** Callback used by drivers to emit streamed text, tool calls, and terminal states. */
export type StreamHandler = (chunk: StreamChunk) => void;

/** Contract implemented by every runtime model driver. */
export interface AgentDriver {
  /** Provider type served by the driver. */
  readonly name: AgentType;
  /** Executes one chat turn and streams chunks back to the runtime. */
  chat(messages: readonly RuntimeMessage[], onChunk: StreamHandler): Promise<void>;
}
