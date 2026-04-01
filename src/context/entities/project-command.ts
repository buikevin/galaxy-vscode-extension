/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Entity definitions for detected or configured project commands.
 */

/** Normalized category used to classify project commands. */
export type ProjectCommandCategory =
  | 'build'
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'format-check'
  | 'custom';

/** Approval risk level attached to one project command. */
export type ProjectCommandRisk = 'safe' | 'confirm';

export type ProjectCommandDefinition = Readonly<{
  /** Stable id used to reference the command definition. */
  id: string;
  /** Human-readable label shown to the agent or UI. */
  label: string;
  /** Shell command executed for this definition. */
  command: string;
  /** Working directory used when running the command. */
  cwd: string;
  /** Functional category used in validation and filtering. */
  category: ProjectCommandCategory;
  /** Whether the command came from detection or config. */
  source: 'detected' | 'configured';
  /** Risk level used for approval and auto-run decisions. */
  risk: ProjectCommandRisk;
  /** Whether the command is currently enabled. */
  enabled: boolean;
  /** Optional timeout override for the command. */
  timeoutMs?: number;
  /** Optional file globs limiting when the command should run. */
  filePatterns?: readonly string[];
}>;

export type ProjectCommandProfile = Readonly<{
  /** Stable workspace id associated with the profile. */
  workspaceId: string;
  /** Absolute workspace path associated with the profile. */
  workspacePath: string;
  /** Available command definitions for the workspace. */
  commands: readonly ProjectCommandDefinition[];
  /** Detected stack labels like node/python/go. */
  detectedStack: readonly string[];
  /** Last update timestamp for the profile. */
  updatedAt: number;
}>;

export type PersistedProjectCommandProfile = Readonly<{
  /** Stable workspace id associated with the profile. */
  workspaceId: string;
  /** Absolute workspace path associated with the profile. */
  workspacePath: string;
  /** Available command definitions for the workspace. */
  commands: readonly ProjectCommandDefinition[];
  /** Detected stack labels like node/python/go. */
  detectedStack: readonly string[];
  /** Last update timestamp for the profile. */
  updatedAt: number;
}>;
