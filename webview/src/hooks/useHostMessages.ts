/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Hook that wires host-to-webview message handling for the Galaxy Code chat UI.
 */

import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  CommandStreamChunkPayload,
  CommandStreamEndPayload,
  CommandStreamStartPayload,
  ExtensionToolGroup,
  FileItem,
  FigmaAttachment,
  HostMessage,
  QualityPreferences,
  QualityDetails,
  ToolCapabilities,
  ToolToggles,
  WebviewMessage,
} from "@shared/protocol";
import type { LocalAttachment, PreviewAsset } from "@webview/entities/attachments";
import type {
  ActiveShellSession,
  ManualPromptPlan,
  PendingRequest,
} from "@webview/entities/chat";
import { postHostMessage, type WebviewHostEvent } from "@webview/vscode";

/**
 * All state setters and values required to handle host messages.
 */
type UseHostMessagesOptions = Readonly<{
  /** Current preview-import id waiting for resolved Figma data. */
  pendingPreviewImportId: string | null;
  /** Current in-flight request used for retry/error bookkeeping. */
  inflightRequest: PendingRequest | null;
  /** Update workspace display name. */
  setWorkspaceName: Dispatch<SetStateAction<string>>;
  /** Append or replace transcript messages. */
  setMessages: Dispatch<SetStateAction<import("@shared/protocol").ChatMessage[]>>;
  /** Update selected agent in the composer. */
  setSelectedAgent: Dispatch<SetStateAction<import("@shared/protocol").AgentType>>;
  /** Update current run-state flag. */
  setIsRunning: Dispatch<SetStateAction<boolean>>;
  /** Update run status text. */
  setStatusText: Dispatch<SetStateAction<string>>;
  /** Update error banner text. */
  setErrorText: Dispatch<SetStateAction<string>>;
  /** Update streaming assistant content. */
  setStreamingAssistant: Dispatch<SetStateAction<string>>;
  /** Update streaming thinking content. */
  setStreamingThinking: Dispatch<SetStateAction<string>>;
  /** Replace attached Figma imports. */
  setFigmaAttachments: Dispatch<SetStateAction<FigmaAttachment[]>>;
  /** Replace local attachments pending send. */
  setLocalAttachments: Dispatch<SetStateAction<LocalAttachment[]>>;
  /** Update preview modal asset. */
  setPreviewAsset: Dispatch<SetStateAction<PreviewAsset | null>>;
  /** Update plus-menu open state. */
  setIsPlusMenuOpen: Dispatch<SetStateAction<boolean>>;
  /** Update approval request popup state. */
  setApprovalRequest: Dispatch<
    SetStateAction<import("@shared/protocol").ApprovalRequestPayload | null>
  >;
  /** Store retryable request after transport/runtime error. */
  setRetryRequest: Dispatch<SetStateAction<PendingRequest | null>>;
  /** Track pending user message id in the transcript. */
  setPendingMessageId: Dispatch<SetStateAction<string | null>>;
  /** Track the currently running request. */
  setInflightRequest: Dispatch<SetStateAction<PendingRequest | null>>;
  /** Track live shell sessions in the transcript. */
  setActiveShellSessions: Dispatch<SetStateAction<ActiveShellSession[]>>;
  /** Store current manual planning/evidence context. */
  setManualPromptPlan: Dispatch<SetStateAction<ManualPromptPlan | null>>;
  /** Update selected workspace files. */
  setSelectedFiles: Dispatch<SetStateAction<string[]>>;
  /** Update quality preferences from host. */
  setQualityPreferences: Dispatch<SetStateAction<QualityPreferences>>;
  /** Update latest quality details from host. */
  setQualityDetails: Dispatch<SetStateAction<QualityDetails>>;
  /** Update tool capabilities from host. */
  setToolCapabilities: Dispatch<SetStateAction<ToolCapabilities>>;
  /** Update tool toggles from host. */
  setToolToggles: Dispatch<SetStateAction<ToolToggles>>;
  /** Update discovered extension tool groups from host. */
  setExtensionToolGroups: Dispatch<SetStateAction<readonly ExtensionToolGroup[]>>;
  /** Update extension tool toggles from host. */
  setExtensionToolToggles: Dispatch<SetStateAction<Readonly<Record<string, boolean>>>>;
  /** Update change summary box state. */
  setChangeSummary: Dispatch<
    SetStateAction<import("@shared/protocol").ChangeSummary>
  >;
  /** Update kept change-summary fingerprint. */
  setKeptChangeSummaryKey: Dispatch<SetStateAction<string>>;
  /** Update prompt token usage. */
  setPromptTokens: Dispatch<SetStateAction<number>>;
  /** Track preview import id waiting on host resolution. */
  setPendingPreviewImportId: Dispatch<SetStateAction<string | null>>;
}>;

/**
 * Register webview host listeners and mutate UI state from host messages.
 */
export function useHostMessages(options: UseHostMessagesOptions): void {
  function markServerResponseReceived(): void {
    options.setInflightRequest((current) => {
      if (!current || current.hasServerResponse) {
        return current;
      }

      options.setPendingMessageId(null);
      options.setErrorText("");
      options.setRetryRequest(null);
      return {
        ...current,
        hasServerResponse: true,
      };
    });
  }

  function handleCommandStreamStart(payload: CommandStreamStartPayload): void {
    options.setActiveShellSessions((current) => [
      ...current.filter((session) => session.toolCallId !== payload.toolCallId),
      {
        toolCallId: payload.toolCallId,
        commandText: payload.commandText,
        cwd: payload.cwd,
        startedAt: payload.startedAt,
        output: "",
        ...(payload.terminalTitle ? { terminalTitle: payload.terminalTitle } : {}),
      },
    ]);
  }

  function handleCommandStreamChunk(payload: CommandStreamChunkPayload): void {
    options.setActiveShellSessions((current) =>
      current.map((session) =>
        session.toolCallId === payload.toolCallId
          ? {
              ...session,
              output: `${session.output}${payload.chunk}`.slice(-50_000),
            }
          : session
      )
    );
  }

  function handleCommandStreamEnd(payload: CommandStreamEndPayload): void {
    options.setActiveShellSessions((current) =>
      current.map((session) =>
        session.toolCallId === payload.toolCallId
          ? {
              ...session,
              success: payload.success,
              exitCode: payload.exitCode,
              durationMs: payload.durationMs,
              ...(payload.background ? { background: true } : {}),
            }
          : session
      )
    );
  }

  function handleHostMessage(message: HostMessage): void {
    switch (message.type) {
      case "session-init":
        options.setWorkspaceName(message.payload.workspaceName);
        options.setMessages(message.payload.messages as import("@shared/protocol").ChatMessage[]);
        options.setSelectedAgent(message.payload.selectedAgent);
        options.setIsRunning(message.payload.isRunning);
        options.setStatusText(message.payload.statusText);
        options.setErrorText("");
        options.setStreamingAssistant(message.payload.streamingAssistant ?? "");
        options.setStreamingThinking(message.payload.streamingThinking ?? "");
        options.setFigmaAttachments([]);
        options.setLocalAttachments([]);
        options.setPreviewAsset(null);
        options.setIsPlusMenuOpen(false);
        options.setApprovalRequest(message.payload.approvalRequest ?? null);
        options.setRetryRequest(null);
        options.setPendingMessageId(null);
        options.setInflightRequest(null);
        options.setActiveShellSessions(
          (message.payload.activeShellSessions as ActiveShellSession[] | undefined) ?? []
        );
        options.setManualPromptPlan(null);
        options.setSelectedFiles(
          message.payload.files
            .filter((file: FileItem) => file.selected)
            .map((file: FileItem) => file.path)
        );
        options.setQualityPreferences(message.payload.qualityPreferences);
        options.setQualityDetails(message.payload.qualityDetails);
        options.setToolCapabilities(message.payload.toolCapabilities);
        options.setToolToggles(message.payload.toolToggles);
        options.setExtensionToolGroups(message.payload.extensionToolGroups);
        options.setExtensionToolToggles(message.payload.extensionToolToggles);
        options.setChangeSummary(message.payload.changeSummary);
        if (message.payload.changeSummary.fileCount === 0) {
          options.setKeptChangeSummaryKey("");
        }
        return;
      case "selected-agent-updated":
        options.setSelectedAgent(message.payload.selectedAgent);
        return;
      case "assistant-stream":
        markServerResponseReceived();
        options.setStreamingAssistant((current) => current + message.payload.delta);
        return;
      case "assistant-thinking":
        markServerResponseReceived();
        options.setStreamingThinking((current) => current + message.payload.delta);
        return;
      case "assistant-message":
      case "message-added":
        if (message.payload.role !== "user") {
          markServerResponseReceived();
        }
        if (message.payload.role === "assistant") {
          options.setStreamingAssistant("");
          options.setStreamingThinking("");
        }
        if (message.payload.role === "tool" && message.payload.toolCallId) {
          options.setActiveShellSessions((current) =>
            current.filter(
              (session) =>
                session.toolCallId !== message.payload.toolCallId ||
                message.payload.toolMeta?.background === true
            )
          );
        }
        options.setMessages((current) => [...current, message.payload]);
        return;
      case "selection-updated":
        options.setSelectedFiles(message.payload.selectedFiles as string[]);
        return;
      case "run-state":
        options.setIsRunning(message.payload.isRunning);
        options.setStatusText(message.payload.statusText);
        if (!message.payload.isRunning) {
          options.setStreamingAssistant("");
          options.setStreamingThinking("");
          options.setInflightRequest(null);
          options.setPendingMessageId(null);
        }
        return;
      case "command-stream-start":
        handleCommandStreamStart(message.payload);
        return;
      case "command-stream-chunk":
        handleCommandStreamChunk(message.payload);
        return;
      case "command-stream-end":
        handleCommandStreamEnd(message.payload);
        return;
      case "evidence-context":
        options.setPromptTokens(
          message.payload.finalPromptTokens ?? message.payload.tokens
        );
        options.setManualPromptPlan(() => {
          const focusSymbols = message.payload.focusSymbols ?? [];
          const batchItems = message.payload.manualReadBatchItems ?? [];
          const progressItems = message.payload.readPlanProgressItems ?? [];
          const confirmedCount =
            typeof message.payload.confirmedReadCount === "number"
              ? message.payload.confirmedReadCount
              : progressItems.filter((item) => item.confirmed).length;
          const summary = (message.payload.manualPlanningContent ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("["))
            .slice(0, 2)
            .join(" ");
          if (
            focusSymbols.length === 0 &&
            batchItems.length === 0 &&
            progressItems.length === 0 &&
            !summary
          ) {
            return null;
          }
          return {
            focusSymbols,
            summary,
            batchItems,
            progressItems,
            confirmedCount,
          };
        });
        return;
      case "approval-request":
        markServerResponseReceived();
        options.setApprovalRequest(message.payload);
        return;
      case "figma-attachment-resolved":
        if (message.payload.purpose === "attach") {
          options.setFigmaAttachments((current) => {
            const next = current.filter(
              (item) => item.importId !== message.payload.attachment.importId
            );
            return [...next, message.payload.attachment];
          });
        }
        if (
          options.pendingPreviewImportId ===
          message.payload.attachment.importId
        ) {
          if (message.payload.attachment.previewDataUrl) {
            options.setPreviewAsset({
              title: message.payload.attachment.label,
              imageUrl: message.payload.attachment.previewDataUrl,
            });
          }
          options.setPendingPreviewImportId(null);
        }
        options.setErrorText("");
        return;
      case "local-attachment-added":
        options.setLocalAttachments((current) => {
          const next = current.filter(
            (item) =>
              item.attachmentId !== message.payload.attachment.attachmentId
          );
          return [
            ...next,
            {
              attachmentId: message.payload.attachment.attachmentId,
              name: message.payload.attachment.name,
              isImage: message.payload.attachment.isImage,
              ...(message.payload.attachment.previewDataUrl
                ? { previewUrl: message.payload.attachment.previewDataUrl }
                : {}),
            },
          ];
        });
        options.setErrorText("");
        return;
      case "quality-preferences-updated":
        options.setQualityPreferences(message.payload);
        return;
      case "quality-updated":
        options.setQualityDetails(message.payload);
        return;
      case "tool-capabilities-updated":
        options.setToolCapabilities(message.payload);
        return;
      case "tool-toggles-updated":
        options.setToolToggles(message.payload);
        return;
      case "extension-tool-toggles-updated":
        options.setExtensionToolToggles(message.payload);
        return;
      case "change-summary-updated":
        options.setChangeSummary(message.payload);
        if (message.payload.fileCount === 0) {
          options.setKeptChangeSummaryKey("");
        }
        return;
      case "error":
        if (options.inflightRequest && !options.inflightRequest.hasServerResponse) {
          options.setRetryRequest(options.inflightRequest);
          options.setPendingMessageId(null);
        }
        options.setErrorText(message.payload.message);
        options.setIsRunning(false);
        options.setStatusText("Run failed");
        options.setStreamingThinking("");
        options.setInflightRequest(null);
        return;
      default:
        return;
    }
  }

  useEffect(() => {
    const handler = (event: WebviewHostEvent) => {
      const message = event.data;
      if (!message) {
        return;
      }

      handleHostMessage(message);
    };

    window.addEventListener("message", handler);
    postHostMessage({ type: "webview-ready" } satisfies WebviewMessage);
    return () => window.removeEventListener("message", handler);
  }, [options.pendingPreviewImportId, options.inflightRequest]);
}
