/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared validation entities reused across runtime, extension host, and UI flows.
 */

import type { GalaxyConfig } from './config';

export type ValidationProfileId =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'dotnet'
  | 'php'
  | 'shell'
  | 'ruby';

export type ValidationCommand = Readonly<{
  /** Stable identifier used to correlate a selected command with its result. */
  id: string;
  /** Human-readable label shown in logs and UI surfaces. */
  label: string;
  /** Exact command text executed during validation. */
  command: string;
  /** Working directory where the command must run. */
  cwd: string;
  /** Whether the command targets the whole project or a single file. */
  kind: 'project' | 'file';
  /** Language or execution profile that selected the command. */
  profile: ValidationProfileId | 'file';
  /** Validation stage represented by the command. */
  category: 'lint' | 'static-check' | 'test' | 'build' | 'file';
}>;

export type ValidationIssue = Readonly<{
  /** Optional file path associated with the parsed issue. */
  filePath?: string;
  /** Optional 1-based line number associated with the issue. */
  line?: number;
  /** Optional 1-based column number associated with the issue. */
  column?: number;
  /** Parsed severity level. */
  severity: 'error' | 'warning';
  /** Human-readable issue message extracted from tool output. */
  message: string;
  /** Source parser or tool that produced the issue. */
  source: string;
}>;

export type ValidationRunResult = Readonly<{
  /** Whether the validation command exited successfully. */
  success: boolean;
  /** Identifier of the command that produced this run result. */
  commandId: string;
  /** Exact command text that was executed. */
  command: string;
  /** Profile associated with the executed command. */
  profile: ValidationCommand['profile'];
  /** Validation stage associated with the executed command. */
  category: ValidationCommand['category'];
  /** Command duration in milliseconds. */
  durationMs: number;
  /** Short summary presented back to the agent and user. */
  summary: string;
  /** Structured issues parsed from the command output. */
  issues: readonly ValidationIssue[];
  /** Tail preview of the raw command output for debugging. */
  rawOutputPreview: string;
}>;

export type FinalValidationResult = Readonly<{
  /** Whether the complete validation gate passed. */
  success: boolean;
  /** Which validation mode was chosen for the gate. */
  mode: 'project' | 'file' | 'none';
  /** Human-readable explanation of the chosen validation strategy. */
  selectionSummary: string;
  /** Ordered list of executed validation runs. */
  runs: readonly ValidationRunResult[];
  /** Final summary message shown back to the agent and user. */
  summary: string;
}>;

export type ValidationCommandStreamCallbacks = Readonly<{
  /** Called when a managed validation command starts running. */
  onStart?: (payload: {
    /** Stable id used to map streamed output back to one command. */
    toolCallId: string;
    /** Exact command text being executed. */
    commandText: string;
    /** Working directory used for the command. */
    cwd: string;
    /** Unix timestamp in milliseconds when execution started. */
    startedAt: number;
  }) => void | Promise<void>;
  /** Called for each streamed chunk emitted by the validation command. */
  onChunk?: (payload: {
    /** Stable id used to map streamed output back to one command. */
    toolCallId: string;
    /** Raw command output chunk. */
    chunk: string;
  }) => void | Promise<void>;
  /** Called when a managed validation command exits. */
  onEnd?: (payload: {
    /** Stable id used to map streamed output back to one command. */
    toolCallId: string;
    /** Process exit code. */
    exitCode: number;
    /** Whether the process exited successfully. */
    success: boolean;
    /** Total runtime in milliseconds. */
    durationMs: number;
  }) => void | Promise<void>;
}>;

/** Package manager variants supported when building script execution commands. */
export type NodePackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

/** Validation command categories, including the file-level safety net. */
export type ValidationCommandCategory = ValidationCommand['category'];

/** User-configurable validation command preferences loaded from Galaxy config. */
export type ValidationPreferencesConfig = GalaxyConfig['validation'];

/** Ranked package.json script candidate considered during validation command selection. */
export type PackageScriptCandidate = Readonly<{
  /** Script key declared under `package.json#scripts`. */
  scriptName: string;
  /** Validation stage inferred from the script name and command text. */
  category: Exclude<ValidationCommandCategory, 'file'>;
  /** Language profile associated with the selected script. */
  profile: ValidationProfileId;
  /** Ranking score used to keep the strongest candidate per category. */
  score: number;
}>;
