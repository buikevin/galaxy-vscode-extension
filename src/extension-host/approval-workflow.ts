/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Tool-approval prompt orchestration extracted from the extension host entrypoint.
 */

import * as vscode from "vscode";
import type { ToolApprovalDecision } from "../shared/protocol";
import type {
  ApprovalWorkflowCallbacks,
  ToolApprovalRequest,
} from "../shared/extension-host";
import type { ApprovalRequestPayload } from "../shared/protocol";

/** Returns whether a native VS Code modal can safely render the approval request. */
function shouldUseNativeApprovalPrompt(approval: {
  /** Tool id requesting approval. */
  toolName: string;
  /** Short detail lines shown alongside the approval prompt. */
  details: readonly string[];
}): boolean {
  if (
    approval.toolName !== "run_project_command" &&
    approval.toolName !== "run_terminal_command"
  ) {
    return false;
  }

  if (approval.details.length === 0 || approval.details.length > 2) {
    return false;
  }

  return approval.details.every(
    (detail) => detail.length <= 160 && !detail.includes("\n"),
  );
}

/** Shows a native modal approval dialog and converts the selected action into a workflow decision. */
async function requestNativeToolApproval(approval: {
  /** Title shown in the modal prompt. */
  title: string;
  /** Primary approval message shown to the user. */
  message: string;
  /** Additional detail lines shown in the modal prompt. */
  details: readonly string[];
}): Promise<ToolApprovalDecision> {
  const allowItem: vscode.MessageItem = { title: "Cho phep luon" };
  const askItem: vscode.MessageItem = { title: "Hoi lai" };
  const denyItem: vscode.MessageItem = {
    title: "Tu choi",
    isCloseAffordance: true,
  };
  const selection = await vscode.window.showWarningMessage(
    approval.title,
    {
      modal: true,
      detail: [approval.message, ...approval.details].join("\n"),
    },
    allowItem,
    askItem,
    denyItem,
  );

  if (selection === allowItem) {
    return "allow";
  }

  if (selection === askItem) {
    return "ask";
  }

  return "deny";
}

/** Surfaces a follow-up notification that can reveal the Galaxy view or logs. */
async function showApprovalNotification(
  callbacks: Pick<ApprovalWorkflowCallbacks, "reveal" | "showLogs">,
  title: string,
): Promise<void> {
  const selection = await vscode.window.showWarningMessage(
    title,
    "Open Galaxy Code",
    "Show Logs",
  );
  if (selection === "Open Galaxy Code") {
    await callbacks.reveal();
    return;
  }

  if (selection === "Show Logs") {
    callbacks.showLogs();
  }
}

/** Requests approval using either a native modal prompt or the webview modal flow. */
export async function requestToolApproval(
  callbacks: ApprovalWorkflowCallbacks,
  approval: ToolApprovalRequest,
): Promise<ToolApprovalDecision> {
  if (callbacks.hasPendingApproval()) {
    return "deny";
  }

  const requestId = callbacks.createRequestId();
  const payload: ApprovalRequestPayload = {
    requestId,
    approvalKey: approval.approvalKey,
    toolName: approval.toolName,
    title: approval.title,
    message: approval.message,
    details: approval.details,
  };

  callbacks.appendLog(
    "approval",
    `${approval.toolName} is waiting for user approval.`,
  );

  if (shouldUseNativeApprovalPrompt(approval)) {
    callbacks.setPendingApprovalState({
      requestId,
      title: approval.title,
      payload,
    });
    callbacks.updateWorkbenchChrome();
    const decision = await requestNativeToolApproval(approval);
    callbacks.appendLog(
      "approval",
      `User selected ${decision} for ${approval.toolName}.`,
    );
    callbacks.clearPendingApprovalState();
    return decision;
  }

  return new Promise<ToolApprovalDecision>((resolve) => {
    callbacks.setPendingApprovalState({
      requestId,
      title: approval.title,
      payload,
      resolver: resolve,
    });
    callbacks.updateWorkbenchChrome();
    void callbacks
      .postMessage({
        type: "approval-request",
        payload,
      })
      .then(() =>
        showApprovalNotification(
          callbacks,
          `${approval.title} (${approval.toolName})`,
        ),
      )
      .catch(() => {
        callbacks.clearPendingApprovalState();
        resolve("deny");
      });
  });
}
