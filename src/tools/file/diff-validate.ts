/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Diff and validation helpers for VS Code file tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ToolResult } from '../entities/file-tools';

export function validateCodeTool(filePath: string): ToolResult {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return {
      success: false,
      content: '',
      error: `File not found: ${filePath}`,
    };
  }

  const ext = path.extname(resolved).toLowerCase();

  function findTsConfig(dir: string): string | null {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    return findTsConfig(parent);
  }

  function shouldUseProjectReferences(tsconfigPath: string): boolean {
    try {
      const tsconfigText = fs.readFileSync(tsconfigPath, 'utf-8');
      return /"references"\s*:/.test(tsconfigText);
    } catch {
      return false;
    }
  }

  try {
    if (ext === '.ts' || ext === '.tsx') {
      const projectDir = findTsConfig(path.dirname(resolved));
      if (!projectDir) {
        return { success: false, content: '', error: 'No tsconfig.json found in parent directories.' };
      }

      let output = '';
      try {
        const tsconfigPath = path.join(projectDir, 'tsconfig.json');
        const command = shouldUseProjectReferences(tsconfigPath)
          ? 'npx tsc -b --pretty false 2>&1'
          : 'npx tsc --noEmit --pretty false 2>&1';
        execSync(command, { cwd: projectDir, encoding: 'utf-8', timeout: 30_000 });
        return {
          success: true,
          content: `✓ No TypeScript compiler errors detected for ${filePath}`,
          meta: Object.freeze({ filePath: resolved, reportKind: 'validation', issuesCount: 0 }),
        };
      } catch (error) {
        output = error instanceof Error && 'stdout' in error
          ? String((error as NodeJS.ErrnoException & { stdout?: string }).stdout ?? '')
          : String(error);
      }

      const relPath = path.relative(projectDir, resolved);
      const lines = output.split('\n').filter(Boolean);
      const relevant = lines.filter((line) => line.includes(relPath) || /^\s+/.test(line));
      const report = relevant.length > 0 ? relevant.join('\n') : lines.join('\n');

      return {
        success: false,
        content: report,
        error: `TypeScript errors found in ${filePath}`,
        meta: Object.freeze({
          filePath: resolved,
          reportKind: 'validation',
          issuesCount: report.split('\n').filter(Boolean).length,
        }),
      };
    }

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      execSync(`node --check "${resolved}" 2>&1`, { encoding: 'utf-8', timeout: 10_000 });
      return {
        success: true,
        content: `✓ No syntax errors in ${filePath}`,
        meta: Object.freeze({ filePath: resolved, reportKind: 'validation', issuesCount: 0 }),
      };
    }

    if (ext === '.json') {
      JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      return {
        success: true,
        content: `✓ Valid JSON: ${filePath}`,
        meta: Object.freeze({ filePath: resolved, reportKind: 'validation', issuesCount: 0 }),
      };
    }

    if (ext === '.py') {
      execSync(`python -m py_compile "${resolved}" 2>&1`, { encoding: 'utf-8', timeout: 10_000 });
      return {
        success: true,
        content: `✓ Python syntax OK: ${filePath}`,
        meta: Object.freeze({ filePath: resolved, reportKind: 'validation', issuesCount: 0 }),
      };
    }

    if (ext === '.sh' || ext === '.bash') {
      execSync(`bash -n "${resolved}" 2>&1`, { encoding: 'utf-8', timeout: 10_000 });
      return {
        success: true,
        content: `✓ Shell syntax OK: ${filePath}`,
        meta: Object.freeze({ filePath: resolved, reportKind: 'validation', issuesCount: 0 }),
      };
    }

    if (ext === '.php') {
      execSync(`php -l "${resolved}" 2>&1`, { encoding: 'utf-8', timeout: 10_000 });
      return {
        success: true,
        content: `✓ PHP syntax OK: ${filePath}`,
        meta: Object.freeze({ filePath: resolved, reportKind: 'validation', issuesCount: 0 }),
      };
    }

    if (ext === '.rb') {
      execSync(`ruby -c "${resolved}" 2>&1`, { encoding: 'utf-8', timeout: 10_000 });
      return {
        success: true,
        content: `✓ Ruby syntax OK: ${filePath}`,
        meta: Object.freeze({ filePath: resolved, reportKind: 'validation', issuesCount: 0 }),
      };
    }

    return {
      success: true,
      content: `✓ File exists and is readable: ${filePath}`,
      meta: Object.freeze({ filePath: resolved, reportKind: 'validation', issuesCount: 0 }),
    };
  } catch (error) {
    const message = error instanceof Error && 'stdout' in error
      ? String((error as NodeJS.ErrnoException & { stdout?: string }).stdout ?? error.message)
      : String(error);
    return {
      success: false,
      content: message,
      error: `Validation failed: ${filePath}`,
      meta: Object.freeze({
        filePath: resolved,
        reportKind: 'validation',
        issuesCount: message.split('\n').filter(Boolean).length,
      }),
    };
  }
}
