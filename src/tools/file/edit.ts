/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Write and targeted-edit helpers for VS Code file tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { captureOriginal, trackFileWrite } from '../../runtime/session-tracker';
import type {
  EditFileRangeRequest,
  InsertFileAtLineRequest,
  MultiEditFileRange,
  ToolResult,
} from '../entities/file-tools';
import { resolveWorkspacePath, toDisplayPath } from './path-read';
import { getLineAt, validateAnchoredRangeEdit, validateTargetedEditPreconditions } from './targeted-edit';

/**
 * Counts total logical lines in a text payload.
 *
 * @param content Raw text content.
 * @returns Total number of newline-delimited lines.
 */
function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length;
}

/**
 * Creates a brand-new file inside the workspace.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided workspace-relative path.
 * @param content Full file content to write.
 * @returns Tool result describing the created file or the failure reason.
 */
export function writeFileTool(workspaceRoot: string, rawPath: string, content: string): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    const existedBefore = fs.existsSync(resolved);
    if (existedBefore) {
      return Object.freeze({
        success: false,
        content: '',
        error: `Refusing to overwrite existing file ${rawPath} with write_file. Use edit_file_range or multi_edit_file_ranges instead.`,
      });
    }
    captureOriginal(resolved);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    trackFileWrite(resolved);

    return Object.freeze({
      success: true,
      content: `Written ${Buffer.byteLength(content, 'utf-8')} bytes to ${toDisplayPath(resolved, workspaceRoot)}`,
      meta: Object.freeze({
        filePath: resolved,
        operation: existedBefore ? 'overwrite' : 'create',
        existedBefore,
        lineCount: countLines(content),
      }),
    });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}

/**
 * Performs exact-string replacement against one existing file.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided workspace-relative path.
 * @param oldString Exact text that must currently exist in the file.
 * @param newString Replacement text to write.
 * @param replaceAll Whether all matching occurrences should be replaced.
 * @returns Tool result describing the applied replacement or the failure reason.
 */
export function editFileTool(
  workspaceRoot: string,
  rawPath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    if (!fs.existsSync(resolved)) {
      return Object.freeze({ success: false, content: '', error: `File not found: ${rawPath}` });
    }

    captureOriginal(resolved);
    const original = fs.readFileSync(resolved, 'utf-8');
    if (!original.includes(oldString)) {
      return Object.freeze({
        success: false,
        content: '',
        error: `old_string not found in ${rawPath}. It must match exactly, including whitespace.`,
      });
    }

    const occurrences = original.split(oldString).length - 1;
    if (occurrences > 1 && !replaceAll) {
      return Object.freeze({
        success: false,
        content: '',
        error: `old_string appears ${occurrences} times in ${rawPath}. Use replace_all=true or provide more context.`,
      });
    }

    const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
    fs.writeFileSync(resolved, updated, 'utf-8');
    trackFileWrite(resolved);

    const originalLines = original.split('\n');
    const updatedLines = updated.split('\n');
    const changedAt = originalLines.findIndex((line, index) => line !== updatedLines[index]);
    const changedLineCount = Math.max(oldString.split('\n').length, newString.split('\n').length, 1);
    const changedRange = changedAt >= 0
      ? Object.freeze([{ startLine: changedAt + 1, endLine: changedAt + changedLineCount }])
      : Object.freeze([]);

    return Object.freeze({
      success: true,
      content: `Edited ${toDisplayPath(resolved, workspaceRoot)}${changedAt >= 0 ? ` starting at line ${changedAt + 1}` : ''}`,
      meta: Object.freeze({
        filePath: resolved,
        operation: 'edit',
        existedBefore: true,
        replaceAll,
        occurrencesChanged: replaceAll ? occurrences : 1,
        changedLineRanges: changedRange,
      }),
    });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}

/**
 * Replaces one inclusive line range in an existing file using snapshot-safe guards.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided workspace-relative path.
 * @param request Structured range-edit request plus snapshot evidence.
 * @returns Tool result describing the applied edit or the guard failure.
 */
export function editFileRangeTool(
  workspaceRoot: string,
  rawPath: string,
  request: EditFileRangeRequest,
): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    const { startLine, endLine, newContent, expectedTotalLines, expectedRangeContent, anchorBefore, anchorAfter } = request;
    if (!fs.existsSync(resolved)) {
      return Object.freeze({ success: false, content: '', error: `File not found: ${rawPath}` });
    }
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
      return Object.freeze({
        success: false,
        content: '',
        error: `Invalid line range for ${rawPath}. start_line and end_line must be 1-based and end_line >= start_line.`,
      });
    }

    const preconditionError = validateTargetedEditPreconditions(rawPath, 'range-edit', expectedTotalLines, {
      expectedRangeContent,
      expectedRangeContentProvided: typeof expectedRangeContent === 'string',
      anchorBefore,
      anchorAfter,
    });
    if (preconditionError) {
      return Object.freeze({ success: false, content: '', error: preconditionError });
    }

    captureOriginal(resolved);
    const original = fs.readFileSync(resolved, 'utf-8');
    const originalLines = original.split('\n');
    if (Number.isFinite(expectedTotalLines) && expectedTotalLines! > 0 && originalLines.length !== expectedTotalLines) {
      return Object.freeze({
        success: false,
        content: '',
        error: `File ${rawPath} changed since the last read. expected_total_lines=${expectedTotalLines}, current_total_lines=${originalLines.length}. Read the file again before editing.`,
      });
    }
    if (startLine > originalLines.length) {
      return Object.freeze({
        success: false,
        content: '',
        error: `start_line ${startLine} is outside ${rawPath} (${originalLines.length} lines). Use insert_file_at_line for insertions.`,
      });
    }
    if (endLine > originalLines.length) {
      return Object.freeze({
        success: false,
        content: '',
        error: `end_line ${endLine} is outside ${rawPath} (${originalLines.length} lines). Read the file again before editing.`,
      });
    }

    const anchorError = validateAnchoredRangeEdit(rawPath, originalLines, startLine, endLine, {
      expectedRangeContent,
      expectedRangeContentProvided: typeof expectedRangeContent === 'string',
      anchorBefore,
      anchorAfter,
    });
    if (anchorError) {
      return Object.freeze({ success: false, content: '', error: anchorError });
    }

    const replacementLines = newContent.split('\n');
    const updated = [
      ...originalLines.slice(0, startLine - 1),
      ...replacementLines,
      ...originalLines.slice(endLine),
    ].join('\n');

    fs.writeFileSync(resolved, updated, 'utf-8');
    trackFileWrite(resolved);

    return Object.freeze({
      success: true,
      content: `Edited ${toDisplayPath(resolved, workspaceRoot)} lines ${startLine}-${endLine}`,
      meta: Object.freeze({
        filePath: resolved,
        operation: 'edit',
        existedBefore: true,
        changedLineRanges: Object.freeze([
          Object.freeze({ startLine, endLine: Math.max(startLine, startLine + replacementLines.length - 1) }),
        ]),
        rangeEdit: true,
        startLine,
        endLine,
        ...(Number.isFinite(expectedTotalLines) && expectedTotalLines! > 0 ? { expectedTotalLines } : {}),
        ...(typeof expectedRangeContent === 'string' && expectedRangeContent.length > 0 ? { expectedRangeContent } : {}),
        ...(typeof anchorBefore === 'string' && anchorBefore.length > 0 ? { anchorBefore } : {}),
        ...(typeof anchorAfter === 'string' && anchorAfter.length > 0 ? { anchorAfter } : {}),
      }),
    });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}

/**
 * Inserts content before one 1-based line using snapshot-safe guards.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param rawPath User-provided workspace-relative path.
 * @param request Structured insert request plus snapshot evidence.
 * @returns Tool result describing the applied insert or the guard failure.
 */
export function insertFileAtLineTool(
  workspaceRoot: string,
  rawPath: string,
  request: InsertFileAtLineRequest,
): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    const { line, contentToInsert, expectedTotalLines, anchorBefore, anchorAfter } = request;
    if (!fs.existsSync(resolved)) {
      return Object.freeze({ success: false, content: '', error: `File not found: ${rawPath}` });
    }
    if (!Number.isFinite(line) || line < 1) {
      return Object.freeze({ success: false, content: '', error: `Invalid line for ${rawPath}. line must be 1-based and >= 1.` });
    }

    const preconditionError = validateTargetedEditPreconditions(rawPath, 'insert', expectedTotalLines, {
      anchorBefore,
      anchorAfter,
    });
    if (preconditionError) {
      return Object.freeze({ success: false, content: '', error: preconditionError });
    }

    captureOriginal(resolved);
    const original = fs.readFileSync(resolved, 'utf-8');
    const originalLines = original.split('\n');
    if (typeof expectedTotalLines === 'number' && Number.isFinite(expectedTotalLines) && expectedTotalLines > 0 && originalLines.length !== expectedTotalLines) {
      return Object.freeze({
        success: false,
        content: '',
        error: `File changed since the last read. Expected ${expectedTotalLines} total lines in ${rawPath}, but found ${originalLines.length}. Read the file again before editing.`,
      });
    }
    if (line > originalLines.length + 1) {
      return Object.freeze({ success: false, content: '', error: `line ${line} is outside ${rawPath} (${originalLines.length} lines).` });
    }
    if (typeof anchorBefore === 'string' && anchorBefore.length > 0) {
      const currentBefore = getLineAt(originalLines, line - 1);
      if (currentBefore !== anchorBefore) {
        return Object.freeze({ success: false, content: '', error: `anchor_before no longer matches ${rawPath} near line ${line}. Read the file again before inserting.` });
      }
    }
    if (typeof anchorAfter === 'string' && anchorAfter.length > 0) {
      const currentAfter = getLineAt(originalLines, line);
      if (currentAfter !== anchorAfter) {
        return Object.freeze({ success: false, content: '', error: `anchor_after no longer matches ${rawPath} near line ${line}. Read the file again before inserting.` });
      }
    }

    const insertedLines = contentToInsert.split('\n');
    const updatedLines = [...originalLines];
    updatedLines.splice(line - 1, 0, ...insertedLines);
    fs.writeFileSync(resolved, updatedLines.join('\n'), 'utf-8');
    trackFileWrite(resolved);

    return Object.freeze({
      success: true,
      content: `Inserted content into ${toDisplayPath(resolved, workspaceRoot)} before line ${line}`,
      meta: Object.freeze({
        filePath: resolved,
        operation: 'edit',
        existedBefore: true,
        changedLineRanges: Object.freeze([
          Object.freeze({ startLine: line, endLine: Math.max(line, line + insertedLines.length - 1) }),
        ]),
        insertEdit: true,
        startLine: line,
        ...(typeof anchorBefore === 'string' && anchorBefore.length > 0 ? { anchorBefore } : {}),
        ...(typeof anchorAfter === 'string' && anchorAfter.length > 0 ? { anchorAfter } : {}),
      }),
    });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}

export function multiEditFileRangesTool(
  workspaceRoot: string,
  rawPath: string,
  edits: readonly MultiEditFileRange[],
  expectedTotalLines?: number,
): ToolResult {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, rawPath);
    if (!fs.existsSync(resolved)) {
      return Object.freeze({ success: false, content: '', error: `File not found: ${rawPath}` });
    }
    if (!Array.isArray(edits) || edits.length === 0) {
      return Object.freeze({ success: false, content: '', error: `No edits provided for ${rawPath}.` });
    }

    captureOriginal(resolved);
    const original = fs.readFileSync(resolved, 'utf-8');
    const originalLines = original.split('\n');
    if (Number.isFinite(expectedTotalLines) && expectedTotalLines! > 0 && originalLines.length !== expectedTotalLines) {
      return Object.freeze({
        success: false,
        content: '',
        error: `File ${rawPath} changed since the last read. expected_total_lines=${expectedTotalLines}, current_total_lines=${originalLines.length}. Read the file again before editing.`,
      });
    }

    const normalizedEdits = edits.map((edit, index) => {
      const startLine = Number(edit.start_line);
      const endLine = Number(edit.end_line);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
        throw new Error(`Invalid range for edit ${index + 1} in ${rawPath}. start_line and end_line must be 1-based and end_line >= start_line.`);
      }
      if (startLine > originalLines.length + 1) {
        throw new Error(`start_line ${startLine} is outside ${rawPath} (${originalLines.length} lines).`);
      }
      return Object.freeze({
        startLine,
        endLine,
        newContent: String(edit.new_content ?? ''),
        expectedRangeContent: typeof edit.expected_range_content === 'string' ? edit.expected_range_content : '',
        expectedRangeContentProvided: Object.prototype.hasOwnProperty.call(edit, 'expected_range_content'),
        anchorBefore: typeof edit.anchor_before === 'string' ? edit.anchor_before : '',
        anchorAfter: typeof edit.anchor_after === 'string' ? edit.anchor_after : '',
      });
    });

    const sorted = [...normalizedEdits].sort((left, right) => right.startLine - left.startLine);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const current = sorted[index];
      const next = sorted[index + 1];
      if (next.endLine >= current.startLine) {
        return Object.freeze({ success: false, content: '', error: `Overlapping edit ranges detected in ${rawPath}.` });
      }
    }

    let updatedLines = [...originalLines];
    for (const edit of sorted) {
      const preconditionError = validateTargetedEditPreconditions(rawPath, 'multi-range-edit', expectedTotalLines, {
        expectedRangeContent: edit.expectedRangeContent,
        expectedRangeContentProvided: edit.expectedRangeContentProvided,
        anchorBefore: edit.anchorBefore,
        anchorAfter: edit.anchorAfter,
      });
      if (preconditionError) {
        return Object.freeze({ success: false, content: '', error: preconditionError });
      }
      if (edit.startLine > originalLines.length || edit.endLine > originalLines.length) {
        return Object.freeze({
          success: false,
          content: '',
          error: `Edit range ${edit.startLine}-${edit.endLine} is outside ${rawPath} (${originalLines.length} lines). Use insert_file_at_line for insertions.`,
        });
      }
      const anchorError = validateAnchoredRangeEdit(rawPath, updatedLines, edit.startLine, edit.endLine, {
        expectedRangeContent: edit.expectedRangeContent,
        expectedRangeContentProvided: edit.expectedRangeContentProvided,
        anchorBefore: edit.anchorBefore,
        anchorAfter: edit.anchorAfter,
      });
      if (anchorError) {
        return Object.freeze({ success: false, content: '', error: anchorError });
      }
      updatedLines = [
        ...updatedLines.slice(0, edit.startLine - 1),
        ...edit.newContent.split('\n'),
        ...updatedLines.slice(edit.endLine),
      ];
    }

    fs.writeFileSync(resolved, updatedLines.join('\n'), 'utf-8');
    trackFileWrite(resolved);

    return Object.freeze({
      success: true,
      content: `Edited ${toDisplayPath(resolved, workspaceRoot)} with ${normalizedEdits.length} targeted range edit(s)`,
      meta: Object.freeze({
        filePath: resolved,
        operation: 'edit',
        existedBefore: true,
        multiRangeEdit: true,
        changedLineRanges: Object.freeze(
          normalizedEdits.map((edit) => Object.freeze({
            startLine: edit.startLine,
            endLine: Math.max(edit.startLine, edit.startLine + edit.newContent.split('\n').length - 1),
          })),
        ),
        ...(Number.isFinite(expectedTotalLines) && expectedTotalLines! > 0 ? { expectedTotalLines } : {}),
      }),
    });
  } catch (error) {
    return Object.freeze({ success: false, content: '', error: String(error) });
  }
}
