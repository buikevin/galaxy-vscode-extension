/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-06-07
 * @modify date 2026-06-07
 * @desc Safe read-only terminal inspection tool for the VS Code runtime.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { TERMINAL_ALLOWED_COMMANDS, TERMINAL_DENYLIST } from "./constants";
import type { ToolResult } from "../entities/file-tools";

export type RunInTerminalOptions = Readonly<{
  cwd?: string;
  timeoutMs?: number;
  maxChars?: number;
}>;

function truncateTerminalOutput(
  text: string,
  maxChars: number,
): Readonly<{ content: string; truncated: boolean }> {
  if (maxChars <= 0 || text.length <= maxChars) {
    return Object.freeze({ content: text, truncated: false });
  }
  return Object.freeze({
    content: `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`,
    truncated: true,
  });
}

function isWithinDirectory(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateTerminalCommand(
  command: string,
): Readonly<{ ok: true; normalized: string } | { ok: false; reason: string }> {
  const normalized = command.trim();
  if (!normalized) {
    return Object.freeze({ ok: false, reason: "Command is required." });
  }
  for (const pattern of TERMINAL_DENYLIST) {
    if (pattern.test(normalized)) {
      return Object.freeze({
        ok: false,
        reason: "run_in_terminal only allows read-only information commands. Destructive commands, shell chaining, and redirection are blocked. Use run_project_command or run_terminal_command for executable validation commands and calculation snippets.",
      });
    }
  }
  const firstToken = normalized.match(/^[^\s]+/)?.[0]?.toLowerCase() ?? "";
  if (!TERMINAL_ALLOWED_COMMANDS.has(firstToken)) {
    return Object.freeze({
      ok: false,
      reason: `Command "${firstToken}" is not allowed. Use run_in_terminal only for safe information-gathering commands. Use run_project_command or run_terminal_command for executable validation commands and calculation snippets.`,
    });
  }
  const lowered = normalized.toLowerCase();
  if (["node", "python", "python3", "ruby", "php", "java", "dotnet"].includes(firstToken)) {
    const safeVersionCommand =
      /(^|\s)(--version|-v|version)\b/.test(lowered) ||
      lowered === "dotnet --info" ||
      lowered === "node -p process.version";
    if (!safeVersionCommand) {
      return Object.freeze({
        ok: false,
        reason: `Command "${firstToken}" is only allowed for version/info queries in run_in_terminal. Use run_project_command or run_terminal_command for executable validation commands and calculation snippets.`,
      });
    }
  }
  return Object.freeze({ ok: true, normalized });
}

export async function runInTerminalTool(
  workspaceRoot: string,
  command: string,
  options?: RunInTerminalOptions,
): Promise<ToolResult> {
  const validated = validateTerminalCommand(command);
  if (!validated.ok) {
    return Object.freeze({
      success: false,
      content: "",
      error: validated.reason,
    });
  }

  const cwd = path.resolve(workspaceRoot, options?.cwd ?? ".");
  if (!isWithinDirectory(cwd, workspaceRoot)) {
    return Object.freeze({
      success: false,
      content: "",
      error: "cwd must stay inside the current workspace.",
    });
  }

  try {
    const raw = execSync(validated.normalized, {
      cwd,
      encoding: "utf-8",
      timeout: Math.max(1_000, Math.min(20_000, Number(options?.timeoutMs ?? 8_000))),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = truncateTerminalOutput(
      String(raw),
      Math.max(500, Number(options?.maxChars ?? 4_000)),
    );
    return Object.freeze({
      success: true,
      content: output.content.trim() || "(no output)",
      meta: Object.freeze({
        cwd,
        truncated: output.truncated,
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: `Command failed or timed out: ${String(error)}`,
    });
  }
}
