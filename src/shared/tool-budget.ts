import fs from "node:fs";
import path from "node:path";
import type { GalaxyConfig } from "./config";
import type { SubagentRoleId } from "./runtime";

const IGNORED_DIRS = new Set([
  ".git",
  ".galaxy",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

const ROLE_COMPLEXITY_BONUS: Readonly<Record<SubagentRoleId, number>> = Object.freeze({
  main: 0,
  ba: 2,
  profiler: 4,
  planning: 4,
  sa: 8,
  coding: 12,
  testing: 8,
  review: 6,
});

const PROGRESS_TOOLS = new Set([
  "write_agent_handoff",
  "claim_file_scope",
  "write_file",
  "edit_file",
  "edit_file_range",
  "multi_edit_file_ranges",
  "insert_file_at_line",
  "run_project_command",
  "run_terminal_command",
  "validate_code",
  "run_validation_suite",
  "request_code_review",
  "get_change_summary",
  "query_shared_memory",
  "query_workflow_graph",
  "inspect_workspace_environment",
]);

const PRODUCTIVE_PROGRESS_TOOLS = new Set([
  "write_agent_handoff",
  "write_file",
  "edit_file",
  "edit_file_range",
  "multi_edit_file_ranges",
  "insert_file_at_line",
  "run_project_command",
  "run_terminal_command",
  "validate_code",
  "run_validation_suite",
  "request_code_review",
  "get_change_summary",
]);

const READ_ONLY_PROGRESS_ROLES = new Set<SubagentRoleId>([
  "ba",
  "profiler",
  "planning",
  "sa",
  "review",
]);

const EVIDENCE_PROGRESS_TOOLS = new Set([
  "read_file",
  "head",
  "tail",
  "read_document",
  "grep",
  "list_dir",
  "find_test_files",
  "query_shared_memory",
  "query_workflow_graph",
  "inspect_workspace_environment",
  "diff_file",
  "get_latest_test_failure",
  "get_latest_review_findings",
]);

const ROLE_EXTENSION_STEP: Readonly<Record<SubagentRoleId, number>> = Object.freeze({
  main: 6,
  ba: 3,
  profiler: 4,
  planning: 4,
  sa: 4,
  coding: 8,
  testing: 8,
  review: 4,
});

const ROLE_STALL_LIMIT: Readonly<Record<SubagentRoleId, number>> = Object.freeze({
  main: 4,
  ba: 2,
  profiler: 3,
  planning: 3,
  sa: 3,
  coding: 4,
  testing: 4,
  review: 3,
});

function countWorkspaceFiles(workspacePath: string, limit = 250): number {
  let count = 0;
  const visit = (dirPath: string): void => {
    if (count >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= limit) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          visit(path.join(dirPath, entry.name));
        }
        continue;
      }
      if (entry.isFile()) {
        count += 1;
      }
    }
  };
  visit(workspacePath);
  return count;
}

function projectSizeBonus(workspacePath: string): number {
  const fileCount = countWorkspaceFiles(workspacePath);
  if (fileCount >= 160) return 12;
  if (fileCount >= 80) return 8;
  if (fileCount >= 30) return 4;
  return 0;
}

export function computeAdaptiveToolRoundLimit(opts: {
  config: Pick<GalaxyConfig, "activeSubagentRole" | "maxToolRounds">;
  workspacePath: string;
}): number | null {
  if (opts.config.maxToolRounds === null) {
    return null;
  }
  if (typeof opts.config.maxToolRounds !== "number" || !Number.isFinite(opts.config.maxToolRounds)) {
    return null;
  }
  const base = Math.max(1, Math.floor(opts.config.maxToolRounds));
  const role = opts.config.activeSubagentRole;
  if (!role) {
    return base;
  }
  return base + ROLE_COMPLEXITY_BONUS[role] + projectSizeBonus(opts.workspacePath);
}

export function shouldExtendToolRoundLimitAfterProgress(toolNames: readonly string[]): boolean {
  return toolNames.some((toolName) => PROGRESS_TOOLS.has(toolName));
}

function stringParam(params: Record<string, unknown> | undefined, ...names: readonly string[]): string {
  for (const name of names) {
    const value = params?.[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function numberParam(params: Record<string, unknown> | undefined, ...names: readonly string[]): number | null {
  for (const name of names) {
    const value = params?.[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function stableContentKind(content: string | undefined): string {
  if (!content?.trim()) return "empty";
  const trimmed = content.trim();
  if (/^\(no matches\)$/i.test(trimmed)) return "no_match";
  if (/^\(empty directory\)$/i.test(trimmed)) return "empty_directory";
  if (/^\(no related test\/source files found\)$/i.test(trimmed)) return "no_related_files";
  return "has_content";
}

function evidenceKeyForTool(input: {
  toolName: string;
  params?: Record<string, unknown>;
  meta?: Readonly<Record<string, unknown>>;
  content?: string;
}): string {
  const meta = input.meta ?? {};
  const explicitEvidenceKey = meta.evidenceKey;
  if (typeof explicitEvidenceKey === "string" && explicitEvidenceKey.trim()) {
    return `${input.toolName}:${explicitEvidenceKey.trim()}`;
  }
  const filePath = typeof meta.filePath === "string"
    ? meta.filePath
    : stringParam(input.params, "path", "filePath");
  const directoryPath = typeof meta.directoryPath === "string"
    ? meta.directoryPath
    : stringParam(input.params, "path", "dirPath");
  const targetPath = typeof meta.targetPath === "string"
    ? meta.targetPath
    : stringParam(input.params, "path", "filePath");

  switch (input.toolName) {
    case "read_file":
    case "head":
    case "tail":
    case "read_document":
    case "diff_file": {
      const offset = numberParam(input.params, "offset") ?? Number(meta.requestedOffset ?? 0);
      const maxLines = numberParam(input.params, "maxLines", "lines") ?? Number(meta.requestedMaxLines ?? 0);
      const mode = typeof meta.readMode === "string" ? meta.readMode : "read";
      return `${input.toolName}:${filePath}:${mode}:${offset}:${maxLines}:${stableContentKind(input.content)}`;
    }
    case "grep": {
      const pattern = stringParam(input.params, "pattern", "query");
      const context = numberParam(input.params, "contextLines", "context") ?? "";
      return `${input.toolName}:${targetPath}:${pattern}:${context}:${stableContentKind(input.content)}`;
    }
    case "list_dir": {
      const depth = numberParam(input.params, "depth") ?? Number(meta.depth ?? 0);
      return `${input.toolName}:${directoryPath}:${depth}:${stableContentKind(input.content)}`;
    }
    case "find_test_files": {
      return `${input.toolName}:${filePath}:${stableContentKind(input.content)}`;
    }
    case "query_shared_memory":
    case "query_workflow_graph": {
      const query = stringParam(input.params, "query", "pattern");
      return `${input.toolName}:${query}:${stableContentKind(input.content)}`;
    }
    case "inspect_workspace_environment": {
      const cwd = stringParam(input.params, "cwd") || String(meta.cwd ?? ".");
      return `${input.toolName}:${cwd}:${JSON.stringify(input.params ?? {})}:${stableContentKind(input.content)}`;
    }
    default:
      return `${input.toolName}:${JSON.stringify(input.params ?? {})}:${stableContentKind(input.content)}`;
  }
}

export function isProductiveToolResult(input: {
  role?: SubagentRoleId | null;
  toolName: string;
  success: boolean;
  params?: Record<string, unknown>;
  content?: string;
  meta?: Readonly<Record<string, unknown>>;
  observedEvidenceKeys?: Set<string>;
}): boolean {
  if (!input.success) {
    return false;
  }
  if (PRODUCTIVE_PROGRESS_TOOLS.has(input.toolName)) {
    return true;
  }
  const role = input.role ?? "main";
  if (!READ_ONLY_PROGRESS_ROLES.has(role) || !EVIDENCE_PROGRESS_TOOLS.has(input.toolName)) {
    return false;
  }
  const evidenceKey = evidenceKeyForTool(input);
  if (input.observedEvidenceKeys?.has(evidenceKey)) {
    return false;
  }
  input.observedEvidenceKeys?.add(evidenceKey);
  return true;
}

export function getToolRoundExtensionStep(config: Pick<GalaxyConfig, "activeSubagentRole">): number {
  return ROLE_EXTENSION_STEP[config.activeSubagentRole ?? "main"];
}

export function getToolRoundStallLimit(config: Pick<GalaxyConfig, "activeSubagentRole">): number {
  return ROLE_STALL_LIMIT[config.activeSubagentRole ?? "main"];
}
