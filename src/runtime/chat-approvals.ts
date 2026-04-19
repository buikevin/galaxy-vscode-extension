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
  if (toolName === "request_code_review") {
    return "review";
  }
  if (toolName === "validate_code") {
    return "validation";
  }
  if (
    toolName === "search_web" ||
    toolName === "extract_web" ||
    toolName === "map_web" ||
    toolName === "crawl_web"
  ) {
    return "webResearch";
  }
  if (toolName.startsWith("vscode_")) {
    return "vscodeNative";
  }
  if (
    toolName === "search_extension_tools" ||
    toolName === "activate_extension_tools"
  ) {
    return "vscodeNative";
  }
  if (toolName.startsWith("galaxy_design")) {
    return "galaxyDesign";
  }
  if (
    toolName === "write_file" ||
    toolName === "create_drawio_diagram" ||
    toolName === "convert_drawio_diagram" ||
    toolName === "export_drawio_diagram" ||
    toolName === "edit_file" ||
    toolName === "edit_file_range" ||
    toolName === "multi_edit_file_ranges" ||
    toolName === "revert_file" ||
    toolName === "diff_file"
  ) {
    return "editFiles";
  }
  if (
    toolName === "run_project_command" ||
    toolName === "run_terminal_command" ||
    toolName === "await_terminal_command" ||
    toolName === "get_terminal_output" ||
    toolName === "kill_terminal_command" ||
    toolName === "git_status" ||
    toolName === "git_diff" ||
    toolName === "git_add" ||
    toolName === "git_commit" ||
    toolName === "git_push" ||
    toolName === "git_pull" ||
    toolName === "git_checkout"
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
