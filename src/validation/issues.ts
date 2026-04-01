/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Validation issue parsing helpers for the VS Code runtime.
 */

import path from 'node:path';
import type { ValidationIssue } from '../shared/validation';

/**
 * Resolves relative validation file paths against the command cwd.
 *
 * @param cwd Absolute working directory for the validation command.
 * @param filePath Raw file path extracted from output.
 * @returns Absolute file path when possible.
 */
function maybeResolvePath(cwd: string, filePath: string): string {
  if (!filePath) {return filePath;}
  if (path.isAbsolute(filePath)) {return filePath;}
  return path.resolve(cwd, filePath);
}

/**
 * Pushes one normalized validation issue into the output list.
 *
 * @param issues Mutable output issue list.
 * @param source Validation command or tool source id.
 * @param message Normalized issue message.
 * @param cwd Absolute working directory used for file resolution.
 * @param opts Optional file, line, column, and severity metadata.
 * @returns Nothing.
 */
function pushIssue(
  issues: ValidationIssue[],
  source: string,
  message: string,
  cwd: string,
  opts?: { filePath?: string; line?: number; column?: number; severity?: 'error' | 'warning' },
): void {
  issues.push(Object.freeze({
    source,
    severity: opts?.severity ?? 'error',
    message,
    ...(opts?.filePath ? { filePath: maybeResolvePath(cwd, opts.filePath) } : {}),
    ...(typeof opts?.line === 'number' ? { line: opts.line } : {}),
    ...(typeof opts?.column === 'number' ? { column: opts.column } : {}),
  }));
}

/**
 * Parses validation output into normalized issues using the command cwd for file resolution.
 *
 * @param output Raw validation output.
 * @param source Validation source id.
 * @param cwd Absolute working directory for the validation command.
 * @returns Immutable list of parsed validation issues.
 */
export function parseIssuesWithCwd(output: string, source: string, cwd: string): readonly ValidationIssue[] {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 100);
  const issues: ValidationIssue[] = [];
  for (const line of lines) {
    let match =
      line.match(/^(.*)\((\d+),(\d+)\):\s+error(?:\s+[A-Z0-9]+)?:\s+(.*)$/i) ||
      line.match(/^(.*)\((\d+),(\d+)\):\s+warning(?:\s+[A-Z0-9]+)?:\s+(.*)$/i);
    if (match) {
      pushIssue(issues, source, match[4] ?? line, cwd, {
        line: Number(match[2]),
        column: Number(match[3]),
        severity: /warning/i.test(line) ? 'warning' : 'error',
        ...(match[1] ? { filePath: match[1] } : {}),
      });
      continue;
    }
    match =
      line.match(/^(.*?):(\d+):(\d+)\s*-\s*(error|warning).*?:\s*(.*)$/i) ||
      line.match(/^(.*?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/i);
    if (match) {
      pushIssue(issues, source, match[5] ?? line, cwd, {
        line: Number(match[2]),
        column: Number(match[3]),
        severity: String(match[4]).toLowerCase() === 'warning' ? 'warning' : 'error',
        ...(match[1] ? { filePath: match[1] } : {}),
      });
      continue;
    }
    match = line.match(/^(.*?):(\d+):\s*(.*)$/);
    if (match && !line.startsWith('Error:')) {
      pushIssue(issues, source, match[3] ?? line, cwd, {
        line: Number(match[2]),
        ...(match[1] ? { filePath: match[1] } : {}),
      });
      continue;
    }
    match = line.match(/^-->\s+(.*?):(\d+):(\d+)$/);
    if (match) {
      pushIssue(issues, source, 'Validation location', cwd, {
        line: Number(match[2]),
        column: Number(match[3]),
        ...(match[1] ? { filePath: match[1] } : {}),
      });
      continue;
    }
    match = line.match(/^(.+?):(\d+)\s+(.*)$/);
    if (match && (match[1]?.includes('.') || match[1]?.includes('/'))) {
      pushIssue(issues, source, match[3] ?? line, cwd, {
        filePath: match[1],
        line: Number(match[2]),
      });
      continue;
    }
    pushIssue(issues, source, line, cwd);
  }
  return Object.freeze(issues);
}
