/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-03-31
 * @desc Shared tool-name normalization helpers for VS Code file tools.
 */

import type { ToolCall } from "../entities/file-tools";

/**
 * Normalizes model-emitted tool names into the canonical internal tool ids.
 *
 * @param raw Raw tool name emitted by the model.
 * @returns Canonical tool id used by the runtime.
 */
export function normalizeToolName(raw: string): string {
  const lowered = String(raw ?? "")
    .toLowerCase()
    .trim();
  const base = lowered.split(/[./]/).pop() ?? lowered;
  const withUnderscore = base.replace(/[-\s]+/g, "_");
  const cleaned = withUnderscore.replace(/[^a-z0-9_]/g, "");
  switch (cleaned) {
    case "readfile":
      return "read_file";
    case "writefile":
      return "write_file";
    case "createdrawiodiagram":
      return "create_drawio_diagram";
    case "convertdrawiodiagram":
      return "convert_drawio_diagram";
    case "exportdrawiodiagram":
      return "export_drawio_diagram";
    case "insertfileatline":
      return "insert_file_at_line";
    case "listdir":
      return "list_dir";
    case "editfile":
      return "edit_file";
    case "multieditfileranges":
      return "multi_edit_file_ranges";
    case "validatecode":
      return "validate_code";
    case "runterminalcommand":
      return "run_terminal_command";
    case "awaitterminalcommand":
      return "await_terminal_command";
    case "getterminaloutput":
      return "get_terminal_output";
    case "killterminalcommand":
      return "kill_terminal_command";
    case "runprojectcommand":
      return "run_project_command";
    case "difffile":
      return "diff_file";
    case "revertfile":
      return "revert_file";
    case "requestcodereview":
      return "request_code_review";
    case "galaxydesignprojectinfo":
      return "galaxy_design_project_info";
    case "galaxydesignregistry":
      return "galaxy_design_registry";
    case "galaxydesigninit":
      return "galaxy_design_init";
    case "galaxydesignadd":
      return "galaxy_design_add";
    case "readwebpage":
      return "read_web_page";
    case "searchweb":
      return "search_web";
    case "extractweb":
      return "extract_web";
    case "mapweb":
      return "map_web";
    case "crawlweb":
      return "crawl_web";
    case "readdocument":
      return "read_document";
    case "findtestfiles":
      return "find_test_files";
    case "getlatesttestfailure":
      return "get_latest_test_failure";
    case "getlatestreviewfindings":
      return "get_latest_review_findings";
    case "getnextreviewfinding":
      return "get_next_review_finding";
    case "dismissreviewfinding":
      return "dismiss_review_finding";
    case "vscodeopendiff":
      return "vscode_open_diff";
    case "vscodestartfrontendpreview":
    case "startfrontendpreview":
      return "vscode_start_frontend_preview";
    case "vscodeshowproblems":
      return "vscode_show_problems";
    case "vscodeworkspacesearch":
      return "vscode_workspace_search";
    case "vscodefindreferences":
      return "vscode_find_references";
    case "searchextensiontools":
      return "search_extension_tools";
    case "activateextensiontools":
      return "activate_extension_tools";
    case "search":
      return "grep";
    default:
      return cleaned;
  }
}

/**
 * Extracts the primary file path parameter from one tool call.
 *
 * @param call Tool call to inspect.
 * @returns Trimmed path string or an empty string when the tool has no path parameter.
 */
export function getToolFilePath(call: ToolCall): string {
  return String(call.params.path ?? "").trim();
}

/**
 * Returns whether one canonical tool id writes source files.
 *
 * @param toolName Raw or canonical tool name.
 * @returns True when the tool mutates file contents.
 */
export function isCodeWriteTool(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return (
    normalized === "write_file" ||
    normalized === "create_drawio_diagram" ||
    normalized === "convert_drawio_diagram" ||
    normalized === "export_drawio_diagram" ||
    normalized === "insert_file_at_line" ||
    normalized === "edit_file" ||
    normalized === "edit_file_range" ||
    normalized === "multi_edit_file_ranges"
  );
}
