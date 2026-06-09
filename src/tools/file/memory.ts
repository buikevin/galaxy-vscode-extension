/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-09
 * @modify date 2026-05-09
 * @desc Shared memory and workflow-graph tools for role-aware sub-agent orchestration.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getProjectStorageInfo } from "../../context/project-store";
import { buildWorkflowRetrievalBlock } from "../../context/prompt/retrieval-helpers";
import type {
  TaskMemoryEntrySummary,
  TaskMemoryFindingSummary,
} from "../../context/entities/rag-metadata";
import {
  appendTaskMemoryEntry,
  queryRelevantTaskMemory,
  queryRelevantTaskMemoryLexical,
  replaceTaskMemoryFindings,
} from "../../context/rag-metadata/task-memory";
import {
  getAllowedMemoryTurnKinds,
  getSubagentRoleDefinition,
  isSubagentRoleId,
  TASK_MEMORY_TURN_KINDS,
} from "../../shared/subagents";
import type {
  SubagentHandoffStatus,
  SubagentRoleId,
  TaskMemoryTurnKind,
} from "../../shared/runtime";
import type { ToolResult } from "../entities/file-tools";

type WorkspaceEvidenceStatus = "fresh" | "stale" | "missing" | "no_files";

type WorkspaceEvidence = Readonly<{
  status: WorkspaceEvidenceStatus;
  warnings: readonly string[];
  staleFiles: readonly string[];
  missingFiles: readonly string[];
}>;

export type QuerySharedMemoryRequest = Readonly<{
  query: string;
  role?: string | undefined;
  fallbackRole?: SubagentRoleId | undefined;
  limit?: number | undefined;
  turnKinds?: readonly unknown[] | undefined;
}>;

export type WriteAgentHandoffRequest = Readonly<{
  role?: string | undefined;
  fallbackRole?: SubagentRoleId | undefined;
  summary: string;
  status?: string | undefined;
  nextRole?: string | undefined;
  files?: readonly unknown[] | undefined;
  planId?: string | undefined;
}>;

export type QueryWorkflowGraphRequest = Readonly<{
  query: string;
}>;

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function uniqueStrings(values: readonly unknown[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))],
  );
}

function isTaskMemoryTurnKind(value: unknown): value is TaskMemoryTurnKind {
  return typeof value === "string" && (TASK_MEMORY_TURN_KINDS as readonly string[]).includes(value);
}

function normalizeRole(value: unknown, fallbackRole: SubagentRoleId = "main"): SubagentRoleId {
  return isSubagentRoleId(value) ? value : fallbackRole;
}

function normalizeStatus(value: unknown): SubagentHandoffStatus {
  return value === "failed" || value === "needs_user_input" || value === "completed"
    ? value
    : "completed";
}

function resolveWorkspaceFile(workspacePath: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspacePath, filePath);
}

function inspectWorkspaceEvidence(
  workspacePath: string,
  files: readonly string[],
  capturedAt?: number,
): WorkspaceEvidence {
  if (files.length === 0) {
    return Object.freeze({
      status: "no_files",
      warnings: Object.freeze([]),
      staleFiles: Object.freeze([]),
      missingFiles: Object.freeze([]),
    });
  }

  const warnings: string[] = [];
  const staleFiles: string[] = [];
  const missingFiles: string[] = [];

  files.slice(0, 12).forEach((filePath) => {
    const resolved = resolveWorkspaceFile(workspacePath, filePath);
    if (!fs.existsSync(resolved)) {
      missingFiles.push(filePath);
      warnings.push(`MISSING: ${filePath} no longer exists in the workspace.`);
      return;
    }
    if (typeof capturedAt === "number") {
      const mtimeMs = fs.statSync(resolved).mtimeMs;
      if (mtimeMs > capturedAt + 1000) {
        staleFiles.push(filePath);
        warnings.push(
          `STALE: ${filePath} was modified after this memory was captured (${new Date(mtimeMs).toISOString()} > ${new Date(capturedAt).toISOString()}).`,
        );
      }
    }
  });

  return Object.freeze({
    status: staleFiles.length > 0 ? "stale" : missingFiles.length > 0 ? "missing" : "fresh",
    warnings: Object.freeze(warnings),
    staleFiles: Object.freeze(staleFiles),
    missingFiles: Object.freeze(missingFiles),
  });
}

function getReadableTurnKinds(
  role: SubagentRoleId,
  requestedTurnKinds: readonly unknown[] | undefined,
): readonly TaskMemoryTurnKind[] {
  const roleKinds = getAllowedMemoryTurnKinds(role);
  const requestedKinds = uniqueStrings(requestedTurnKinds ?? []).filter(isTaskMemoryTurnKind);
  if (requestedKinds.length === 0) {
    return roleKinds;
  }
  return Object.freeze(roleKinds.filter((kind) => requestedKinds.includes(kind)));
}

function formatFindings(findings: readonly TaskMemoryFindingSummary[]): readonly string[] {
  if (findings.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze([
    "Findings:",
    ...findings.slice(0, 5).map((finding) => {
      const location = finding.filePath
        ? ` @ ${finding.filePath}${typeof finding.line === "number" ? `:${finding.line}` : ""}`
        : "";
      return `- [${finding.kind}/${finding.status}] ${finding.summary}${location}`;
    }),
  ]);
}

function formatMemoryEntry(
  workspacePath: string,
  entry: TaskMemoryEntrySummary,
  findings: readonly TaskMemoryFindingSummary[],
  index: number,
): Readonly<{ lines: readonly string[]; evidence: WorkspaceEvidence }> {
  const evidence = inspectWorkspaceEvidence(workspacePath, entry.files, entry.createdAt);
  const freshnessLines =
    evidence.warnings.length > 0
      ? ["Workspace evidence:", ...evidence.warnings.map((warning) => `- ${warning}`)]
      : [`Workspace evidence: ${evidence.status}`];
  const fileLines =
    entry.files.length > 0
      ? [`Files: ${entry.files.slice(0, 8).join(", ")}`]
      : ["Files: none recorded"];
  return Object.freeze({
    evidence,
    lines: Object.freeze([
      `${index + 1}. [${entry.turnKind}] ${new Date(entry.createdAt).toISOString()} confidence=${entry.confidence.toFixed(2)} freshness=${entry.freshnessScore.toFixed(2)} evidence=${evidence.status}`,
      `Intent: ${entry.userIntent}`,
      `Conclusion: ${entry.assistantConclusion}`,
      ...fileLines,
      ...freshnessLines,
      ...formatFindings(findings),
    ]),
  });
}

async function queryMemoryWithFallback(
  workspacePath: string,
  query: string,
  limit: number,
): Promise<Readonly<{
  entries: readonly TaskMemoryEntrySummary[];
  findings: readonly TaskMemoryFindingSummary[];
  retrievalMode: "hybrid" | "lexical";
}>> {
  try {
    const result = await queryRelevantTaskMemory(workspacePath, query, limit);
    return Object.freeze({ ...result, retrievalMode: "hybrid" as const });
  } catch {
    const result = queryRelevantTaskMemoryLexical(workspacePath, query, limit);
    return Object.freeze({ ...result, retrievalMode: "lexical" as const });
  }
}

export async function querySharedMemoryTool(
  workspacePath: string,
  request: QuerySharedMemoryRequest,
): Promise<ToolResult> {
  const query = request.query.trim();
  if (!query) {
    return Object.freeze({
      success: false,
      content: "",
      error: "query_shared_memory requires a non-empty query.",
    });
  }

  const role = normalizeRole(request.role, request.fallbackRole ?? "main");
  const roleDefinition = getSubagentRoleDefinition(role);
  const limit = normalizeLimit(request.limit, 4, 12);
  const readableTurnKinds = getReadableTurnKinds(role, request.turnKinds);
  if (readableTurnKinds.length === 0) {
    return Object.freeze({
      success: true,
      content: [
        "[SHARED MEMORY]",
        `Role: ${roleDefinition.title} (${role})`,
        "No readable turn kinds matched the requested filter.",
      ].join("\n"),
      meta: Object.freeze({ role, readableTurnKinds }),
    });
  }

  const retrieval = await queryMemoryWithFallback(workspacePath, query, Math.max(limit * 4, 16));
  const entries = retrieval.entries
    .filter((entry) => readableTurnKinds.includes(entry.turnKind as TaskMemoryTurnKind))
    .slice(0, limit);
  const entryIds = new Set(entries.map((entry) => entry.turnId));
  const findings = retrieval.findings.filter((finding) => entryIds.has(finding.entryTurnId));

  if (entries.length === 0) {
    return Object.freeze({
      success: true,
      content: [
        "[SHARED MEMORY]",
        `Role: ${roleDefinition.title} (${role})`,
        `Query: ${query}`,
        `Readable memory kinds: ${readableTurnKinds.join(", ")}`,
        "No relevant shared-memory entries found for this role/profile.",
      ].join("\n"),
      meta: Object.freeze({
        role,
        readableTurnKinds,
        retrievalMode: retrieval.retrievalMode,
        entryCount: 0,
      }),
    });
  }

  const formattedEntries = entries.map((entry, index) =>
    formatMemoryEntry(
      workspacePath,
      entry,
      findings.filter((finding) => finding.entryTurnId === entry.turnId),
      index,
    ),
  );
  const staleCount = formattedEntries.filter((entry) => entry.evidence.status === "stale").length;
  const missingCount = formattedEntries.filter((entry) => entry.evidence.status === "missing").length;
  const content = [
    "[SHARED MEMORY]",
    `Role: ${roleDefinition.title} (${role})`,
    `Query: ${query}`,
    `Retrieval: ${retrieval.retrievalMode}`,
    `Readable memory kinds: ${readableTurnKinds.join(", ")}`,
    "Policy: Memory is advisory. When stale/missing/conflicting, verify current workspace evidence before acting.",
    "",
    ...formattedEntries.flatMap((entry) => [...entry.lines, ""]),
  ].join("\n").trim();

  return Object.freeze({
    success: true,
    content,
    meta: Object.freeze({
      role,
      readableTurnKinds,
      retrievalMode: retrieval.retrievalMode,
      entryCount: entries.length,
      findingCount: findings.length,
      staleCount,
      missingCount,
    }),
  });
}

export function writeAgentHandoffTool(
  workspacePath: string,
  request: WriteAgentHandoffRequest,
): ToolResult {
  const summary = request.summary.trim();
  if (!summary) {
    return Object.freeze({
      success: false,
      content: "",
      error: "write_agent_handoff requires a non-empty summary.",
    });
  }

  const role = normalizeRole(request.role, request.fallbackRole ?? "main");
  const nextRole = isSubagentRoleId(request.nextRole) ? request.nextRole : undefined;
  const status = normalizeStatus(request.status);
  const files = uniqueStrings(request.files ?? []);
  const now = Date.now();
  const roleDefinition = getSubagentRoleDefinition(role);
  const planId = request.planId?.trim() || "manual-handoff";
  const turnId = `${planId}-${role}-${now}-${randomUUID().slice(0, 8)}`;
  const conclusion = [
    "[SUBAGENT HANDOFF]",
    `Plan: ${planId}`,
    `Role: ${roleDefinition.title} (${role})`,
    `Status: ${status}`,
    nextRole ? `Next role: ${nextRole}` : "Next role: none",
    files.length > 0 ? `Files: ${files.join(", ")}` : "Files: none",
    "",
    summary,
  ].join("\n");

  appendTaskMemoryEntry(workspacePath, {
    workspaceId: getProjectStorageInfo(workspacePath).workspaceId,
    turnId,
    turnKind: "subagent_handoff",
    userIntent: `${roleDefinition.title} handoff${nextRole ? ` to ${nextRole}` : ""}`,
    assistantConclusion: conclusion,
    filesJson: JSON.stringify(files),
    attachmentsJson: JSON.stringify([]),
    confidence: status === "completed" ? 0.9 : 0.72,
    freshnessScore: 1,
    createdAt: now,
  });

  replaceTaskMemoryFindings(workspacePath, turnId, [
    {
      id: `${turnId}-finding`,
      entryTurnId: turnId,
      kind: "handoff",
      summary,
      ...(files[0] ? { filePath: files[0] } : {}),
      status: nextRole || status !== "completed" ? "open" : "resolved",
      createdAt: now,
    },
  ]);

  return Object.freeze({
    success: true,
    content: [
      "[WRITE_AGENT_HANDOFF]",
      `Saved shared handoff ${turnId}.`,
      `Role: ${roleDefinition.title} (${role})`,
      `Status: ${status}`,
      nextRole ? `Next role: ${nextRole}` : "Next role: none",
      files.length > 0 ? `Files: ${files.join(", ")}` : "Files: none",
    ].join("\n"),
    meta: Object.freeze({
      turnId,
      role,
      status,
      nextRole: nextRole ?? null,
      files,
    }),
  });
}

export async function queryWorkflowGraphTool(
  workspacePath: string,
  request: QueryWorkflowGraphRequest,
): Promise<ToolResult> {
  const query = request.query.trim();
  if (!query) {
    return Object.freeze({
      success: false,
      content: "",
      error: "query_workflow_graph requires a non-empty query.",
    });
  }

  const block = await buildWorkflowRetrievalBlock({
    workspacePath,
    queryText: query,
    workingTurnFiles: Object.freeze([]),
    mentionedPaths: Object.freeze([]),
  });
  const evidence = inspectWorkspaceEvidence(workspacePath, block.candidatePaths);
  const warningLines =
    evidence.warnings.length > 0
      ? ["[WORKSPACE EVIDENCE WARNINGS]", ...evidence.warnings.map((warning) => `- ${warning}`), ""]
      : [];
  const graphContent = block.content.trim() || "No workflow graph matches found for this query.";

  return Object.freeze({
    success: true,
    content: [
      "[WORKFLOW GRAPH QUERY]",
      `Query: ${query}`,
      "",
      graphContent,
      "",
      ...warningLines,
      "[EVIDENCE POLICY]",
      "- GraphRAG is shared project memory, not source of truth.",
      "- Verify exact source files with read_file/grep before editing when graph evidence is stale, missing, ambiguous, or line-level precision matters.",
    ].join("\n").trim(),
    meta: Object.freeze({
      flowQuery: block.flowQuery,
      candidatePaths: block.candidatePaths,
      pathScores: block.pathScores,
      entryCount: block.entryCount,
      evidenceStatus: evidence.status,
      missingFiles: evidence.missingFiles,
    }),
  });
}
