/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Galaxy Design tool execution wrappers for info, init, and add actions.
 */

import { spawnSync } from "node:child_process";
import type { ToolResult } from "../entities/file-tools";
import type { GalaxyDesignActionPlan } from "../entities/galaxy-design";
import { buildShellEnvironment } from "../../runtime/shell-resolver";
import { getGalaxyDesignProjectInfo, prepareGalaxyDesignAction } from "./core";

/**
 * Builds a user-facing summary for the current project's Galaxy Design status.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param pathInput Optional project path inside the workspace.
 * @returns Tool result containing current Galaxy Design project info.
 */
export async function galaxyDesignProjectInfoTool(
  workspaceRoot: string,
  pathInput?: string,
): Promise<ToolResult> {
  const info = getGalaxyDesignProjectInfo(workspaceRoot, pathInput);
  if ("error" in info) {
    return Object.freeze({ success: false, content: "", error: info.error });
  }
  const lines = [
    "Galaxy Design project info",
    `Path: ${info.targetPath}`,
    `Framework: ${info.framework}`,
    ...(info.framework !== "unknown"
      ? [
          `Registry framework: ${info.registryFramework}${info.framework !== info.registryFramework ? ` (source package used for ${info.framework})` : ""}`,
        ]
      : []),
    `Package manager: ${info.packageManager} (${info.packageManagerSource})`,
    `Galaxy Design initialized: ${info.galaxyDesignInitialized ? "yes" : "no"}`,
    info.componentsConfigPath
      ? `components.json: ${info.componentsConfigPath}`
      : "components.json: not found",
  ];
  if (!info.galaxyDesignInitialized && info.framework !== "unknown") {
    lines.push("Suggested next step: run galaxy_design_init.");
  } else if (info.galaxyDesignInitialized) {
    lines.push(
      "Suggested next step: use galaxy_design_add or galaxy_design_registry.",
    );
  }
  return Object.freeze({
    success: true,
    content: lines.join("\n"),
    meta: Object.freeze({
      targetPath: info.targetPath,
      framework: info.framework,
      packageManager: info.packageManager,
      packageManagerSource: info.packageManagerSource,
      initialized: info.galaxyDesignInitialized,
      ...(info.componentsConfigPath
        ? { componentsConfigPath: info.componentsConfigPath }
        : {}),
    }),
  });
}

/**
 * Executes one prepared Galaxy Design action plan.
 *
 * @param plan Prepared init/add action plan.
 * @returns Tool result containing command output and metadata.
 */
function runGalaxyDesignAction(plan: GalaxyDesignActionPlan): ToolResult {
  try {
    const result = spawnSync(plan.executable, [...plan.args], {
      cwd: plan.targetPath,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 8,
      env: buildShellEnvironment(),
    });
    const stdout = String(result.stdout ?? "").trim();
    const stderr = String(result.stderr ?? "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    const exitCode =
      typeof result.status === "number" ? result.status : result.error ? 1 : 0;
    const outputSignalsFailure =
      /failed to install dependencies/i.test(combined) ||
      /✖\s+failed/i.test(combined) ||
      /ExecaError:\s*Command failed/i.test(combined) ||
      /\berror:\s+/i.test(combined);
    if (result.error || exitCode !== 0 || outputSignalsFailure) {
      return Object.freeze({
        success: false,
        content: combined,
        error:
          `Galaxy Design ${plan.action} failed` +
          (result.error
            ? `: ${result.error.message}`
            : outputSignalsFailure
              ? " due to CLI-reported install/setup errors"
              : ` with exit code ${exitCode}`),
        meta: Object.freeze({
          action: plan.action,
          framework: plan.framework,
          packageManager: plan.packageManager,
          runnerPackageManager: plan.runnerPackageManager,
          targetPath: plan.targetPath,
          commandPreview: plan.commandPreview,
          components: Object.freeze([...plan.components]),
          exitCode,
        }),
      });
    }
    return Object.freeze({
      success: true,
      content:
        combined || `Galaxy Design ${plan.action} completed successfully.`,
      meta: Object.freeze({
        action: plan.action,
        framework: plan.framework,
        packageManager: plan.packageManager,
        runnerPackageManager: plan.runnerPackageManager,
        targetPath: plan.targetPath,
        commandPreview: plan.commandPreview,
        components: Object.freeze([...plan.components]),
        exitCode,
      }),
    });
  } catch (error) {
    return Object.freeze({
      success: false,
      content: "",
      error: `Galaxy Design ${plan.action} failed: ${error instanceof Error ? error.message : String(error)}`,
      meta: Object.freeze({
        action: plan.action,
        framework: plan.framework,
        packageManager: plan.packageManager,
        runnerPackageManager: plan.runnerPackageManager,
        targetPath: plan.targetPath,
        commandPreview: plan.commandPreview,
        components: Object.freeze([...plan.components]),
        exitCode: 1,
      }),
    });
  }
}

/**
 * Initializes Galaxy Design in the requested workspace project.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param pathInput Optional project path inside the workspace.
 * @returns Tool result describing the initialization run.
 */
export async function galaxyDesignInitTool(
  workspaceRoot: string,
  pathInput?: string,
): Promise<ToolResult> {
  const plan = prepareGalaxyDesignAction(workspaceRoot, "init", {
    ...(pathInput !== undefined ? { path: pathInput } : {}),
  });
  if ("error" in plan) {
    return Object.freeze({ success: false, content: "", error: plan.error });
  }
  return runGalaxyDesignAction(plan);
}

/**
 * Adds Galaxy Design components to an initialized workspace project.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param componentsInput Component names as a string or array.
 * @param pathInput Optional project path inside the workspace.
 * @returns Tool result describing the add run.
 */
export async function galaxyDesignAddTool(
  workspaceRoot: string,
  componentsInput: readonly string[] | string,
  pathInput?: string,
): Promise<ToolResult> {
  const plan = prepareGalaxyDesignAction(workspaceRoot, "add", {
    components: componentsInput,
    ...(pathInput !== undefined ? { path: pathInput } : {}),
  });
  if ("error" in plan) {
    return Object.freeze({ success: false, content: "", error: plan.error });
  }
  return runGalaxyDesignAction(plan);
}
