/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Build approval payloads and capability mappings for extension chat tool execution.
 */

import type { GalaxyConfig } from "../shared/config";
import type { PendingActionApproval } from "../shared/runtime";
import { normalizeToolName } from "../tools/file/tooling";

/** Input used to build a pending approval request for one extension tool call. */
export type ChatApprovalRequestOptions = Readonly<{
  /** Absolute workspace path associated with the current run. */
  workspacePath: string;
  /** Active Galaxy configuration that controls tool safety. */
  config: GalaxyConfig;
  /** Raw tool name emitted by the model. */
  toolName: string;
  /** Raw tool parameters emitted by the model. */
  params: Record<string, unknown>;
}>;

/**
 * Maps a runtime tool name to the capability flag that can block it.
 *
 * @param toolName Tool name emitted by the model.
 * @returns Capability key that must be enabled before the tool may run.
 */
export function getBlockedCapability(toolName: string): string {
  const normalized = toolName.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (
    normalized === "request_code_review" ||
    normalized === "review" ||
    normalized === "code_review"
  ) {
    return "review";
  }
  if (
    normalized === "validate_code" ||
    normalized === "run_validation_suite" ||
    normalized === "validate" ||
    normalized === "validation" ||
    normalized === "test" ||
    normalized === "tests" ||
    normalized === "npm_test" ||
    normalized === "pytest" ||
    normalized === "jest" ||
    normalized === "vitest" ||
    normalized === "typecheck" ||
    normalized === "type_check" ||
    normalized === "check_types" ||
    normalized === "lint" ||
    normalized === "build"
  ) {
    return "validation";
  }
  if (
    normalized === "search_web" ||
    normalized === "extract_web" ||
    normalized === "map_web" ||
    normalized === "crawl_web" ||
    normalized === "web_search" ||
    normalized === "web" ||
    normalized === "browser"
  ) {
    return "webResearch";
  }
  if (normalized.startsWith("vscode_")) {
    return "vscodeNative";
  }
  if (
    normalized === "search_extension_tools" ||
    normalized === "activate_extension_tools"
  ) {
    return "vscodeNative";
  }
  if (normalized.startsWith("galaxy_design")) {
    return "galaxyDesign";
  }
  if (
    normalized === "write_file" ||
    normalized === "claim_file_scope" ||
    normalized === "create_drawio_diagram" ||
    normalized === "convert_drawio_diagram" ||
    normalized === "export_drawio_diagram" ||
    normalized === "export_workflow_drawio_diagram" ||
    normalized === "export_workflow_mermaid_diagram" ||
    normalized === "edit_file" ||
    normalized === "edit_file_range" ||
    normalized === "multi_edit_file_ranges" ||
    normalized === "insert_file_at_line" ||
    normalized === "revert_file" ||
    normalized === "diff_file"
  ) {
    return "editFiles";
  }
  if (
    normalized === "run_in_terminal" ||
    normalized === "run_project_command" ||
    normalized === "run_terminal_command" ||
    normalized === "run_shell_command" ||
    normalized === "shell_command" ||
    normalized === "terminal_command" ||
    normalized === "run_command" ||
    normalized === "exec_command" ||
    normalized === "execute_command" ||
    normalized === "shell" ||
    normalized === "bash" ||
    normalized === "terminal" ||
    normalized === "command" ||
    normalized === "await_terminal_command" ||
    normalized === "get_terminal_output" ||
    normalized === "kill_terminal_command" ||
    normalized === "git_status" ||
    normalized === "git_diff" ||
    normalized === "git_add" ||
    normalized === "git_commit" ||
    normalized === "git_push" ||
    normalized === "git_pull" ||
    normalized === "git_checkout"
  ) {
    return "runCommands";
  }
  return "readProject";
}

/**
 * Builds a user approval request for sensitive commands when the active safety policy requires confirmation.
 *
 * @param opts Workspace, config, tool name, and tool parameters for the pending action.
 * @returns Approval request payload, or `null` when approval is not required.
 */
export function buildApprovalRequest(
  opts: ChatApprovalRequestOptions,
): PendingActionApproval | null {
  const toolName = normalizeToolName(opts.toolName);

  if (
    toolName === "run_project_command" ||
    toolName === "run_terminal_command"
  ) {
    if (!opts.config.toolSafety.requireApprovalForProjectCommand) {
      return null;
    }
    const command = String(
      opts.params.command ?? opts.params.commandId ?? "",
    ).trim();
    const cwd = String(opts.params.cwd ?? ".").trim() || ".";
    if (command) {
      return Object.freeze({
        approvalKey: command,
        toolName,
        title: "Cấp quyền chạy lệnh",
        message: "AI Agent muốn chạy một lệnh trong workspace hiện tại.",
        details: Object.freeze([`Command: ${command}`, `cwd: ${cwd}`]),
      });
    }
  }

  if (
    toolName === "git_pull" &&
    opts.config.toolSafety.requireApprovalForGitPull
  ) {
    return Object.freeze({
      approvalKey: `git_pull:${String(opts.params.remote ?? "").trim()}:${String(opts.params.branch ?? "").trim()}`,
      toolName,
      title: "Cấp quyền git pull",
      message: "AI Agent muốn kéo thay đổi mới từ remote Git.",
      details: Object.freeze([
        `remote: ${String(opts.params.remote ?? "(default)")}`,
        `branch: ${String(opts.params.branch ?? "(tracking branch)")}`,
      ]),
    });
  }

  if (
    toolName === "git_push" &&
    opts.config.toolSafety.requireApprovalForGitPush
  ) {
    return Object.freeze({
      approvalKey: `git_push:${String(opts.params.remote ?? "").trim()}:${String(opts.params.branch ?? "").trim()}`,
      toolName,
      title: "Cấp quyền git push",
      message: "AI Agent muốn đẩy commit lên remote Git.",
      details: Object.freeze([
        `remote: ${String(opts.params.remote ?? "(default)")}`,
        `branch: ${String(opts.params.branch ?? "(current branch)")}`,
      ]),
    });
  }

  if (
    toolName === "git_checkout" &&
    opts.config.toolSafety.requireApprovalForGitCheckout
  ) {
    return Object.freeze({
      approvalKey: `git_checkout:${String(opts.params.ref ?? "").trim()}`,
      toolName,
      title: "Cấp quyền git checkout",
      message: "AI Agent muốn checkout hoặc tạo branch Git.",
      details: Object.freeze([
        `ref: ${String(opts.params.ref ?? "")}`,
        `createBranch: ${String(Boolean(opts.params.createBranch ?? false))}`,
      ]),
    });
  }

  return null;
}
