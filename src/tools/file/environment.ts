/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-06-08
 * @modify date 2026-06-08
 * @desc Read-only workspace environment inspection primitives for profiler subagents.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolResult } from "../entities/file-tools";

export type EnvironmentCommandCheck = Readonly<{
  command?: unknown;
  binary?: unknown;
  args?: unknown;
}>;

export type InspectWorkspaceEnvironmentRequest = Readonly<{
  workspacePath: string;
  cwd?: string;
  paths?: readonly unknown[];
  envVars?: readonly unknown[];
  commandChecks?: readonly EnvironmentCommandCheck[];
  maxChars?: number;
}>;

const MAX_PATH_CHECKS = 80;
const MAX_ENV_CHECKS = 40;
const MAX_COMMAND_CHECKS = 30;
const MAX_COMMAND_TIMEOUT_MS = 5_000;
const SAFE_VERSION_ARGS = new Set([
  "--version",
  "-version",
  "-v",
  "-V",
  "version",
  "--help",
  "-h",
  "help",
  "--info",
  "info",
]);

function isWithinDirectory(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspacePath(workspacePath: string, rawPath: string): string | null {
  const resolved = path.resolve(workspacePath, rawPath || ".");
  return isWithinDirectory(resolved, workspacePath) ? resolved : null;
}

function truncate(text: string, maxChars: number): Readonly<{ content: string; truncated: boolean }> {
  if (maxChars <= 0 || text.length <= maxChars) {
    return Object.freeze({ content: text, truncated: false });
  }
  return Object.freeze({
    content: `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`,
    truncated: true,
  });
}

function normalizeStringArray(value: readonly unknown[] | undefined, limit: number): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .slice(0, limit),
  );
}

function normalizeCommandName(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || /\s/.test(raw) || /[;&|`$<>]/.test(raw)) return "";
  return raw;
}

function normalizeVersionArgs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const args = value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 4);
  if (args.some((arg) => !SAFE_VERSION_ARGS.has(arg))) {
    return Object.freeze([]);
  }
  return Object.freeze(args);
}

function isSecretEnvName(name: string): boolean {
  return /(?:key|token|secret|password|passwd|credential|auth|bearer)/i.test(name);
}

function inspectPath(workspacePath: string, rawPath: string): Readonly<Record<string, unknown>> {
  const resolved = resolveWorkspacePath(workspacePath, rawPath);
  if (!resolved) {
    return Object.freeze({
      path: rawPath,
      exists: false,
      error: "Path escapes the workspace.",
    });
  }
  try {
    const stat = fs.statSync(resolved);
    const type = stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other";
    let childCount: number | undefined;
    if (stat.isDirectory()) {
      try {
        childCount = fs.readdirSync(resolved).length;
      } catch {
        childCount = undefined;
      }
    }
    return Object.freeze({
      path: rawPath,
      absolutePath: resolved,
      exists: true,
      type,
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      ...(typeof childCount === "number" ? { childCount } : {}),
    });
  } catch {
    return Object.freeze({
      path: rawPath,
      absolutePath: resolved,
      exists: false,
    });
  }
}

function resolveCommand(command: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* ignore inaccessible PATH entries */
      }
    }
  }
  return null;
}

function inspectCommand(
  cwd: string,
  rawCheck: EnvironmentCommandCheck,
): Readonly<Record<string, unknown>> {
  const command = normalizeCommandName(rawCheck.command ?? rawCheck.binary);
  if (!command) {
    return Object.freeze({
      command: String(rawCheck.command ?? rawCheck.binary ?? ""),
      available: false,
      error: "Command must be a single binary name without shell syntax.",
    });
  }
  const resolvedBinary = resolveCommand(command);
  const args = normalizeVersionArgs(rawCheck.args);
  const rawArgsProvided = Array.isArray(rawCheck.args) && rawCheck.args.length > 0;
  if (!resolvedBinary) {
    return Object.freeze({
      command,
      available: false,
    });
  }
  if (rawArgsProvided && args.length === 0) {
    return Object.freeze({
      command,
      available: true,
      resolvedBinary,
      success: false,
      error: "Only safe version/info args are accepted for command checks.",
    });
  }
  if (!rawArgsProvided) {
    return Object.freeze({
      command,
      available: true,
      resolvedBinary,
    });
  }
  const result = spawnSync(resolvedBinary, [...args], {
    cwd,
    encoding: "utf-8",
    timeout: MAX_COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) {
    return Object.freeze({
      command,
      args,
      available: true,
      resolvedBinary,
      success: false,
      error: result.error.message,
      ...(output ? { output: output.split(/\r?\n/).slice(0, 3).join(" ") } : {}),
    });
  }
  return Object.freeze({
    command,
    args,
    available: true,
    resolvedBinary,
    success: typeof result.status === "number" ? result.status === 0 : true,
    exitCode: typeof result.status === "number" ? result.status : null,
    ...(output ? { output: output.split(/\r?\n/).slice(0, 3).join(" ") } : {}),
  });
}

export function inspectWorkspaceEnvironmentTool(
  request: InspectWorkspaceEnvironmentRequest,
): ToolResult {
  const workspacePath = path.resolve(request.workspacePath);
  const cwd = resolveWorkspacePath(workspacePath, request.cwd ?? ".") ?? workspacePath;
  const pathChecks = normalizeStringArray(request.paths, MAX_PATH_CHECKS)
    .map((target) => inspectPath(workspacePath, target));
  const envChecks = normalizeStringArray(request.envVars, MAX_ENV_CHECKS)
    .map((name) => {
      const value = process.env[name];
      return Object.freeze({
        name,
        set: typeof value === "string",
        ...(typeof value === "string"
          ? {
              valuePreview: isSecretEnvName(name)
                ? "[set, hidden]"
                : value.slice(0, 120),
            }
          : {}),
      });
    });
  const commandChecks = (Array.isArray(request.commandChecks) ? request.commandChecks : [])
    .slice(0, MAX_COMMAND_CHECKS)
    .map((check) => inspectCommand(cwd, check));
  const payload = Object.freeze({
    machine: Object.freeze({
      platform: process.platform,
      osType: os.type(),
      release: os.release(),
      arch: os.arch(),
      shell: process.env.SHELL ?? "",
      pathSeparator: path.sep,
    }),
    workspacePath,
    cwd,
    pathChecks: Object.freeze(pathChecks),
    envChecks: Object.freeze(envChecks),
    commandChecks: Object.freeze(commandChecks),
  });
  const formatted = JSON.stringify(payload, null, 2);
  const maxChars = Math.max(1_000, Number(request.maxChars ?? 8_000));
  const output = truncate(formatted, maxChars);
  return Object.freeze({
    success: true,
    content: output.content,
    meta: Object.freeze({
      evidenceKey: `inspect_workspace_environment:${cwd}:${pathChecks.length}:${envChecks.length}:${commandChecks.length}`,
      cwd,
      pathCheckCount: pathChecks.length,
      envCheckCount: envChecks.length,
      commandCheckCount: commandChecks.length,
      truncated: output.truncated,
    }),
  });
}
