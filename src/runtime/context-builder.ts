/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Build compact context notes from user-selected workspace files.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_SELECTED_CONTEXT_FILE_CHARS,
  MAX_SELECTED_CONTEXT_FILES,
} from '../shared/constants';
import type { BuildSelectedFilesContextOptions } from '../shared/runtime';

/**
 * Truncates selected file content to the configured context budget.
 *
 * @param content File content read from disk.
 * @returns Truncated content suitable for prompt context.
 */
function truncateContent(content: string): string {
  if (content.length <= MAX_SELECTED_CONTEXT_FILE_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_SELECTED_CONTEXT_FILE_CHARS)}\n...[truncated]`;
}

/**
 * Reads one selected file and formats it as a prompt-ready section.
 *
 * @param filePath Absolute or workspace file path to read.
 * @param workspaceRoot Optional workspace root used to render relative labels.
 * @returns Prompt-ready file section, or `null` when the file cannot be read.
 */
async function readAttachedFile(filePath: string, workspaceRoot?: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const label = workspaceRoot ? path.relative(workspaceRoot, filePath) || path.basename(filePath) : filePath;
    return `### FILE: ${label}\n${truncateContent(raw)}`;
  } catch {
    return null;
  }
}

/**
 * Builds one compact context note from the files the user selected for the current turn.
 *
 * @param opts Selected file paths and optional workspace root.
 * @returns Prompt block containing the selected file excerpts.
 */
export async function buildSelectedFilesContextNote(opts: BuildSelectedFilesContextOptions): Promise<string> {
  const fileSections = await Promise.all(
    opts.selectedFiles.slice(0, MAX_SELECTED_CONTEXT_FILES).map((filePath) => readAttachedFile(filePath, opts.workspaceRoot)),
  );

  const attachedContext = fileSections.filter((section): section is string => Boolean(section)).join('\n\n');
  return attachedContext ? `Attached workspace context:\n${attachedContext}` : '';
}
