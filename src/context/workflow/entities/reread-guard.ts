/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow reread guard entities.
 */

import type { WorkflowRereadGuard } from '../../entities/history';

/**
 * Input payload used to evaluate whether a reread should be blocked.
 */
export type EvaluateWorkflowRereadGuardOptions = Readonly<{
  /** Absolute workspace path used to normalize tool paths. */
  workspacePath: string;
  /** Tool name being evaluated. */
  toolName: string;
  /** Raw tool parameters from the agent tool call. */
  params: Readonly<Record<string, unknown>>;
  /** Optional workflow reread guard metadata prepared during prompt build. */
  guard?: WorkflowRereadGuard;
}>;

/**
 * Outcome returned by workflow reread guard evaluation.
 */
export type WorkflowRereadGuardDecision = Readonly<{
  /** Whether the tool call should be blocked. */
  blocked: boolean;
  /** Optional explanatory reason shown back to the agent. */
  reason?: string;
  /** Normalized workspace-relative file path when one could be derived. */
  relativePath?: string;
}>;
