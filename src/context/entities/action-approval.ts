/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Action approval and local permission entities for the VS Code extension runtime.
 */

/**
 * Supported command permission decisions stored per workspace.
 */
export type CommandPermission = 'allow' | 'deny' | 'ask' | 'unset';

/**
 * Workspace-local permission settings grouped by approval state.
 */
export type LocalPermissionSettings = Readonly<{
  /** Permission buckets keyed by approval state. */
  permissions: Readonly<{
    /** Commands that may run without asking again. */
    allow: readonly string[];
    /** Commands that are explicitly blocked. */
    deny: readonly string[];
    /** Commands that should still prompt the user. */
    ask: readonly string[];
  }>;
}>;
