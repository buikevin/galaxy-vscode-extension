/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Review-finding and latest test-failure helpers extracted from the extension host entrypoint.
 */

import { loadProjectMeta } from "../context/project-store";
import { updateTaskMemoryFindingStatus } from "../context/rag-metadata/task-memory";
import type { ProjectStorageInfo } from "../context/entities/project-store";
import type { ChatMessage } from "../shared/protocol";
import type {
  RepairTurnRequest,
  RepairTurnResult,
  ReviewFindingCallbacks,
} from "../shared/extension-host";
import type { ToolResult } from "../tools/entities/file-tools";

/** Returns the latest persisted test failure summary for this workspace. */
export async function getLatestTestFailureTool(
  projectStorage: ProjectStorageInfo,
): Promise<ToolResult> {
  const meta = loadProjectMeta(projectStorage);
  const latest = meta?.latestTestFailure;
  if (!latest) {
    return Object.freeze({
      success: false,
      content: "",
      error: "No latest test failure is stored for this workspace.",
    });
  }

  const lines = [
    `Latest test failure: ${latest.summary}`,
    `Command: ${latest.command}`,
    `Profile: ${latest.profile} / ${latest.category}`,
    "",
    ...latest.issues.slice(0, 20).map((issue) => {
      const location = [
        issue.filePath ?? "",
        typeof issue.line === "number" ? `:${issue.line}` : "",
        typeof issue.column === "number" ? `:${issue.column}` : "",
      ].join("");
      return `- [${issue.severity.toUpperCase()}] ${location || issue.source}: ${issue.message}`;
    }),
  ];

  return Object.freeze({
    success: true,
    content: lines.join("\n").trim(),
    meta: Object.freeze({
      capturedAt: latest.capturedAt,
      issuesCount: latest.issues.length,
    }),
  });
}

/** Returns the latest persisted review findings block for this workspace. */
export async function getLatestReviewFindingsTool(
  projectStorage: ProjectStorageInfo,
): Promise<ToolResult> {
  const meta = loadProjectMeta(projectStorage);
  const latest = meta?.latestReviewFindings;
  if (!latest) {
    return Object.freeze({
      success: false,
      content: "",
      error: "No latest review findings are stored for this workspace.",
    });
  }

  const lines = [
    `Latest review findings: ${latest.summary}`,
    "",
    ...latest.findings
      .slice(0, 20)
      .map(
        (finding) =>
          `- [${finding.severity.toUpperCase()}] (${finding.id}) [${finding.status ?? "open"}] ${finding.location}: ${finding.message}`,
      ),
  ];

  return Object.freeze({
    success: true,
    content: lines.join("\n").trim(),
    meta: Object.freeze({
      capturedAt: latest.capturedAt,
      findingsCount: latest.findings.length,
    }),
  });
}

/** Returns the next non-dismissed persisted review finding for this workspace. */
export async function getNextReviewFindingTool(
  projectStorage: ProjectStorageInfo,
): Promise<ToolResult> {
  const meta = loadProjectMeta(projectStorage);
  const latest = meta?.latestReviewFindings;
  const finding = latest?.findings.find(
    (item) => (item.status ?? "open") !== "dismissed",
  );
  if (!latest || !finding) {
    return Object.freeze({
      success: false,
      content: "",
      error: "No open review finding is stored for this workspace.",
    });
  }

  return Object.freeze({
    success: true,
    content: `Next review finding (${finding.id})\n[${finding.severity.toUpperCase()}] ${finding.location}: ${finding.message}`,
    meta: Object.freeze({
      findingId: finding.id,
      severity: finding.severity,
      location: finding.location,
    }),
  });
}

/** Dismisses one persisted review finding and syncs quality/task-memory state. */
export async function dismissReviewFindingTool(
  callbacks: Pick<
    ReviewFindingCallbacks,
    "persistProjectMetaPatch" | "updateQualityDetails" | "workspacePath"
  >,
  projectStorage: ProjectStorageInfo,
  findingId: string,
): Promise<ToolResult> {
  const trimmedId = findingId.trim();
  if (!trimmedId) {
    return Object.freeze({
      success: false,
      content: "",
      error: "finding_id is required.",
    });
  }

  const previousMeta = loadProjectMeta(projectStorage);
  const latest = previousMeta?.latestReviewFindings;
  if (!previousMeta || !latest) {
    return Object.freeze({
      success: false,
      content: "",
      error: "No latest review findings are stored for this workspace.",
    });
  }

  const nextFindings = latest.findings.map((finding) =>
    finding.id === trimmedId
      ? Object.freeze({ ...finding, status: "dismissed" as const })
      : finding,
  );
  const updated = nextFindings.find((finding) => finding.id === trimmedId);
  if (!updated) {
    return Object.freeze({
      success: false,
      content: "",
      error: `Review finding not found: ${trimmedId}`,
    });
  }

  callbacks.persistProjectMetaPatch((current) =>
    current
      ? {
          ...current,
          latestReviewFindings: Object.freeze({
            ...latest,
            findings: Object.freeze(nextFindings),
          }),
        }
      : null,
  );
  callbacks.updateQualityDetails({
    reviewFindings: Object.freeze(nextFindings),
  });
  updateTaskMemoryFindingStatus(
    callbacks.workspacePath,
    trimmedId,
    "dismissed",
  );

  return Object.freeze({
    success: true,
    content: `Dismissed review finding ${trimmedId}`,
    meta: Object.freeze({
      findingId: trimmedId,
    }),
  });
}

/** Applies one persisted review finding by running a focused repair turn. */
export async function applyReviewFinding(
  callbacks: ReviewFindingCallbacks,
  projectStorage: ProjectStorageInfo,
  findingId: string,
): Promise<void> {
  if (callbacks.isRunning()) {
    return;
  }

  const meta = loadProjectMeta(projectStorage);
  const latest = meta?.latestReviewFindings;
  const finding = latest?.findings.find(
    (item) => item.id === findingId && (item.status ?? "open") !== "dismissed",
  );
  if (!finding) {
    await callbacks.postMessage({
      type: "error",
      payload: {
        message: `Review finding not found or already dismissed: ${findingId}`,
      },
    });
    return;
  }

  const repairMessage: ChatMessage = Object.freeze({
    id: `review-finding-apply-${Date.now()}`,
    role: "user",
    content:
      "[SYSTEM REVIEW FINDING APPLY]\n" +
      "Fix exactly this review finding with the smallest safe change.\n" +
      "Verify the finding against the current workspace state before editing.\n" +
      "Do not rewrite unrelated code and do not restart the task.\n\n" +
      `Finding id: ${finding.id}\n` +
      `Severity: ${finding.severity}\n` +
      `Location: ${finding.location}\n` +
      `Message: ${finding.message}`,
    timestamp: Date.now(),
  });

  callbacks.clearStreamingBuffers();
  callbacks.setRunningState(true, "Applying review finding");
  await callbacks.postRunState();

  const agentType = callbacks.getSelectedAgent();
  const result = await callbacks.runInternalRepairTurn({
    config: callbacks.getEffectiveConfig(),
    agentType,
    userMessage: repairMessage,
    showUserMessageInTranscript: false,
  });

  callbacks.setRunningState(
    false,
    result.hadError ? "Review finding apply failed" : "Review finding applied",
  );
  await callbacks.postRunState();

  if (result.hadError) {
    return;
  }

  if (result.filesWritten.length > 0) {
    await dismissReviewFindingTool(callbacks, projectStorage, finding.id);
    await callbacks.runValidationAndReviewFlow(agentType);
  }
}
