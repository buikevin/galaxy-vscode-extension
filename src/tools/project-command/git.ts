/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Git-oriented project command helpers for the VS Code runtime.
 */

import { spawn } from "node:child_process";
import {
  buildShellEnvironment,
  resolveCommandBinary,
  shouldUseWindowsCommandShell,
} from "../../runtime/shell-resolver";
import type { ToolResult } from "../entities/file-tools";
import { MAX_CAPTURED_OUTPUT_CHARS } from "./constants";
import { buildTailOutput, resolveCwd } from "./core";

/**
 * Executes one direct binary command and captures a bounded tail of its output.
 *
 * @param opts Direct command options.
 * @returns Tool result describing command success or failure.
 */
async function runDirectBinaryTool(
  opts: Readonly<{
    workspacePath: string;
    cwd?: string;
    binary: string;
    args: readonly string[];
    label: string;
    category: string;
    maxChars?: number;
  }>,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const commandCwd = resolveCwd(opts.workspacePath, opts.cwd);
  const resolvedBinary = resolveCommandBinary(opts.binary, commandCwd);
  if (!resolvedBinary) {
    return Object.freeze({
      success: false,
      content: "",
      error: `Required command is not available: ${opts.binary}`,
      meta: Object.freeze({
        commandId: opts.binary,
        commandLabel: opts.label,
        commandText: `${opts.binary} ${opts.args.join(" ")}`.trim(),
        category: opts.category,
        cwd: commandCwd,
        exitCode: 127,
        durationMs: Date.now() - startedAt,
        truncated: false,
      }),
    });
  }
  const maxChars = Math.max(opts.maxChars ?? 8_000, 500);
  return await new Promise<ToolResult>((resolve) => {
    const useCommandShell = shouldUseWindowsCommandShell(resolvedBinary);
    const child = spawn(resolvedBinary, [...opts.args], {
      cwd: commandCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildShellEnvironment(),
      shell: useCommandShell,
    });
    let totalChars = 0;
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 120_000);
    const append = (chunk: string): void => {
      totalChars += chunk.length;
      output = `${output}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
    };
    child.stdout.on("data", (data: Buffer | string) => append(String(data)));
    child.stderr.on("data", (data: Buffer | string) => append(String(data)));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(
        Object.freeze({
          success: false,
          content: String(error),
          error: `${opts.label} failed.`,
          meta: Object.freeze({
            commandId: opts.binary,
            commandLabel: opts.label,
            commandText: `${opts.binary} ${opts.args.join(" ")}`.trim(),
            category: opts.category,
            cwd: commandCwd,
            exitCode: 1,
            durationMs: Date.now() - startedAt,
            truncated: false,
          }),
        }),
      );
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const { tailOutput, truncated } = buildTailOutput(output, maxChars);
      const exitCode = Number(code ?? 0);
      resolve(
        Object.freeze({
          success: exitCode === 0,
          content: tailOutput,
          ...(exitCode === 0 ? {} : { error: `${opts.label} failed.` }),
          meta: Object.freeze({
            commandId: opts.binary,
            commandLabel: opts.label,
            commandText: `${opts.binary} ${opts.args.join(" ")}`.trim(),
            category: opts.category,
            cwd: commandCwd,
            exitCode,
            durationMs,
            truncated,
            totalChars,
            tailOutput,
          }),
        }),
      );
    });
  });
}

/** Runs `git status` for the requested workspace path. */
export function gitStatusTool(
  workspacePath: string,
  options?: Readonly<{ cwd?: string; short?: boolean; pathspec?: string }>,
): Promise<ToolResult> {
  const args = options?.short ? ["status", "--short"] : ["status"];
  if (options?.pathspec?.trim()) {
    args.push("--", options.pathspec.trim());
  }
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: "git",
    args,
    label: "git status",
    category: "git",
  });
}

/** Runs `git diff` or `git diff --staged` for the requested workspace path. */
export function gitDiffTool(
  workspacePath: string,
  options?: Readonly<{
    cwd?: string;
    pathspec?: string;
    staged?: boolean;
    maxChars?: number;
  }>,
): Promise<ToolResult> {
  const args = ["diff"];
  if (options?.staged) {
    args.push("--staged");
  }
  if (options?.pathspec?.trim()) {
    args.push("--", options.pathspec.trim());
  }
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: "git",
    args,
    label: options?.staged ? "git diff --staged" : "git diff",
    category: "git",
    ...(typeof options?.maxChars === "number"
      ? { maxChars: options.maxChars }
      : {}),
  });
}

/** Runs `git add` for the requested paths. */
export function gitAddTool(
  workspacePath: string,
  paths: readonly string[],
  options?: Readonly<{ cwd?: string }>,
): Promise<ToolResult> {
  const normalizedPaths = paths.map((item) => item.trim()).filter(Boolean);
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: "git",
    args: ["add", ...(normalizedPaths.length > 0 ? normalizedPaths : ["."])],
    label: "git add",
    category: "git",
  });
}

/** Runs `git commit` with the provided message. */
export function gitCommitTool(
  workspacePath: string,
  message: string,
  options?: Readonly<{ cwd?: string; all?: boolean }>,
): Promise<ToolResult> {
  const args = ["commit"];
  if (options?.all) {
    args.push("-a");
  }
  args.push("-m", message);
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: "git",
    args,
    label: "git commit",
    category: "git",
  });
}

/** Runs `git push` with optional remote and branch arguments. */
export function gitPushTool(
  workspacePath: string,
  options?: Readonly<{ cwd?: string; remote?: string; branch?: string }>,
): Promise<ToolResult> {
  const args = ["push"];
  if (options?.remote?.trim()) {
    args.push(options.remote.trim());
  }
  if (options?.branch?.trim()) {
    args.push(options.branch.trim());
  }
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: "git",
    args,
    label: "git push",
    category: "git",
  });
}

/** Runs `git pull` with optional remote and branch arguments. */
export function gitPullTool(
  workspacePath: string,
  options?: Readonly<{ cwd?: string; remote?: string; branch?: string }>,
): Promise<ToolResult> {
  const args = ["pull"];
  if (options?.remote?.trim()) {
    args.push(options.remote.trim());
  }
  if (options?.branch?.trim()) {
    args.push(options.branch.trim());
  }
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: "git",
    args,
    label: "git pull",
    category: "git",
  });
}

/** Runs `git checkout` or `git checkout -b` for the requested ref. */
export function gitCheckoutTool(
  workspacePath: string,
  ref: string,
  options?: Readonly<{ cwd?: string; createBranch?: boolean }>,
): Promise<ToolResult> {
  const args = ["checkout"];
  if (options?.createBranch) {
    args.push("-b");
  }
  args.push(ref);
  return runDirectBinaryTool({
    workspacePath,
    cwd: options?.cwd,
    binary: "git",
    args,
    label: "git checkout",
    category: "git",
  });
}
