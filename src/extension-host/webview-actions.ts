/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Dispatcher for non-chat webview actions extracted from the extension host entrypoint.
 */

import * as vscode from "vscode";
import {
  createDraftLocalAttachment,
  removeDraftAttachment,
} from "../attachments/attachment-store";
import {
  buildFigmaAttachment,
} from "../figma/design-store";
import type {
  CreateWebviewActionCallbacksParams,
  ProviderWebviewActionBindings,
  WebviewActionCallbacks,
} from "../shared/webview-actions";
import type { WebviewMessage } from "../shared/protocol";

/** Builds non-chat webview callbacks from provider-owned state and methods. */
export function createWebviewActionCallbacks(
  params: CreateWebviewActionCallbacksParams,
): WebviewActionCallbacks {
  return {
    postInit: async () => params.postInit(),
    updateContextFileSelection: async (updates) =>
      params.updateContextFileSelection(updates),
    openWorkspaceFile: async (filePath) => params.openWorkspaceFile(filePath),
    openTrackedDiff: async (filePath) => params.openTrackedDiff(filePath),
    openExternalLink: async (href) => {
      await vscode.env.openExternal(vscode.Uri.parse(href));
    },
    runTerminalSnippet: (payload) => {
      const terminal = vscode.window.createTerminal({
        name: `Galaxy Snippet${payload.language ? ` (${payload.language})` : ""}`,
        cwd: params.workspacePath,
        isTransient: true,
      });
      terminal.show(true);
      terminal.sendText(payload.code, true);
    },
    revealShellTerminal: async (toolCallId) =>
      params.revealShellTerminal(toolCallId),
    loadOlderTranscriptMessages: async (oldestMessageId, batchSize) =>
      params.loadOlderTranscriptMessages(oldestMessageId, batchSize),
    handleApprovalResponse: (requestId, decision) => {
      if (!params.hasPendingApproval(requestId)) {
        return;
      }

      params.appendApprovalLog(decision);
      params.clearPendingApprovalState();
      params.resolvePendingApproval(decision);
    },
    applyQualityPreferences: async (next, opts) =>
      params.applyQualityPreferences(next, opts),
    applyToolCapabilities: async (next, opts) =>
      params.applyToolCapabilities(next, opts),
    applyToolToggles: async (next, opts) => params.applyToolToggles(next, opts),
    applyExtensionToolToggles: async (next, opts) =>
      params.applyExtensionToolToggles(next, opts),
    handleComposerCommand: async (commandId) =>
      params.handleComposerCommand(commandId),
    createDraftLocalAttachment: async (payload) =>
      createDraftLocalAttachment({
        workspacePath: params.workspacePath,
        name: payload.name,
        mimeType: payload.mimeType,
        dataUrl: payload.dataUrl,
      }),
    postMessage: async (message) => params.postMessage(message),
    removeDraftAttachment: (attachmentId) => {
      removeDraftAttachment(params.workspacePath, attachmentId);
    },
    openNativeReview: async () => params.openNativeReview(),
    dismissReviewFinding: async (findingId) =>
      params.dismissReviewFinding(findingId),
    applyReviewFinding: async (findingId) =>
      params.applyReviewFinding(findingId),
    revertAllTrackedChanges: async () => params.revertAllTrackedChanges(),
    revertTrackedFileChange: async (filePath) =>
      params.revertTrackedFileChange(filePath),
    resolveFigmaAttachment: (importId, purpose) =>
      buildFigmaAttachment(params.workspacePath, importId),
  };
}

/** Builds webview callbacks directly from provider-owned bindings. */
export function createProviderWebviewActionCallbacks(
  bindings: ProviderWebviewActionBindings,
): WebviewActionCallbacks {
  const resolvePendingApproval = bindings.pendingApprovalResolver;
  return createWebviewActionCallbacks({
    workspacePath: bindings.workspacePath,
    postInit: bindings.postInit,
    updateContextFileSelection: bindings.updateContextFileSelection,
    openWorkspaceFile: bindings.openWorkspaceFile,
    openTrackedDiff: bindings.openTrackedDiff,
    revealShellTerminal: bindings.revealShellTerminal,
    loadOlderTranscriptMessages: bindings.loadOlderTranscriptMessages,
    appendApprovalLog: (decision) => {
      bindings.appendLog(
        "approval",
        `User selected ${decision} for the pending approval request.`,
      );
    },
    hasPendingApproval: (requestId) =>
      Boolean(
        bindings.pendingApprovalResolver &&
        bindings.pendingApprovalRequestId === requestId,
      ),
    resolvePendingApproval: (decision) => {
      resolvePendingApproval?.(decision);
    },
    clearPendingApprovalState: bindings.clearPendingApprovalState,
    applyQualityPreferences: bindings.applyQualityPreferences,
    applyToolCapabilities: bindings.applyToolCapabilities,
    applyToolToggles: bindings.applyToolToggles,
    applyExtensionToolToggles: bindings.applyExtensionToolToggles,
    handleComposerCommand: bindings.handleComposerCommand,
    postMessage: bindings.postMessage,
    openNativeReview: bindings.openNativeReview,
    dismissReviewFinding: bindings.dismissReviewFinding,
    applyReviewFinding: bindings.applyReviewFinding,
    revertAllTrackedChanges: bindings.revertAllTrackedChanges,
    revertTrackedFileChange: bindings.revertTrackedFileChange,
  });
}

/** Routes all non-chat webview actions and returns whether the message was handled. */
export async function handleWebviewAction(
  message: WebviewMessage,
  callbacks: WebviewActionCallbacks,
): Promise<boolean> {
  switch (message.type) {
    case "webview-ready":
      await callbacks.postInit();
      return true;
    case "file-toggle":
      await callbacks.updateContextFileSelection([message.payload]);
      return true;
    case "file-open":
      await callbacks.openWorkspaceFile(message.payload.filePath);
      return true;
    case "file-diff":
      await callbacks.openTrackedDiff(message.payload.filePath);
      return true;
    case "link-open":
      await callbacks.openExternalLink(message.payload.href);
      return true;
    case "terminal-snippet-run":
      callbacks.runTerminalSnippet(message.payload);
      return true;
    case "shell-open-terminal":
      await callbacks.revealShellTerminal(message.payload.toolCallId);
      return true;
    case "transcript-load-older": {
      const result = await callbacks.loadOlderTranscriptMessages(
        message.payload.oldestMessageId,
        message.payload.batchSize,
      );
      await callbacks.postMessage({
        type: "transcript-older-loaded",
        payload: {
          messages: [...result.messages],
          hasOlderMessages: result.hasOlderMessages,
        },
      });
      return true;
    }
    case "approval-response":
      callbacks.handleApprovalResponse(
        message.payload.requestId,
        message.payload.decision,
      );
      return true;
    case "quality-set":
      await callbacks.applyQualityPreferences(message.payload, {
        syncVsCodeSettings: true,
        logMessage: `Quality preferences updated from the Galaxy Code sidebar: review=${String(message.payload.reviewEnabled)}, validate=${String(message.payload.validateEnabled)}, fullAccess=${String(message.payload.fullAccessEnabled)}.`,
      });
      return true;
    case "tool-capabilities-set":
      await callbacks.applyToolCapabilities(message.payload, {
        logMessage: "Tool capabilities updated from the Galaxy Code sidebar.",
      });
      return true;
    case "tool-toggles-set":
      await callbacks.applyToolToggles(message.payload, {
        logMessage: "Tool toggles updated from the Galaxy Code sidebar.",
      });
      return true;
    case "extension-tool-toggles-set":
      await callbacks.applyExtensionToolToggles(message.payload, {
        logMessage:
          "Extension tool toggles updated from the Galaxy Code sidebar.",
      });
      return true;
    case "composer-command":
      await callbacks.handleComposerCommand(message.payload.id);
      return true;
    case "attachment-add-local": {
      const attachment = await callbacks.createDraftLocalAttachment(
        message.payload,
      );
      await callbacks.postMessage({
        type: "local-attachment-added",
        payload: { attachment },
      });
      return true;
    }
    case "attachment-remove":
      callbacks.removeDraftAttachment(message.payload.attachmentId);
      return true;
    case "review-open":
      await callbacks.openNativeReview();
      return true;
    case "review-finding-dismiss":
      await callbacks.dismissReviewFinding(message.payload.findingId);
      return true;
    case "review-finding-apply":
      await callbacks.applyReviewFinding(message.payload.findingId);
      return true;
    case "revert-all-changes":
      await callbacks.revertAllTrackedChanges();
      return true;
    case "revert-file-change":
      await callbacks.revertTrackedFileChange(message.payload.filePath);
      return true;
    case "resolve-figma-attachment": {
      const attachment = callbacks.resolveFigmaAttachment(
        message.payload.importId,
        message.payload.purpose,
      );
      if (!attachment) {
        await callbacks.postMessage({
          type: "error",
          payload: {
            message: `Figma import not found in this workspace: ${message.payload.importId}`,
          },
        });
        return true;
      }

      await callbacks.postMessage({
        type: "figma-attachment-resolved",
        payload: { attachment, purpose: message.payload.purpose },
      });
      return true;
    }
    case "chat-send":
      return false;
  }
}
