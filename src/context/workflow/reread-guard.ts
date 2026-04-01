/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Workflow-aware reread guard to prevent unnecessary broad file rereads.
 */

import path from 'node:path';
import type { EvaluateWorkflowRereadGuardOptions, WorkflowRereadGuardDecision } from './entities/reread-guard';
import { MAX_UNTARGETED_DOCUMENT_CHARS, MAX_UNTARGETED_FILE_LINES } from './entities/constants';

/**
 * Normalizes an absolute or relative path into a workspace-relative path.
 *
 * @param workspacePath Absolute workspace root.
 * @param filePath Tool-provided path that may be absolute or relative.
 * @returns Normalized workspace-relative path or `null` when the path escapes the workspace.
 */
function normalizeRelativePath(workspacePath: string, filePath: string): string | null {
  const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspacePath, filePath);
  const relativePath = path.relative(workspacePath, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath.split(path.sep).join('/');
}

/**
 * Checks whether the current path belongs to the workflow candidate path set.
 *
 * @param relativePath Normalized workspace-relative path.
 * @param candidatePaths Candidate paths gathered from workflow retrieval.
 * @returns `true` when the path should be treated as covered by workflow evidence.
 */
function matchesCandidatePath(relativePath: string, candidatePaths: readonly string[]): boolean {
  return candidatePaths.some((candidate) => {
    const normalized = candidate.trim().replace(/\\/g, '/');
    return normalized === relativePath || normalized.endsWith(`/${relativePath}`) || relativePath.endsWith(`/${normalized}`);
  });
}

/**
 * Determines whether a code file read is broad enough to count as a reread from the top.
 *
 * @param params Raw tool parameters for `read_file`.
 * @returns `true` when the request is considered an untargeted file reread.
 */
function isBroadReadFile(params: Readonly<Record<string, unknown>>): boolean {
  const offset = Number(params.offset ?? 0);
  const maxLines = Number(params.maxLines ?? 200);
  return offset <= 0 && maxLines > MAX_UNTARGETED_FILE_LINES;
}

/**
 * Determines whether a document read is broad enough to count as a reread from the top.
 *
 * @param params Raw tool parameters for `read_document`.
 * @returns `true` when the request is considered an untargeted document reread.
 */
function isBroadReadDocument(params: Readonly<Record<string, unknown>>): boolean {
  const offset = Number(params.offset ?? 0);
  const maxChars = Number(params.maxChars ?? 20_000);
  const query = String(params.query ?? '').trim();
  return query.length === 0 && offset <= 0 && maxChars > MAX_UNTARGETED_DOCUMENT_CHARS;
}

/**
 * Evaluates whether a proposed tool read should be blocked because workflow evidence already covers the flow.
 *
 * @param opts Workflow reread guard inputs prepared by the prompt/runtime pipeline.
 * @returns Guard decision describing whether the reread should be blocked.
 */
export function evaluateWorkflowRereadGuard(
  opts: EvaluateWorkflowRereadGuardOptions,
): WorkflowRereadGuardDecision {
  if (!opts.guard?.enabled) {
    return Object.freeze({ blocked: false });
  }

  if (opts.toolName !== 'read_file' && opts.toolName !== 'read_document') {
    return Object.freeze({ blocked: false });
  }

  const rawPath = String(opts.params.path ?? '').trim();
  if (!rawPath) {
    return Object.freeze({ blocked: false });
  }

  const relativePath = normalizeRelativePath(opts.workspacePath, rawPath);
  if (!relativePath || !matchesCandidatePath(relativePath, opts.guard.candidatePaths)) {
    return Object.freeze({ blocked: false, relativePath: relativePath ?? undefined });
  }

  const broadRead = opts.toolName === 'read_file' ? isBroadReadFile(opts.params) : isBroadReadDocument(opts.params);
  if (!broadRead) {
    return Object.freeze({ blocked: false, relativePath });
  }

  return Object.freeze({
    blocked: true,
    relativePath,
    reason:
      `Workflow graph evidence already covers the current flow for ${relativePath}. ` +
      `Do not reread the raw file from the top just to reconstruct the flow. ` +
      `Use the existing workflow graph context, or retry with a targeted read (offset/maxLines for code, query for documents) only if you need exact implementation evidence.`,
  });
}
