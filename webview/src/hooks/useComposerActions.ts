/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Hook that groups composer-side actions such as sending messages, managing attachments, responding to approvals, and dispatching slash commands.
 */

import type { ChangeEvent, ClipboardEvent, Dispatch, SetStateAction } from "react";
import type {
  ApprovalRequestPayload,
  ExtensionToolGroup,
  FigmaAttachment,
  MessageAttachment,
  QualityDetails,
  QualityPreferences,
  ToolCapabilities,
  ToolToggles,
  ToolApprovalDecision,
  WebviewMessage,
} from "@shared/protocol";
import type { LocalAttachment, PreviewAsset } from "@webview/entities/attachments";
import type { PendingRequest } from "@webview/entities/chat";
import { postHostMessage } from "@webview/vscode";

const FIGMA_ATTACHMENT_REGEX =
  /\[\[galaxy-code:figma-import:([A-Za-z0-9-]+)\]\]/g;

/**
 * Slash command ids currently supported by the composer.
 */
export type ComposerCommandId = "config" | "reset" | "clear";

/**
 * Dependencies required by the composer action hook.
 */
type UseComposerActionsOptions = Readonly<{
  /** Current composer input text. */
  input: string;
  /** Whether a request is already running. */
  isRunning: boolean;
  /** Current selected agent. */
  selectedAgent: import("@shared/protocol").AgentType;
  /** Currently selected workspace files. */
  selectedFiles: readonly string[];
  /** Attached Figma imports. */
  figmaAttachments: readonly FigmaAttachment[];
  /** Attached local files/images. */
  localAttachments: readonly LocalAttachment[];
  /** Current review/validate/full-access preference snapshot. */
  qualityPreferences: QualityPreferences;
  /** Current quality details mirrored from the host. */
  qualityDetails: QualityDetails;
  /** Current tool capability groups. */
  toolCapabilities: ToolCapabilities;
  /** Current individual tool toggles. */
  toolToggles: ToolToggles;
  /** Current discovered extension tool groups. */
  extensionToolGroups: readonly ExtensionToolGroup[];
  /** Current individual extension tool toggles. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Current approval popup payload. */
  approvalRequest: ApprovalRequestPayload | null;
  /** Current retryable request. */
  retryRequest: PendingRequest | null;
  /** Update transcript messages. */
  setMessages: Dispatch<
    SetStateAction<import("@shared/protocol").ChatMessage[]>
  >;
  /** Update streaming assistant content. */
  setStreamingAssistant: Dispatch<SetStateAction<string>>;
  /** Update streaming thinking content. */
  setStreamingThinking: Dispatch<SetStateAction<string>>;
  /** Update Figma attachments. */
  setFigmaAttachments: Dispatch<SetStateAction<FigmaAttachment[]>>;
  /** Update local attachments. */
  setLocalAttachments: Dispatch<SetStateAction<LocalAttachment[]>>;
  /** Update preview asset modal state. */
  setPreviewAsset: Dispatch<SetStateAction<PreviewAsset | null>>;
  /** Update error banner text. */
  setErrorText: Dispatch<SetStateAction<string>>;
  /** Update current run-state flag immediately after local send. */
  setIsRunning: Dispatch<SetStateAction<boolean>>;
  /** Update status text shown while waiting for the host/runtime. */
  setStatusText: Dispatch<SetStateAction<string>>;
  /** Update retry request state. */
  setRetryRequest: Dispatch<SetStateAction<PendingRequest | null>>;
  /** Update pending user message id. */
  setPendingMessageId: Dispatch<SetStateAction<string | null>>;
  /** Update in-flight request tracking. */
  setInflightRequest: Dispatch<SetStateAction<PendingRequest | null>>;
  /** Update current manual prompt plan. */
  setManualPromptPlan: Dispatch<
    SetStateAction<import("@webview/entities/chat").ManualPromptPlan | null>
  >;
  /** Update composer input text. */
  setInput: Dispatch<SetStateAction<string>>;
  /** Update plus-menu visibility. */
  setIsPlusMenuOpen: Dispatch<SetStateAction<boolean>>;
  /** Update quality preferences state. */
  setQualityPreferences: Dispatch<SetStateAction<QualityPreferences>>;
  /** Update tool capability state. */
  setToolCapabilities: Dispatch<SetStateAction<ToolCapabilities>>;
  /** Update tool toggle state. */
  setToolToggles: Dispatch<SetStateAction<ToolToggles>>;
  /** Update extension tool toggle state. */
  setExtensionToolToggles: Dispatch<
    SetStateAction<Readonly<Record<string, boolean>>>
  >;
  /** Update approval popup state. */
  setApprovalRequest: Dispatch<SetStateAction<ApprovalRequestPayload | null>>;
}>;

/**
 * Group composer-side actions so App.tsx can stay focused on UI composition.
 */
export function useComposerActions(options: UseComposerActionsOptions) {
  function updateQualityPreferences(next: QualityPreferences): void {
    options.setQualityPreferences(next);
    postHostMessage({
      type: "quality-set",
      payload: next,
    } satisfies WebviewMessage);
  }

  function updateToolCapabilities(next: ToolCapabilities): void {
    options.setToolCapabilities(next);
    postHostMessage({
      type: "tool-capabilities-set",
      payload: next,
    } satisfies WebviewMessage);
  }

  function updateToolToggles(next: ToolToggles): void {
    options.setToolToggles(next);
    postHostMessage({
      type: "tool-toggles-set",
      payload: next,
    } satisfies WebviewMessage);
  }

  function updateExtensionToolToggles(
    next: Readonly<Record<string, boolean>>
  ): void {
    options.setExtensionToolToggles(next);
    postHostMessage({
      type: "extension-tool-toggles-set",
      payload: next,
    } satisfies WebviewMessage);
  }

  function resolveFigmaAttachment(
    importId: string,
    purpose: "attach" | "preview"
  ): void {
    postHostMessage({
      type: "resolve-figma-attachment",
      payload: { importId, purpose },
    } satisfies WebviewMessage);
  }

  function openFigmaPreview(attachment: FigmaAttachment): void {
    if (attachment.previewDataUrl) {
      options.setPreviewAsset({
        title: attachment.label,
        imageUrl: attachment.previewDataUrl,
      });
      return;
    }

    resolveFigmaAttachment(attachment.importId, "preview");
  }

  function removeFigmaAttachment(importId: string): void {
    const target = options.figmaAttachments.find(
      (item) => item.importId === importId
    );
    if (target?.attachmentId) {
      postHostMessage({
        type: "attachment-remove",
        payload: { attachmentId: target.attachmentId },
      } satisfies WebviewMessage);
    }
    options.setFigmaAttachments((current) =>
      current.filter((item) => item.importId !== importId)
    );
  }

  function removeLocalAttachment(attachmentId: string): void {
    options.setLocalAttachments((current) => {
      const target = current.find((item) => item.attachmentId === attachmentId);
      if (target?.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((item) => item.attachmentId !== attachmentId);
    });
    postHostMessage({
      type: "attachment-remove",
      payload: { attachmentId },
    } satisfies WebviewMessage);
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () =>
        reject(reader.error ?? new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  async function handleFileSelection(
    event: ChangeEvent<HTMLInputElement>
  ): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }

    options.setIsPlusMenuOpen(false);
    try {
      const payloads = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          dataUrl: await readFileAsDataUrl(file),
        }))
      );

      payloads.forEach((payload) => {
        postHostMessage({
          type: "attachment-add-local",
          payload,
        } satisfies WebviewMessage);
      });
    } catch (error) {
      options.setErrorText(`Không thể đọc file đính kèm: ${String(error)}`);
    }
    event.target.value = "";
  }

  function handleComposerPaste(
    event: ClipboardEvent<HTMLTextAreaElement>
  ): void {
    const pastedText = event.clipboardData.getData("text");
    if (!pastedText) {
      return;
    }

    FIGMA_ATTACHMENT_REGEX.lastIndex = 0;
    const matches = [...pastedText.matchAll(FIGMA_ATTACHMENT_REGEX)];
    if (matches.length === 0) {
      return;
    }

    event.preventDefault();
    const importIds = [
      ...new Set(matches.map((match) => match[1]).filter(Boolean)),
    ];
    importIds.forEach((importId) => resolveFigmaAttachment(importId, "attach"));

    const residualText = pastedText.replace(FIGMA_ATTACHMENT_REGEX, "").trim();
    if (residualText) {
      options.setInput((current) =>
        current ? `${current}\n${residualText}` : residualText
      );
    }
  }

  function respondToApproval(decision: ToolApprovalDecision): void {
    if (!options.approvalRequest) {
      return;
    }

    postHostMessage({
      type: "approval-response",
      payload: {
        requestId: options.approvalRequest.requestId,
        decision,
      },
    } satisfies WebviewMessage);
    options.setApprovalRequest(null);
  }

  function buildComposerMessageAttachments(): MessageAttachment[] {
    const figma = options.figmaAttachments.map((attachment) =>
      Object.freeze({
        attachmentId: attachment.attachmentId ?? attachment.importId,
        kind: "figma" as const,
        label: "Design By Figma",
        ...(attachment.previewDataUrl
          ? { previewDataUrl: attachment.previewDataUrl }
          : {}),
        importId: attachment.importId,
      })
    );

    const local = options.localAttachments.map((attachment) =>
      Object.freeze({
        attachmentId: attachment.attachmentId,
        kind: attachment.isImage ? ("image" as const) : ("file" as const),
        label: attachment.name,
        ...(attachment.previewUrl ? { previewDataUrl: attachment.previewUrl } : {}),
      })
    );

    return [...figma, ...local];
  }

  function sendRequest(
    request: Omit<PendingRequest, "hasServerResponse">,
    opts?: { appendUserMessage?: boolean }
  ): void {
    if (options.isRunning) {
      return;
    }

    options.setErrorText("");
    options.setStreamingAssistant("");
    options.setStreamingThinking("");
    options.setRetryRequest(null);
    options.setPendingMessageId(request.messageId);
    options.setManualPromptPlan(null);
    options.setIsRunning(true);
    options.setStatusText(`Running ${request.agent}`);
    options.setInflightRequest({
      ...request,
      hasServerResponse: false,
    });

    if (opts?.appendUserMessage !== false) {
      const messageAttachments = options.figmaAttachments.map((attachment) => ({
        importId: attachment.importId,
        label: attachment.label,
        summary: attachment.summary,
      }));
      const attachments = buildComposerMessageAttachments();
      options.setMessages((current) => [
        ...current,
        {
          id: request.messageId,
          role: "user",
          content: request.content,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(messageAttachments.length > 0
            ? { figmaAttachments: messageAttachments }
            : {}),
          timestamp: Date.now(),
        },
      ]);
    }

    postHostMessage({
      type: "chat-send",
      payload: {
        content: request.content,
        agent: request.agent,
        selectedFiles: request.selectedFiles,
        reviewEnabled: request.reviewEnabled,
        validateEnabled: request.validateEnabled,
        fullAccessEnabled: request.fullAccessEnabled,
        ...(request.figmaImportIds.length > 0
          ? {
              figmaImportIds: request.figmaImportIds,
            }
          : {}),
        ...(request.attachmentIds.length > 0
          ? {
              attachmentIds: request.attachmentIds,
            }
          : {}),
      },
    } satisfies WebviewMessage);
  }

  function sendMessage(): void {
    const content = options.input.trim();
    if ((!content && options.figmaAttachments.length === 0) || options.isRunning) {
      return;
    }

    const finalContent =
      content ||
      "Implement the attached Figma design in the current workspace.";
    const attachmentIds = [
      ...options.figmaAttachments
        .map((attachment) => attachment.attachmentId)
        .filter((value): value is string => Boolean(value)),
      ...options.localAttachments.map((attachment) => attachment.attachmentId),
    ];
    const request = {
      messageId: `local-${Date.now()}`,
      content: finalContent,
      agent: options.selectedAgent,
      selectedFiles: options.selectedFiles,
      figmaImportIds: options.figmaAttachments.map(
        (attachment) => attachment.importId
      ),
      attachmentIds,
      reviewEnabled: options.toolCapabilities.review,
      validateEnabled: options.toolCapabilities.validation,
      fullAccessEnabled: options.qualityPreferences.fullAccessEnabled,
    } satisfies Omit<PendingRequest, "hasServerResponse">;

    sendRequest(request, { appendUserMessage: true });

    options.setInput("");
    options.setFigmaAttachments([]);
    options.setLocalAttachments([]);
    options.setPreviewAsset(null);
    options.setIsPlusMenuOpen(false);
  }

  function retryLastRequest(): void {
    if (!options.retryRequest || options.isRunning) {
      return;
    }
    sendRequest(options.retryRequest, { appendUserMessage: false });
  }

  function executeSlashCommand(commandId: ComposerCommandId): void {
    postHostMessage({
      type: "composer-command",
      payload: { id: commandId },
    } satisfies WebviewMessage);

    if (commandId === "clear") {
      options.setMessages([]);
      options.setStreamingAssistant("");
      options.setStreamingThinking("");
      options.setFigmaAttachments([]);
      options.setLocalAttachments([]);
      options.setPreviewAsset(null);
      options.setErrorText("");
      options.setRetryRequest(null);
      options.setPendingMessageId(null);
      options.setInflightRequest(null);
    }

    options.setInput("");
    options.setIsPlusMenuOpen(false);
  }

  return {
    updateQualityPreferences,
    updateToolCapabilities,
    updateToolToggles,
    updateExtensionToolToggles,
    openFigmaPreview,
    removeFigmaAttachment,
    removeLocalAttachment,
    handleFileSelection,
    handleComposerPaste,
    respondToApproval,
    executeSlashCommand,
    sendMessage,
    retryLastRequest,
  };
}
