/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Validation and review quality-gate orchestration extracted from the extension host entrypoint.
 */

import path from "node:path";

import {
  appendTaskMemoryEntry,
  replaceTaskMemoryFindings,
} from "../context/rag-metadata/task-memory";
import { scheduleWorkflowGraphRefresh } from "../context/workflow/extractor/runtime";
import { formatReviewSummary, runCodeReview } from "../runtime/code-reviewer";
import { getSessionFiles } from "../runtime/session-tracker";
import { createAssistantMessage } from "./utils";
import {
  MAX_AUTO_REPAIR_ATTEMPTS,
  MAX_AUTO_REVIEW_REPAIR_ATTEMPTS,
} from "../shared/constants";
import type {
  ProjectMeta,
  ProjectStorageInfo,
} from "../context/entities/project-store";
import type { GalaxyConfig } from "../shared/config";
import type { AgentType, ChatMessage, ReviewFinding } from "../shared/protocol";
import type {
  ProviderQualityGateBindings,
  QualityGateCallbacks,
  RunQualityGatesParams,
} from "../shared/quality-gates";
import type { RuntimeReviewResult } from "../shared/runtime";
import type { FinalValidationResult } from "../shared/validation";
import type {
  RepairTurnRequest,
  RepairTurnResult,
} from "../shared/extension-host";
import { runFinalValidation } from "../validation/project-validator";
import { formatValidationSummary } from "../validation/summary";

const DOC_ONLY_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
]);

/** Returns whether one tracked file should be treated as documentation-only for quality gating. */
export function isDocumentationOnlyTrackedFile(filePath: string): boolean {
  return DOC_ONLY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Returns whether the whole session changed only documentation files. */
export function isDocumentationOnlySessionFiles(
  sessionFiles: readonly { filePath: string }[],
): boolean {
  return (
    sessionFiles.length > 0 &&
    sessionFiles.every((file) => isDocumentationOnlyTrackedFile(file.filePath))
  );
}

/** Build the structured validation feedback prompt for an auto-repair turn. */
export function buildStructuredValidationRepairPrompt(
  result: FinalValidationResult,
): string {
  const issueLines = result.runs
    .flatMap((run) =>
      run.issues.map((issue) => {
        const location = [
          issue.filePath ?? "",
          typeof issue.line === "number" ? `:${issue.line}` : "",
          typeof issue.column === "number" ? `:${issue.column}` : "",
        ].join("");
        return `- [${issue.severity.toUpperCase()}] ${location || run.command}: ${issue.message}`;
      }),
    )
    .slice(0, 20);

  const lines = [
    "Final validation failed.",
    "Fix the reported issues with the smallest safe changes possible.",
    "Prioritize compiler, type, and syntax errors first.",
    "",
    ...issueLines,
  ];

  if (issueLines.length === 0) {
    lines.push(result.summary);
  }

  return lines.join("\n").trim();
}

/** Build the user message that asks the agent to repair validation failures. */
export function buildValidationRepairMessage(
  result: FinalValidationResult,
  attempt: number,
): ChatMessage {
  return Object.freeze({
    id: `validation-repair-${Date.now()}-${attempt}`,
    role: "user",
    content:
      "[SYSTEM VALIDATION FEEDBACK]\n" +
      "Final validation failed after the previous implementation attempt.\n\n" +
      "You must fix the reported issues with the smallest safe code changes possible.\n" +
      "Do not restart the task. Continue from the current workspace state.\n\n" +
      buildStructuredValidationRepairPrompt(result),
    timestamp: Date.now(),
  });
}
/** Build the structured review feedback prompt for an auto-repair turn. */
export function buildStructuredReviewRepairPrompt(
  review: RuntimeReviewResult,
): string {
  const lines = review.findings
    .filter(
      (finding) =>
        finding.severity === "critical" || finding.severity === "warning",
    )
    .slice(0, 20)
    .map(
      (finding) =>
        `- [${finding.severity.toUpperCase()}] ${finding.location}: ${finding.message}`,
    );

  if (lines.length === 0) {
    lines.push(review.review.trim());
  }

  return [
    "Code review found issues that should be fixed before finishing.",
    "Treat review findings as advisory, not ground truth.",
    "Prioritize critical issues first, then warnings that affect correctness or maintainability.",
    "Before editing, verify each finding against the current workspace state.",
    "If a finding is stale, already fixed, or incorrect after user edits/reverts, do not change code for it.",
    "Make the smallest safe changes needed.",
    "",
    ...lines,
  ]
    .join("\n")
    .trim();
}

/** Build the user message that asks the agent to repair review findings. */
export function buildReviewRepairMessage(
  review: RuntimeReviewResult,
  attempt: number,
): ChatMessage {
  return Object.freeze({
    id: `review-repair-${Date.now()}-${attempt}`,
    role: "user",
    content:
      "[SYSTEM CODE REVIEW FEEDBACK]\n" +
      "The reviewer found issues after the last implementation attempt.\n\n" +
      "Fix the reported issues with the smallest safe changes possible.\n" +
      "Verify each finding against the current files before editing.\n" +
      "Do not blindly trust stale or incorrect review findings.\n" +
      "Do not restart the task. Continue from the current workspace state.\n\n" +
      buildStructuredReviewRepairPrompt(review),
    timestamp: Date.now(),
  });
}

/** Builds quality-gate params directly from provider-owned bindings. */
export function buildProviderQualityGateParams(
  bindings: ProviderQualityGateBindings,
): RunQualityGatesParams {
  return {
    workspacePath: bindings.workspacePath,
    projectStorage: bindings.projectStorage,
    agentType: bindings.agentType,
    callbacks: {
      getEffectiveConfig: bindings.getEffectiveConfig,
      updateStatus: async (statusText) => {
        bindings.setStatusText(statusText);
        bindings.reportProgress(statusText);
        await bindings.postRunState();
      },
      appendLog: bindings.appendLog,
      updateQualityDetails: bindings.updateQualityDetails,
      persistProjectMetaPatch: bindings.persistProjectMetaPatch,
      addMessage: bindings.addMessage,
      runInternalRepairTurn: bindings.runInternalRepairTurn,
      emitCommandStreamStart: bindings.emitCommandStreamStart,
      emitCommandStreamChunk: bindings.emitCommandStreamChunk,
      emitCommandStreamEnd: bindings.emitCommandStreamEnd,
    },
  };
}

/** Runs the validation and review flow from provider-owned bindings. */
export async function runProviderValidationAndReviewFlow(
  bindings: ProviderQualityGateBindings,
): Promise<Readonly<{ passed: boolean; repaired: boolean }>> {
  return runValidationAndReviewFlow(buildProviderQualityGateParams(bindings));
}
/** Run the blocking review and validation quality gate for the current session files. */
export async function runValidationAndReviewFlow(
  params: RunQualityGatesParams,
): Promise<Readonly<{ passed: boolean; repaired: boolean }>> {
  const initialConfig = params.callbacks.getEffectiveConfig();
  const shouldRunValidation = initialConfig.toolCapabilities.validation;
  const shouldRunReview = initialConfig.toolCapabilities.review;

  if (!shouldRunValidation && !shouldRunReview) {
    return Object.freeze({ passed: true, repaired: false });
  }

  let validationRepairAttempt = 0;
  let reviewRepairAttempt = 0;
  let repaired = false;

  for (;;) {
    const sessionFiles = getSessionFiles();
    if (sessionFiles.length === 0) {
      return Object.freeze({ passed: true, repaired });
    }

    if (isDocumentationOnlySessionFiles(sessionFiles)) {
      params.callbacks.appendLog(
        "info",
        "Skipping blocking review and validation because the current turn changed documentation files only.",
      );
      return Object.freeze({ passed: true, repaired });
    }

    if (shouldRunReview) {
      await params.callbacks.updateStatus("Running review quality gate");
      params.callbacks.appendLog(
        "review",
        "Running blocking review quality gate...",
      );
      const reviewResult = await runCodeReview({
        sessionFiles,
        config: params.callbacks.getEffectiveConfig(),
        agentType: params.agentType,
      });

      if (!reviewResult) {
        params.callbacks.appendLog(
          "review",
          "Code reviewer returned no review result. Continuing without blocking validation.",
        );
      } else if (!reviewResult.success) {
        const failureSummary =
          reviewResult.review.trim() ||
          "Code reviewer failed to complete successfully.";
        params.callbacks.appendLog(
          "review",
          "Code reviewer was unavailable for this turn. Continuing without blocking validation.",
        );
        params.callbacks.updateQualityDetails({
          reviewSummary: `Code review unavailable.\n\n${failureSummary.slice(0, 2_000)}`,
          reviewFindings: Object.freeze([]),
        });
      } else {
        const structuredFindings = Object.freeze(
          reviewResult.findings.map((finding, index) =>
            Object.freeze({
              id: `review-${Date.now()}-${index + 1}`,
              severity: finding.severity,
              location: finding.location,
              message: finding.message,
              status: "open" as const,
            }),
          ),
        );
        params.callbacks.updateQualityDetails({
          reviewSummary: formatReviewSummary(reviewResult),
          reviewFindings: structuredFindings,
        });
        params.callbacks.persistProjectMetaPatch((previousMeta) =>
          previousMeta
            ? {
                ...previousMeta,
                latestReviewFindings: Object.freeze({
                  capturedAt: Date.now(),
                  summary: reviewResult.hadCritical
                    ? "Critical review findings available."
                    : reviewResult.hadWarnings
                      ? "Review warnings available."
                      : "Review completed with no actionable findings.",
                  findings: structuredFindings,
                }),
              }
            : null,
        );
        persistReviewFindingsToTaskMemory(
          params.workspacePath,
          params.projectStorage,
          sessionFiles.map((file) => file.filePath),
          reviewResult,
          structuredFindings,
        );
        params.callbacks.appendLog(
          "review",
          !reviewResult.hadCritical && !reviewResult.hadWarnings
            ? "Code review completed with no actionable findings."
            : "Code review produced actionable findings.",
        );

        if (reviewResult.hadCritical || reviewResult.hadWarnings) {
          if (reviewRepairAttempt >= MAX_AUTO_REVIEW_REPAIR_ATTEMPTS) {
            return Object.freeze({ passed: false, repaired });
          }

          reviewRepairAttempt += 1;
          repaired = true;
          await params.callbacks.addMessage(
            createAssistantMessage(
              `Attempting automatic repair from code review findings (${reviewRepairAttempt}/${MAX_AUTO_REVIEW_REPAIR_ATTEMPTS})...`,
            ),
          );

          const repairResult = await params.callbacks.runInternalRepairTurn({
            config: params.callbacks.getEffectiveConfig(),
            agentType: params.agentType,
            userMessage: buildReviewRepairMessage(
              reviewResult,
              reviewRepairAttempt,
            ),
            showUserMessageInTranscript: false,
          });

          if (repairResult.hadError || repairResult.filesWritten.length === 0) {
            return Object.freeze({ passed: false, repaired });
          }

          continue;
        }
      }
    }

    if (!shouldRunValidation) {
      return Object.freeze({ passed: true, repaired });
    }

    params.callbacks.appendLog(
      "validation",
      `Running blocking validation quality gate for ${sessionFiles.length} changed files.`,
    );
    await params.callbacks.updateStatus("Running validation quality gate");
    const validationResult = await runFinalValidation({
      workspacePath: params.workspacePath,
      sessionFiles,
      config: params.callbacks.getEffectiveConfig(),
      streamCallbacks: {
        onStart: async (payload) =>
          params.callbacks.emitCommandStreamStart(payload),
        onChunk: async (payload) =>
          params.callbacks.emitCommandStreamChunk(payload),
        onEnd: async (payload) =>
          params.callbacks.emitCommandStreamEnd(payload),
      },
    });
    scheduleWorkflowGraphRefresh(params.workspacePath, {
      reason: "validation",
      filePaths: sessionFiles.map((file) => file.filePath),
      delayMs: 250,
    });
    params.callbacks.appendLog("validation", validationResult.selectionSummary);
    params.callbacks.updateQualityDetails({
      validationSummary: formatValidationSummary(validationResult),
    });

    const latestFailedRun =
      validationResult.runs.find(
        (run) => !run.success && run.category === "test",
      ) ?? validationResult.runs.find((run) => !run.success);
    params.callbacks.persistProjectMetaPatch((previousMeta) =>
      previousMeta
        ? {
            ...previousMeta,
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
              : { latestTestFailure: undefined }),
          }
        : null,
    );
    if (latestFailedRun) {
      persistValidationFindingsToTaskMemory(
        params.workspacePath,
        params.projectStorage,
        sessionFiles.map((file) => file.filePath),
        latestFailedRun,
      );
    }
    params.callbacks.appendLog(
      "validation",
      validationResult.success
        ? "Final validation passed."
        : "Final validation failed.",
    );

    if (validationResult.success) {
      return Object.freeze({ passed: true, repaired });
    }

    if (validationRepairAttempt >= MAX_AUTO_REPAIR_ATTEMPTS) {
      return Object.freeze({ passed: false, repaired });
    }

    validationRepairAttempt += 1;
    repaired = true;
    await params.callbacks.addMessage(
      createAssistantMessage(
        `Attempting automatic repair from final validation errors (${validationRepairAttempt}/${MAX_AUTO_REPAIR_ATTEMPTS})...`,
      ),
    );

    const repairResult = await params.callbacks.runInternalRepairTurn({
      config: params.callbacks.getEffectiveConfig(),
      agentType: params.agentType,
      userMessage: buildValidationRepairMessage(
        validationResult,
        validationRepairAttempt,
      ),
      showUserMessageInTranscript: false,
    });

    if (repairResult.hadError || repairResult.filesWritten.length === 0) {
      return Object.freeze({ passed: false, repaired });
    }
  }
}
function persistReviewFindingsToTaskMemory(
  workspacePath: string,
  projectStorage: ProjectStorageInfo,
  sessionFilePaths: readonly string[],
  reviewResult: RuntimeReviewResult,
  structuredFindings: readonly ReviewFinding[],
): void {
  const reviewEntryTurnId = `review-${Date.now()}`;
  appendTaskMemoryEntry(workspacePath, {
    workspaceId: projectStorage.workspaceId,
    turnId: reviewEntryTurnId,
    turnKind: "review",
    userIntent: "Code review findings after implementation.",
    assistantConclusion: reviewResult.review.slice(0, 2_400),
    filesJson: JSON.stringify(sessionFilePaths),
    confidence: 0.9,
    freshnessScore: 1,
    createdAt: Date.now(),
  });
  replaceTaskMemoryFindings(
    workspacePath,
    reviewEntryTurnId,
    structuredFindings.map((finding) =>
      Object.freeze({
        id: finding.id,
        entryTurnId: reviewEntryTurnId,
        kind: "review_finding" as const,
        summary: `${finding.location}: ${finding.message}`,
        status: finding.status ?? "open",
        createdAt: Date.now(),
      }),
    ),
  );
}
function persistValidationFindingsToTaskMemory(
  workspacePath: string,
  projectStorage: ProjectStorageInfo,
  sessionFilePaths: readonly string[],
  latestFailedRun: FinalValidationResult["runs"][number],
): void {
  const validationEntryTurnId = `validation-${Date.now()}`;
  appendTaskMemoryEntry(workspacePath, {
    workspaceId: projectStorage.workspaceId,
    turnId: validationEntryTurnId,
    turnKind: "validation",
    userIntent: "Final validation result for changed files.",
    assistantConclusion: latestFailedRun.summary.slice(0, 2_400),
    filesJson: JSON.stringify(sessionFilePaths),
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
