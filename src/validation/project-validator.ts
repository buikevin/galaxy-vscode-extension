/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Validation command selection and execution for VS Code workspace quality gates.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { GalaxyConfig } from "../shared/config";
import type { TrackedFile } from "../shared/runtime";
import { tryResolveDirectCommand } from "../runtime/direct-command";
import {
  buildShellEnvironment,
  checkCommandAvailability,
  resolveShellProfile,
  shouldUseWindowsCommandShell,
} from "../runtime/shell-resolver";
import { validateCodeTool } from "../tools/file/diff-validate";
import type {
  FinalValidationResult,
  ValidationCommand,
  ValidationCommandStreamCallbacks,
  ValidationRunResult,
} from "../shared/validation";
import { detectProjectCommands } from "./command-detection";
import { parseIssuesWithCwd } from "./issues";
import { detectValidationProfiles } from "./profiles";
import { buildValidationSelectionSummary } from "./summary";
import { MAX_VALIDATION_CAPTURE_CHARS } from "../shared/constants";

/**
 * Checks whether a required binary is available from the command runtime environment.
 *
 * @param binary Executable name to probe.
 * @param cwd Working directory used for command resolution.
 * @returns `true` when the executable can be launched from the workspace environment.
 */
function commandExists(binary: string, cwd: string): boolean {
  return checkCommandAvailability(binary, cwd);
}

/**
 * Normalizes command text so Windows and POSIX relative paths can be matched consistently.
 *
 * @param commandText Raw command text from validation detection.
 * @returns Command text using forward slashes for path comparisons.
 */
function normalizeCommandText(commandText: string): string {
  return commandText.replace(/\\/g, "/").trim();
}

/**
 * Checks whether a Composer bin proxy exists for the workspace on either POSIX or Windows layouts.
 *
 * @param cwd Workspace root.
 * @param binaryName Composer binary name without path or extension.
 * @returns `true` when a supported proxy exists.
 */
function composerBinaryExists(cwd: string, binaryName: string): boolean {
  const binPath = path.join(cwd, "vendor", "bin", binaryName);
  return fs.existsSync(binPath) || fs.existsSync(`${binPath}.bat`);
}

/**
 * Filters out validation commands whose required tooling is not currently available.
 *
 * @param command Candidate validation command.
 * @returns `true` when the runtime can execute the command safely.
 */
function isCommandAvailable(command: ValidationCommand): boolean {
  const normalizedCommand = normalizeCommandText(command.command);

  if (command.command.startsWith("bun run ")) {
    return commandExists("bun", command.cwd);
  }
  if (command.command.startsWith("bunx ")) {
    return commandExists("bunx", command.cwd);
  }
  if (
    command.command.startsWith("pnpm run ") ||
    command.command.startsWith("pnpm exec ")
  ) {
    return commandExists("pnpm", command.cwd);
  }
  if (
    command.command.startsWith("yarn run ") ||
    command.command.startsWith("yarn ")
  ) {
    return commandExists("yarn", command.cwd);
  }
  if (command.command.startsWith("npm run ")) {
    return commandExists("npm", command.cwd);
  }
  if (command.command.startsWith("npx ")) {
    return commandExists("npx", command.cwd);
  }
  if (command.command.startsWith("cargo ")) {
    return commandExists("cargo", command.cwd);
  }
  if (command.command.startsWith("go ")) {
    return commandExists("go", command.cwd);
  }
  if (command.command.startsWith("mvn ")) {
    return commandExists("mvn", command.cwd);
  }
  if (command.command.startsWith("./gradlew ")) {
    return (
      fs.existsSync(path.join(command.cwd, "gradlew")) ||
      fs.existsSync(path.join(command.cwd, "gradlew.bat"))
    );
  }
  if (
    command.command.startsWith("gradlew.bat ") ||
    command.command.startsWith(".\\gradlew.bat ")
  ) {
    return fs.existsSync(path.join(command.cwd, "gradlew.bat"));
  }
  if (command.command.startsWith("gradle ")) {
    return commandExists("gradle", command.cwd);
  }
  if (command.command.startsWith("dotnet ")) {
    return commandExists("dotnet", command.cwd);
  }
  if (command.command.startsWith("make ")) {
    return commandExists("make", command.cwd);
  }
  if (command.command.startsWith("ruff ")) {
    return commandExists("ruff", command.cwd);
  }
  if (command.command.startsWith("mypy ")) {
    return commandExists("mypy", command.cwd);
  }
  if (command.command === "pytest") {
    return commandExists("pytest", command.cwd);
  }
  if (command.command.startsWith("python -m ")) {
    return commandExists("python", command.cwd);
  }
  if (
    normalizedCommand === "vendor/bin/phpstan analyse" ||
    normalizedCommand === "vendor/bin/phpstan.bat analyse"
  ) {
    return composerBinaryExists(command.cwd, "phpstan");
  }
  if (
    normalizedCommand === "vendor/bin/phpunit" ||
    normalizedCommand === "vendor/bin/phpunit.bat"
  ) {
    return composerBinaryExists(command.cwd, "phpunit");
  }
  if (normalizedCommand.includes("shellcheck")) {
    return (
      process.platform !== "win32" &&
      commandExists("shellcheck", command.cwd) &&
      commandExists("find", command.cwd) &&
      commandExists("xargs", command.cwd)
    );
  }
  if (command.command === "rake test") {
    return commandExists("rake", command.cwd);
  }
  return true;
}

/**
 * Executes one project-level validation command and streams output back to the caller when requested.
 *
 * @param command Validation command selected for the workspace quality gate.
 * @param callbacks Optional stream callbacks used by the UI to display command progress.
 * @returns Structured validation run result for the executed command.
 */
async function runProjectCommand(
  command: ValidationCommand,
  callbacks?: ValidationCommandStreamCallbacks,
): Promise<ValidationRunResult> {
  const startedAt = Date.now();
  const directCommand = tryResolveDirectCommand(command.command, command.cwd);
  const effectiveCommandText =
    directCommand?.displayCommandText ?? command.command;
  const toolCallId = `validation:${command.id}:${startedAt}`;

  return new Promise((resolve) => {
    const child = directCommand
      ? spawn(directCommand.resolvedBinary, [...directCommand.args], {
          cwd: command.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: buildShellEnvironment(),
          shell: shouldUseWindowsCommandShell(directCommand.resolvedBinary),
        })
      : (() => {
          const shell = resolveShellProfile();
          return spawn(
            shell.executable,
            [...shell.commandArgs(command.command)],
            {
              cwd: command.cwd,
              stdio: ["ignore", "pipe", "pipe"],
              env: buildShellEnvironment(),
            },
          );
        })();

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 120_000);

    void callbacks?.onStart?.({
      toolCallId,
      commandText: effectiveCommandText,
      cwd: command.cwd,
      startedAt,
    });

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout = `${stdout}${text}`.slice(-MAX_VALIDATION_CAPTURE_CHARS);
      void callbacks?.onChunk?.({
        toolCallId,
        chunk: text,
      });
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-MAX_VALIDATION_CAPTURE_CHARS);
      void callbacks?.onChunk?.({
        toolCallId,
        chunk: text,
      });
    });

    const finalize = (
      success: boolean,
      rawOutput: string,
      suffix: "passed" | "failed",
      exitCode: number,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      void callbacks?.onEnd?.({
        toolCallId,
        exitCode,
        success,
        durationMs,
      });
      resolve(
        Object.freeze({
          success,
          commandId: command.id,
          command: command.command,
          profile: command.profile,
          category: command.category,
          durationMs,
          summary: `${command.label} ${suffix}`,
          issues: success
            ? Object.freeze([])
            : parseIssuesWithCwd(rawOutput, command.id, command.cwd),
          rawOutputPreview: rawOutput.slice(0, 4000),
        }),
      );
    };

    child.on("error", (error) => {
      finalize(false, String(error), "failed", 1);
    });
    child.on("close", (code, signal) => {
      const rawOutput = `${stdout}${stderr}`.trim();
      if (code === 0) {
        finalize(true, rawOutput, "passed", 0);
        return;
      }
      const errorText =
        rawOutput ||
        `Command exited with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}`;
      finalize(false, errorText, "failed", code ?? 1);
    });
  });
}

/**
 * Runs per-file fallback validation when no project-level static analysis command is available.
 *
 * @param sessionFiles Files changed or touched in the current turn.
 * @returns Validation results for each supported file.
 */
function runFileSafetyNetValidation(
  sessionFiles: readonly TrackedFile[],
): readonly ValidationRunResult[] {
  const supportedExtensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".json",
    ".py",
    ".sh",
    ".bash",
    ".php",
    ".rb",
  ]);
  const runs: ValidationRunResult[] = [];

  for (const tracked of sessionFiles) {
    const ext = path.extname(tracked.filePath).toLowerCase();
    if (!supportedExtensions.has(ext)) {
      continue;
    }

    const startedAt = Date.now();
    const result = validateCodeTool(tracked.filePath);
    runs.push(
      Object.freeze({
        success: result.success,
        commandId: `file:${tracked.filePath}`,
        command: `validate_code ${tracked.filePath}`,
        profile: "file",
        category: "file",
        durationMs: Date.now() - startedAt,
        summary: result.success
          ? `Validation passed for ${tracked.filePath}`
          : `Validation failed for ${tracked.filePath}`,
        issues: result.success
          ? Object.freeze([])
          : parseIssuesWithCwd(
              result.content || result.error || "",
              "validate_code",
              process.cwd(),
            ),
        rawOutputPreview: (result.content || result.error || "").slice(0, 4000),
      }),
    );
  }

  return Object.freeze(runs);
}

/**
 * Runs validation commands sequentially until one fails, preserving execution order in the result list.
 *
 * @param commands Validation commands selected for a pipeline stage.
 * @param callbacks Optional stream callbacks used by the UI to display command progress.
 * @returns Ordered run results collected before completion or first failure.
 */
async function runCommandPipeline(
  commands: readonly ValidationCommand[],
  callbacks?: ValidationCommandStreamCallbacks,
): Promise<readonly ValidationRunResult[]> {
  const runs: ValidationRunResult[] = [];
  for (const command of commands) {
    const run = await runProjectCommand(command, callbacks);
    runs.push(run);
    if (!run.success) {
      break;
    }
  }
  return Object.freeze(runs);
}

/**
 * Finds the first failed validation run in execution order.
 *
 * @param runs Validation runs to inspect.
 * @returns The first failed run or `undefined` when every run succeeded.
 */
function findFirstFailedRun(
  runs: readonly ValidationRunResult[],
): ValidationRunResult | undefined {
  return runs.find((run) => !run.success);
}

/**
 * Builds a success summary covering every completed validation run.
 *
 * @param runs Validation runs that completed successfully.
 * @returns Human-readable success summary.
 */
function buildSuccessSummary(runs: readonly ValidationRunResult[]): string {
  if (runs.length === 0) {
    return "No validation checks executed.";
  }
  return runs.map((run) => run.summary).join("; ");
}

/**
 * Executes the final workspace validation gate using project-level commands first and file-level fallback second.
 *
 * @param opts Validation execution options.
 * `workspacePath`: Absolute workspace root for command detection.
 * `sessionFiles`: Files touched in the current turn.
 * `config`: Optional validation preferences from Galaxy config.
 * `streamCallbacks`: Optional callbacks used to surface command output live in the UI.
 * @returns Final validation result consumed by the runtime quality gate.
 */
export async function runFinalValidation(opts: {
  workspacePath: string;
  sessionFiles: readonly TrackedFile[];
  config?: Pick<GalaxyConfig, "validation">;
  streamCallbacks?: ValidationCommandStreamCallbacks;
}): Promise<FinalValidationResult> {
  const profiles = detectValidationProfiles(
    opts.workspacePath,
    opts.sessionFiles,
  );
  const commands = detectProjectCommands(
    opts.workspacePath,
    opts.sessionFiles,
    opts.config?.validation,
  ).filter(isCommandAvailable);
  const lintCommands = commands.filter(
    (command) => command.category === "lint",
  );
  const staticCommands = commands.filter(
    (command) => command.category === "static-check",
  );
  const testCommands = commands.filter(
    (command) => command.category === "test",
  );
  const runs: ValidationRunResult[] = [];
  const shouldRunFileSafetyNet = staticCommands.length === 0;
  const selectionSummary = buildValidationSelectionSummary(
    opts.workspacePath,
    profiles,
    commands,
    shouldRunFileSafetyNet,
  );

  if (lintCommands.length > 0 || staticCommands.length > 0) {
    const [lintRuns, staticRuns] = await Promise.all([
      runCommandPipeline(lintCommands, opts.streamCallbacks),
      runCommandPipeline(staticCommands, opts.streamCallbacks),
    ]);

    runs.push(...lintRuns, ...staticRuns);

    const failedStaticGate = findFirstFailedRun([...lintRuns, ...staticRuns]);
    if (failedStaticGate) {
      return Object.freeze({
        success: false,
        mode: "project",
        selectionSummary,
        runs: Object.freeze(runs),
        summary: failedStaticGate.summary,
      });
    }
  }

  if (testCommands.length > 0) {
    const testRuns = await runCommandPipeline(
      testCommands,
      opts.streamCallbacks,
    );
    runs.push(...testRuns);

    const failedTest = findFirstFailedRun(testRuns);
    if (failedTest) {
      return Object.freeze({
        success: false,
        mode: "project",
        selectionSummary,
        runs: Object.freeze(runs),
        summary: failedTest.summary,
      });
    }
  }

  if (shouldRunFileSafetyNet) {
    const fileRuns = runFileSafetyNetValidation(opts.sessionFiles);
    runs.push(...fileRuns);

    const failedFileRun = findFirstFailedRun(fileRuns);
    if (failedFileRun) {
      return Object.freeze({
        success: false,
        mode: runs.length === fileRuns.length ? "file" : "project",
        selectionSummary,
        runs: Object.freeze(runs),
        summary: failedFileRun.summary,
      });
    }

    if (runs.length === 0 && fileRuns.length === 0) {
      return Object.freeze({
        success: true,
        mode: "none",
        selectionSummary,
        runs: Object.freeze([]),
        summary: "No validation profile detected for changed files.",
      });
    }

    return Object.freeze({
      success: true,
      mode: runs.length === fileRuns.length ? "file" : "project",
      selectionSummary,
      runs: Object.freeze(runs),
      summary: buildSuccessSummary(runs),
    });
  }

  if (runs.length === 0) {
    return Object.freeze({
      success: true,
      mode: "none",
      selectionSummary,
      runs: Object.freeze([]),
      summary: "No validation profile detected for changed files.",
    });
  }

  return Object.freeze({
    success: true,
    mode: "project",
    selectionSummary,
    runs: Object.freeze(runs),
    summary: buildSuccessSummary(runs),
  });
}
