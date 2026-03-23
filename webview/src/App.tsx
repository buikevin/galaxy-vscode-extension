/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Root webview component that owns chat state, wires host/runtime hooks, and mounts top-level transcript, composer, modal, and approval UI.
 */

import { useEffect, useRef, useState } from "react";
import type {
  AgentType,
  ApprovalRequestPayload,
  ChatMessage,
  ChangeSummary,
  FigmaAttachment,
  QualityPreferences,
} from "@shared/protocol";
import { Card, CardContent } from "@webview/components/ui/card";
import { ApprovalPopup } from "@webview/components/chat/ApprovalPopup";
import { ComposerPanel } from "@webview/components/chat/ComposerPanel";
import { PreviewModal } from "@webview/components/chat/PreviewModal";
import { Transcript } from "@webview/components/chat/Transcript";
import {
  ComposerViewProvider,
  type SlashCommandItem,
} from "@webview/context/ComposerViewContext";
import { TranscriptViewProvider } from "@webview/context/TranscriptViewContext";
import { useChatViewModel } from "@webview/hooks/useChatViewModel";
import { useComposerActions } from "@webview/hooks/useComposerActions";
import { useHostMessages } from "@webview/hooks/useHostMessages";
import { persistState, readPersistedState } from "./vscode";
import type { LocalAttachment, PreviewAsset } from "./entities/attachments";
import type {
  ActiveShellSession,
  ManualPromptPlan,
  PendingRequest,
} from "./entities/chat";

/**
 * Supported agent options shown in the composer selector.
 */
const AGENTS: readonly AgentType[] = ["manual", "ollama", "gemini", "claude", "codex"];

/**
 * Hard limit used to visualize prompt token usage inside the composer ring.
 */
const MAX_CONTEXT_TOKENS = 256_000;

/**
 * Slash commands available from the chat composer.
 */
const SLASH_COMMANDS: readonly SlashCommandItem[] = [
  {
    id: "config",
    label: "/config",
    description: "Mở thư mục ~/.galaxy",
  },
  {
    id: "reset",
    label: "/reset",
    description: "Đưa review=false, validate=false",
  },
  {
    id: "clear",
    label: "/clear",
    description: "Xóa dữ liệu workspace hiện tại",
  },
] as const;

/**
 * Root Galaxy Code webview app.
 */
export function App() {
  const persisted = readPersistedState();
  const [, setWorkspaceName] = useState("Workspace");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentType>(
    (persisted?.selectedAgent as AgentType | undefined) ?? "manual"
  );
  const [selectedFiles, setSelectedFiles] = useState<string[]>(
    persisted?.selectedFiles ?? []
  );
  const [input, setInput] = useState(persisted?.input ?? "");
  const [isRunning, setIsRunning] = useState(false);
  const [statusText, setStatusText] = useState("Ready");
  const [errorText, setErrorText] = useState("");
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [promptTokens, setPromptTokens] = useState(0);
  const [approvalRequest, setApprovalRequest] =
    useState<ApprovalRequestPayload | null>(null);
  const [figmaAttachments, setFigmaAttachments] = useState<FigmaAttachment[]>(
    []
  );
  const [localAttachments, setLocalAttachments] = useState<LocalAttachment[]>(
    []
  );
  const [previewAsset, setPreviewAsset] = useState<PreviewAsset | null>(null);
  const [copiedCommandMessageId, setCopiedCommandMessageId] = useState<
    string | null
  >(null);
  const [activeShellSessions, setActiveShellSessions] = useState<
    ActiveShellSession[]
  >([]);
  const [shellNow, setShellNow] = useState(() => Date.now());
  const [, setManualPromptPlan] = useState<ManualPromptPlan | null>(null);
  const [qualityPreferences, setQualityPreferences] =
    useState<QualityPreferences>({
      reviewEnabled: true,
      validateEnabled: true,
      fullAccessEnabled: false,
    });
  const [pendingPreviewImportId, setPendingPreviewImportId] = useState<
    string | null
  >(null);
  const [expandedItems, setExpandedItems] = useState<string[]>([]);
  const [expandedMessages, setExpandedMessages] = useState<string[]>([]);
  const [changeSummary, setChangeSummary] = useState<ChangeSummary>({
    fileCount: 0,
    createdCount: 0,
    addedLines: 0,
    deletedLines: 0,
    files: [],
  });
  const [keptChangeSummaryKey, setKeptChangeSummaryKey] = useState(
    persisted?.keptChangeSummaryKey ?? ""
  );
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
  const [inflightRequest, setInflightRequest] = useState<PendingRequest | null>(
    null
  );
  const [retryRequest, setRetryRequest] = useState<PendingRequest | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const plusMenuAnchorRef = useRef<HTMLDivElement | null>(null);
  const shellOutputRefs = useRef(new Map<string, HTMLDivElement>());

  /**
   * Revoke blob URLs created for local previews when attachments are replaced or the app unmounts.
   */
  useEffect(() => {
    return () => {
      localAttachments.forEach((attachment) => {
        if (attachment.previewUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, [localAttachments]);

  /**
   * Persist lightweight webview state so the composer can recover after reloads.
   */
  useEffect(() => {
    persistState({
      input,
      selectedAgent,
      selectedFiles,
      keptChangeSummaryKey,
    });
  }, [input, selectedAgent, selectedFiles, keptChangeSummaryKey]);

  /**
   * Autosize the composer textarea while capping it to a reasonable visible height.
   */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    const computed = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computed.lineHeight || "24") || 24;
    const borderBox = textarea.offsetHeight - textarea.clientHeight;
    const maxHeight = lineHeight * 6 + borderBox + 16;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(nextHeight, lineHeight + borderBox + 16)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  /**
   * Keep the transcript scrolled to the latest visible content as messages and streams arrive.
   */
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) {
      return;
    }

    const viewport = root.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLElement | null;
    if (!viewport) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [messages, streamingAssistant, streamingThinking, activeShellSessions, approvalRequest, errorText]);

  /**
   * Refresh live shell durations once per second while background commands are active.
   */
  useEffect(() => {
    if (activeShellSessions.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setShellNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [activeShellSessions.length]);

  /**
   * Auto-scroll each shell output container as new stdout/stderr chunks stream in.
   */
  useEffect(() => {
    activeShellSessions.forEach((session) => {
      const node = shellOutputRefs.current.get(session.toolCallId);
      if (!node) {
        return;
      }
      node.scrollTop = node.scrollHeight;
    });
  }, [activeShellSessions]);

  /**
   * Close the plus-menu popup when the user clicks outside its anchor region.
   */
  useEffect(() => {
    if (!isPlusMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (plusMenuAnchorRef.current?.contains(target)) {
        return;
      }
      setIsPlusMenuOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isPlusMenuOpen]);

  /**
   * Bind host-to-webview message handling so state stays in sync with runtime events.
   */
  useHostMessages({
    pendingPreviewImportId,
    inflightRequest,
    setWorkspaceName,
    setMessages,
    setSelectedAgent,
    setIsRunning,
    setStatusText,
    setErrorText,
    setStreamingAssistant,
    setStreamingThinking,
    setFigmaAttachments,
    setLocalAttachments,
    setPreviewAsset,
    setIsPlusMenuOpen,
    setApprovalRequest,
    setRetryRequest,
    setPendingMessageId,
    setInflightRequest,
    setActiveShellSessions,
    setManualPromptPlan,
    setSelectedFiles,
    setQualityPreferences,
    setChangeSummary,
    setKeptChangeSummaryKey,
    setPromptTokens,
    setPendingPreviewImportId,
  });

  /**
   * Group composer-side actions such as send, retry, attachment handling, and approvals.
   */
  const {
    updateQualityPreferences,
    openFigmaPreview,
    removeFigmaAttachment,
    removeLocalAttachment,
    handleFileSelection,
    handleComposerPaste,
    respondToApproval,
    executeSlashCommand,
    sendMessage,
    retryLastRequest,
  } = useComposerActions({
    input,
    isRunning,
    selectedAgent,
    selectedFiles,
    figmaAttachments,
    localAttachments,
    qualityPreferences,
    approvalRequest,
    retryRequest,
    setMessages,
    setStreamingAssistant,
    setStreamingThinking,
    setFigmaAttachments,
    setLocalAttachments,
    setPreviewAsset,
    setErrorText,
    setRetryRequest,
    setPendingMessageId,
    setInflightRequest,
    setManualPromptPlan,
    setInput,
    setIsPlusMenuOpen,
    setQualityPreferences,
    setApprovalRequest,
  });

  /**
   * Derive the presentation-oriented view model used by providers and top-level error UI.
   */
  const {
    errorTitle,
    retryLastRequest: retryLastRequestFromView,
    composerContextValue,
    transcriptContextValue,
  } = useChatViewModel({
    selectedAgent,
    selectedFiles,
    input,
    isRunning,
    statusText,
    errorText,
    retryRequest,
    streamingAssistant,
    streamingThinking,
    promptTokens,
    figmaAttachments,
    localAttachments,
    copiedCommandMessageId,
    activeShellSessions,
    shellNow,
    qualityPreferences,
    expandedItems,
    expandedMessages,
    changeSummary,
    keptChangeSummaryKey,
    isPlusMenuOpen,
    pendingMessageId,
    messages,
    scrollAreaRef,
    textareaRef,
    fileInputRef,
    plusMenuAnchorRef,
    shellOutputRefs,
    setCopiedCommandMessageId,
    setPreviewAsset,
    setErrorText,
    setExpandedItems,
    setExpandedMessages,
    setKeptChangeSummaryKey,
    setIsPlusMenuOpen,
    setInput,
    setSelectedAgent,
    sendMessage,
    retryLastRequest,
    openFigmaPreview,
    removeFigmaAttachment,
    removeLocalAttachment,
    handleFileSelection,
    handleComposerPaste,
    updateQualityPreferences,
    executeSlashCommand,
    slashCommandSource: SLASH_COMMANDS,
    agents: AGENTS,
    maxContextTokens: MAX_CONTEXT_TOKENS,
  });

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-screen flex-col gap-2 overflow-hidden bg-[linear-gradient(180deg,#08111f_0%,#0b1220_100%)]">
        {errorText ? (
          <div className="px-3 py-3 mx-2 mt-2 text-sm border rounded-xl border-rose-500/40 bg-rose-500/10 text-rose-100">
            <div className="font-medium text-rose-200">{errorTitle}</div>
            <div className="mt-1 text-rose-100/90">{errorText}</div>
            {retryRequest ? (
              <button
                type="button"
                className="mt-3 inline-flex items-center rounded-full border border-rose-400/30 bg-transparent px-3 py-1.5 text-sm text-rose-100 transition-colors hover:bg-rose-500/10"
                onClick={retryLastRequestFromView}
              >
                Thử lại
              </button>
            ) : null}
          </div>
        ) : null}

        <Card className="flex-1 min-h-0 overflow-hidden rounded-none border-x-0 border-y-0">
          <CardContent className="flex flex-col h-full min-h-0 gap-2 p-0">
            <TranscriptViewProvider value={transcriptContextValue}>
              <ComposerViewProvider value={composerContextValue}>
                <Transcript />
                <ComposerPanel />
              </ComposerViewProvider>
            </TranscriptViewProvider>
          </CardContent>
        </Card>

        <PreviewModal
          previewAsset={previewAsset}
          onClose={() => setPreviewAsset(null)}
        />

        <ApprovalPopup
          approvalRequest={approvalRequest}
          onDeny={() => respondToApproval("deny")}
          onAsk={() => respondToApproval("ask")}
          onAllow={() => respondToApproval("allow")}
        />
      </div>
    </div>
  );
}
