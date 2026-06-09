/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-09
 * @modify date 2026-05-09
 * @desc Project-level quality tools for validation and review-agent change summaries.
 */

import fs from "node:fs";
import path from "node:path";
import { getProjectStorageInfo, loadProjectMeta, saveProjectMeta } from "../../context/project-store";
import {
  appendTaskMemoryEntry,
  replaceTaskMemoryFindings,
} from "../../context/rag-metadata/task-memory";
import {
  detectLanguage,
  getSessionChangeSummary,
  getSessionFiles,
} from "../../runtime/session-tracker";
import type { GalaxyConfig } from "../../shared/config";
import type { TrackedFile } from "../../shared/runtime";
import type { FinalValidationResult } from "../../shared/validation";
import { runFinalValidation } from "../../validation/project-validator";
import { formatValidationSummary } from "../../validation/summary";
import type { ToolResult } from "../entities/file-tools";

export type RunValidationSuiteRequest = Readonly<{
  paths?: readonly unknown[] | undefined;
}>;

function uniqueStrings(values: readonly unknown[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))],
  );
}

function buildValidationFiles(workspacePath: string, rawPaths: readonly unknown[] | undefined): readonly TrackedFile[] {
  const paths = uniqueStrings(rawPaths ?? []);
  if (paths.length === 0) {
    return getSessionFiles();
  }

  return Object.freeze(
    paths
      .map((filePath) => path.resolve(workspacePath, filePath))
      .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
      .map((filePath) =>
        Object.freeze({
          filePath,
          language: detectLanguage(filePath),
          modifiedAt: Date.now(),
          wasNew: false,
        }),
      ),
  );
}

function persistLatestValidationFailure(
  workspacePath: string,
  sessionFiles: readonly TrackedFile[],
  result: FinalValidationResult,
): void {
  const latestFailedRun =
    result.runs.find((run) => !run.success && run.category === "test") ??
    result.runs.find((run) => !run.success);
  const storage = getProjectStorageInfo(workspacePath);
  const previous = loadProjectMeta(storage);
  saveProjectMeta(storage, Object.freeze({
    ...(previous ?? {
      workspaceId: storage.workspaceId,
      workspaceName: storage.workspaceName,
      workspacePath: storage.workspacePath,
      projectDirName: storage.projectDirName,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      storageVersion: 1,
    }),
    ...(latestFailedRun
      ? {
          latestTestFailure: Object.freeze({
            capturedAt: Date.now(),
            summary: latestFailedRun.summary,
            command: latestFailedRun.command,
            profile: latestFailedRun.profile,
            category: latestFailedRun.category,
            issues: latestFailedRun.issues,
          }),
        }
      : {}),
  }));

  if (!latestFailedRun) {
    return;
  }

  const validationEntryTurnId = `validation-${Date.now()}`;
  appendTaskMemoryEntry(workspacePath, {
    workspaceId: storage.workspaceId,
    turnId: validationEntryTurnId,
    turnKind: "validation",
    userIntent: "Validation suite result for changed files.",
    assistantConclusion: latestFailedRun.summary.slice(0, 2_400),
    filesJson: JSON.stringify(sessionFiles.map((file) => file.filePath)),
    confidence: 0.95,
    freshnessScore: 1,
    createdAt: Date.now(),
  });
  replaceTaskMemoryFindings(
    workspacePath,
    validationEntryTurnId,
    latestFailedRun.issues.length > 0
      ? latestFailedRun.issues.map((issue, index) =>
          Object.freeze({
            id: `validation-${validationEntryTurnId}-${index + 1}`,
            entryTurnId: validationEntryTurnId,
            kind: "validation_failure" as const,
            summary: issue.message,
            ...(issue.filePath ? { filePath: issue.filePath } : {}),
            ...(typeof issue.line === "number" ? { line: issue.line } : {}),
            status: "open" as const,
            createdAt: Date.now(),
          }),
        )
      : [
          Object.freeze({
            id: `validation-${validationEntryTurnId}-summary`,
            entryTurnId: validationEntryTurnId,
            kind: "validation_failure" as const,
            summary: latestFailedRun.summary,
            status: "open" as const,
            createdAt: Date.now(),
          }),
        ],
  );
}

export async function runValidationSuiteTool(
  workspacePath: string,
  config: Pick<GalaxyConfig, "validation">,
  request: RunValidationSuiteRequest,
): Promise<ToolResult> {
  const sessionFiles = buildValidationFiles(workspacePath, request.paths);
  const result = await runFinalValidation({
    workspacePath,
    sessionFiles,
    config,
  });
  persistLatestValidationFailure(workspacePath, sessionFiles, result);

  return Object.freeze({
    success: result.success,
    content: [
      "[VALIDATION SUITE]",
      result.selectionSummary,
      "",
      formatValidationSummary(result),
    ].join("\n").trim(),
    ...(result.success ? {} : { error: result.summary }),
    meta: Object.freeze({
      mode: result.mode,
      runCount: result.runs.length,
      success: result.success,
      failedRuns: result.runs.filter((run) => !run.success).length,
      files: sessionFiles.map((file) => file.filePath),
    }),
  });
}

export function getChangeSummaryTool(workspacePath: string): ToolResult {
  const summary = getSessionChangeSummary();
  if (summary.fileCount === 0) {
    return Object.freeze({
      success: false,
      content: "",
      error: "No files have been changed in this session.",
    });
  }

  const fileLines = summary.files.map((file, index) => {
    const rel = path.relative(workspacePath, file.filePath) || file.filePath;
    const diffPreview = file.diffText.trim().slice(0, 1_600);
    return [
      `${index + 1}. ${rel} (${file.language}) ${file.wasNew ? "new" : "modified"} +${file.addedLines}/-${file.deletedLines}`,
      diffPreview ? "```diff" : "",
      diffPreview,
      diffPreview ? "```" : "",
    ].filter(Boolean).join("\n");
  });

  return Object.freeze({
    success: true,
    content: [
      "[CHANGE SUMMARY]",
      `Files changed: ${summary.fileCount}`,
      `Created: ${summary.createdCount}`,
      `Lines: +${summary.addedLines}/-${summary.deletedLines}`,
      "",
      ...fileLines,
    ].join("\n\n").trim(),
    meta: Object.freeze({
      fileCount: summary.fileCount,
      createdCount: summary.createdCount,
      addedLines: summary.addedLines,
      deletedLines: summary.deletedLines,
      files: summary.files.map((file) => file.filePath),
    }),
  });
}
