import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  Eye,
  ExternalLink,
  FileInput,
  FileText,
  FolderTree,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Paperclip,
  Plus,
  SendHorizontal,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import type {
  AgentType,
  ApprovalRequestPayload,
  ChatMessage,
  ChangeSummary,
  CommandStreamChunkPayload,
  CommandStreamEndPayload,
  CommandStreamStartPayload,
  FileItem,
  FigmaAttachment,
  HostMessage,
  MessageAttachment,
  QualityPreferences,
  ToolApprovalDecision,
  WebviewMessage,
} from "@shared/protocol";
import { Badge } from "@webview/components/ui/badge";
import { Button } from "@webview/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@webview/components/ui/card";
import { ScrollArea } from "@webview/components/ui/scroll-area";
import { Spinner } from "@webview/components/ui/spinner";
import { Textarea } from "@webview/components/ui/textarea";
import {
  persistState,
  postHostMessage,
  readPersistedState,
  type WebviewHostEvent,
} from "./vscode";

const AGENTS: AgentType[] = ["manual", "ollama", "gemini", "claude", "codex"];
const FIGMA_ATTACHMENT_REGEX =
  /\[\[galaxy-code:figma-import:([A-Za-z0-9-]+)\]\]/g;
const MAX_CONTEXT_TOKENS = 256_000;
const SLASH_COMMANDS = [
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

type ListDirEntry = Readonly<{
  key: string;
  label: string;
  filePath: string;
  isDir: boolean;
  depth: number;
}>;

type LocalAttachment = Readonly<{
  attachmentId: string;
  name: string;
  isImage: boolean;
  previewUrl?: string;
}>;

type PreviewAsset = Readonly<{
  title: string;
  imageUrl: string;
}>;

type PendingRequest = Readonly<{
  messageId: string;
  content: string;
  agent: AgentType;
  selectedFiles: readonly string[];
  figmaImportIds: readonly string[];
  attachmentIds: readonly string[];
  reviewEnabled: boolean;
  validateEnabled: boolean;
  hasServerResponse: boolean;
}>;

type ActionItem = Readonly<{
  key: string;
  kind: "thinking" | "tool";
  message: ChatMessage;
}>;

type RenderItem =
  | Readonly<{ type: "message"; key: string; message: ChatMessage }>
  | Readonly<{ type: "actions"; key: string; items: readonly ActionItem[] }>
  | Readonly<{ type: "live-shell"; key: string; session: ActiveShellSession }>;

type ActiveShellSession = Readonly<{
  toolCallId: string;
  commandText: string;
  cwd: string;
  startedAt: number;
  output: string;
  success?: boolean;
  exitCode?: number;
  durationMs?: number;
}>;

export function App() {
  const persisted = readPersistedState();
  const [workspaceName, setWorkspaceName] = useState("Workspace");
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
  const [qualityPreferences, setQualityPreferences] =
    useState<QualityPreferences>({
      reviewEnabled: true,
      validateEnabled: true,
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
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
  const [inflightRequest, setInflightRequest] = useState<PendingRequest | null>(
    null
  );
  const [retryRequest, setRetryRequest] = useState<PendingRequest | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      localAttachments.forEach((attachment) => {
        if (attachment.previewUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, [localAttachments]);

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
  }, [pendingPreviewImportId]);

  useEffect(() => {
    persistState({
      input,
      selectedAgent,
      selectedFiles,
    });
  }, [input, selectedAgent, selectedFiles]);

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

  useEffect(() => {
    if (activeShellSessions.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setShellNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [activeShellSessions.length]);

  function markServerResponseReceived(): void {
    setInflightRequest((current) => {
      if (!current || current.hasServerResponse) {
        return current;
      }

      setPendingMessageId(null);
      setErrorText("");
      setRetryRequest(null);
      return {
        ...current,
        hasServerResponse: true,
      };
    });
  }

  function handleHostMessage(message: HostMessage): void {
    switch (message.type) {
      case "session-init":
        setWorkspaceName(message.payload.workspaceName);
        setMessages(message.payload.messages as ChatMessage[]);
        setSelectedAgent(message.payload.selectedAgent);
        setIsRunning(message.payload.isRunning);
        setStatusText(message.payload.statusText);
        setErrorText("");
        setInput("");
        setStreamingAssistant("");
        setStreamingThinking("");
        setFigmaAttachments([]);
        setLocalAttachments([]);
        setPreviewAsset(null);
        setIsPlusMenuOpen(false);
        setApprovalRequest(null);
        setRetryRequest(null);
        setPendingMessageId(null);
        setInflightRequest(null);
        setActiveShellSessions([]);
        setSelectedFiles(
          message.payload.files
            .filter((file: FileItem) => file.selected)
            .map((file: FileItem) => file.path)
        );
        setQualityPreferences(message.payload.qualityPreferences);
        setChangeSummary(message.payload.changeSummary);
        return;
      case "selected-agent-updated":
        setSelectedAgent(message.payload.selectedAgent);
        return;
      case "assistant-stream":
        markServerResponseReceived();
        setStreamingAssistant((current) => current + message.payload.delta);
        return;
      case "assistant-thinking":
        markServerResponseReceived();
        setStreamingThinking((current) => current + message.payload.delta);
        return;
      case "assistant-message":
      case "message-added":
        if (message.payload.role !== "user") {
          markServerResponseReceived();
        }
        if (message.payload.role === "assistant") {
          setStreamingAssistant("");
          setStreamingThinking("");
        }
        if (message.payload.role === "tool" && message.payload.toolCallId) {
          setActiveShellSessions((current) =>
            current.filter(
              (session) => session.toolCallId !== message.payload.toolCallId
            )
          );
        }
        setMessages((current) => [...current, message.payload]);
        return;
      case "selection-updated":
        setSelectedFiles(message.payload.selectedFiles as string[]);
        return;
      case "run-state":
        setIsRunning(message.payload.isRunning);
        setStatusText(message.payload.statusText);
        if (!message.payload.isRunning) {
          setStreamingAssistant("");
          setStreamingThinking("");
          setInflightRequest(null);
          setPendingMessageId(null);
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
        setPromptTokens(message.payload.finalPromptTokens ?? message.payload.tokens);
        return;
      case "approval-request":
        markServerResponseReceived();
        setApprovalRequest(message.payload);
        return;
      case "figma-attachment-resolved":
        if (message.payload.purpose === "attach") {
          setFigmaAttachments((current) => {
            const next = current.filter(
              (item) => item.importId !== message.payload.attachment.importId
            );
            return [...next, message.payload.attachment];
          });
        }
        if (pendingPreviewImportId === message.payload.attachment.importId) {
          if (message.payload.attachment.previewDataUrl) {
            setPreviewAsset({
              title: message.payload.attachment.label,
              imageUrl: message.payload.attachment.previewDataUrl,
            });
          }
          setPendingPreviewImportId(null);
        }
        setErrorText("");
        return;
      case "local-attachment-added":
        setLocalAttachments((current) => {
          const next = current.filter(
            (item) => item.attachmentId !== message.payload.attachment.attachmentId
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
        setErrorText("");
        return;
      case "quality-preferences-updated":
        setQualityPreferences(message.payload);
        return;
      case "change-summary-updated":
        setChangeSummary(message.payload);
        return;
      case "error":
        if (inflightRequest && !inflightRequest.hasServerResponse) {
          setRetryRequest(inflightRequest);
          setPendingMessageId(null);
        }
        setErrorText(message.payload.message);
        setIsRunning(false);
        setStatusText("Run failed");
        setStreamingThinking("");
        setInflightRequest(null);
        return;
      default:
        return;
    }
  }

  function handleCommandStreamStart(payload: CommandStreamStartPayload): void {
    setActiveShellSessions((current) => [
      ...current.filter((session) => session.toolCallId !== payload.toolCallId),
      {
        toolCallId: payload.toolCallId,
        commandText: payload.commandText,
        cwd: payload.cwd,
        startedAt: payload.startedAt,
        output: "",
      },
    ]);
  }

  function handleCommandStreamChunk(payload: CommandStreamChunkPayload): void {
    setActiveShellSessions((current) =>
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
    setActiveShellSessions((current) =>
      current.map((session) =>
        session.toolCallId === payload.toolCallId
          ? {
              ...session,
              success: payload.success,
              exitCode: payload.exitCode,
              durationMs: payload.durationMs,
            }
          : session
      )
    );
  }

  function sendRequest(
    request: Omit<PendingRequest, "hasServerResponse">,
    opts?: { appendUserMessage?: boolean }
  ): void {
    if (isRunning) {
      return;
    }

    setErrorText("");
    setStreamingAssistant("");
    setStreamingThinking("");
    setRetryRequest(null);
    setPendingMessageId(request.messageId);
    setInflightRequest({
      ...request,
      hasServerResponse: false,
    });

    if (opts?.appendUserMessage !== false) {
      const messageAttachments = figmaAttachments.map((attachment) => ({
        importId: attachment.importId,
        label: attachment.label,
        summary: attachment.summary,
      }));
      const attachments = buildComposerMessageAttachments();
      setMessages((current) => [
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
    const content = input.trim();
    if ((!content && figmaAttachments.length === 0) || isRunning) {
      return;
    }

    const finalContent =
      content ||
      "Implement the attached Figma design in the current workspace.";
    const attachmentIds = [
      ...figmaAttachments
        .map((attachment) => attachment.attachmentId)
        .filter((value): value is string => Boolean(value)),
      ...localAttachments.map((attachment) => attachment.attachmentId),
    ];
    const request = {
      messageId: `local-${Date.now()}`,
      content: finalContent,
      agent: selectedAgent,
      selectedFiles,
      figmaImportIds: figmaAttachments.map((attachment) => attachment.importId),
      attachmentIds,
      reviewEnabled: qualityPreferences.reviewEnabled,
      validateEnabled: qualityPreferences.validateEnabled,
    } satisfies Omit<PendingRequest, "hasServerResponse">;

    sendRequest(request, { appendUserMessage: true });

    setInput("");
    setFigmaAttachments([]);
    setLocalAttachments([]);
    setPreviewAsset(null);
    setIsPlusMenuOpen(false);
  }

  function retryLastRequest(): void {
    if (!retryRequest || isRunning) {
      return;
    }
    sendRequest(retryRequest, { appendUserMessage: false });
  }

  function classifyErrorTitle(message: string): string {
    const lowered = message.toLowerCase();
    if (lowered.includes("timeout")) {
      return "Yêu cầu bị timeout";
    }
    if (
      lowered.includes("connect") ||
      lowered.includes("econnrefused") ||
      lowered.includes("network")
    ) {
      return "Không thể kết nối tới AI Agent";
    }
    return "Gửi yêu cầu thất bại";
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
      setPreviewAsset({
        title: attachment.label,
        imageUrl: attachment.previewDataUrl,
      });
      return;
    }

    setPendingPreviewImportId(attachment.importId);
    resolveFigmaAttachment(attachment.importId, "preview");
  }

  function removeFigmaAttachment(importId: string): void {
    const target = figmaAttachments.find((item) => item.importId === importId);
    if (target?.attachmentId) {
      postHostMessage({
        type: "attachment-remove",
        payload: { attachmentId: target.attachmentId },
      } satisfies WebviewMessage);
    }
    setFigmaAttachments((current) =>
      current.filter((item) => item.importId !== importId)
    );
  }

  function removeLocalAttachment(attachmentId: string): void {
    setLocalAttachments((current) => {
      const target = current.find(
        (item) => item.attachmentId === attachmentId
      );
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
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  async function handleFileSelection(
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }

    setIsPlusMenuOpen(false);
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
      setErrorText(`Không thể đọc file đính kèm: ${String(error)}`);
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
      setInput((current) =>
        current ? `${current}\n${residualText}` : residualText
      );
    }
  }

  function respondToApproval(decision: ToolApprovalDecision): void {
    if (!approvalRequest) {
      return;
    }

    postHostMessage({
      type: "approval-response",
      payload: {
        requestId: approvalRequest.requestId,
        decision,
      },
    } satisfies WebviewMessage);
    setApprovalRequest(null);
  }

  function buildComposerMessageAttachments(): MessageAttachment[] {
    const figma = figmaAttachments.map((attachment) =>
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

    const local = localAttachments.map((attachment) =>
      Object.freeze({
        attachmentId: attachment.attachmentId,
        kind: attachment.isImage ? ("image" as const) : ("file" as const),
        label: attachment.name,
        ...(attachment.previewUrl ? { previewDataUrl: attachment.previewUrl } : {}),
      })
    );

    return [...figma, ...local];
  }

  function executeSlashCommand(commandId: "config" | "reset" | "clear"): void {
    postHostMessage({
      type: "composer-command",
      payload: { id: commandId },
    } satisfies WebviewMessage);

    if (commandId === "clear") {
      setMessages([]);
      setStreamingAssistant("");
      setStreamingThinking("");
      setFigmaAttachments([]);
      setLocalAttachments([]);
      setPreviewAsset(null);
      setErrorText("");
      setRetryRequest(null);
      setPendingMessageId(null);
      setInflightRequest(null);
    }

    setInput("");
    setIsPlusMenuOpen(false);
  }

  function toggleExpanded(key: string): void {
    setExpandedItems((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    );
  }

  function isExpanded(key: string): boolean {
    return expandedItems.includes(key);
  }

  function toggleMessageExpanded(messageId: string): void {
    setExpandedMessages((current) =>
      current.includes(messageId)
        ? current.filter((item) => item !== messageId)
        : [...current, messageId]
    );
  }

  function isMessageExpanded(messageId: string): boolean {
    return !expandedMessages.includes(messageId);
  }

  function normalizeRelativePath(pathValue: string): string {
    return pathValue.replace(/^\.\/+/, "").replace(/\\/g, "/");
  }

  function joinRelativePath(basePath: string, childName: string): string {
    const normalizedBase = normalizeRelativePath(basePath.trim());
    return normalizedBase ? `${normalizedBase}/${childName}` : childName;
  }

  function buildListDirEntries(message: ChatMessage): ListDirEntry[] {
    if (message.toolName !== "list_dir" || !message.content.trim()) {
      return [];
    }

    const basePath =
      typeof message.toolParams?.path === "string" ? message.toolParams.path : "";
    const lines = message.content.split("\n").filter((line) => line.trim());
    const segmentStack: string[] = [];
    const entries: ListDirEntry[] = [];

    lines.forEach((line, index) => {
      const leadingSpaces = line.match(/^\s*/)?.[0].length ?? 0;
      const depth = Math.floor(leadingSpaces / 2);
      const trimmed = line.trim();
      const isDir = trimmed.endsWith("/");
      const label = isDir ? trimmed.slice(0, -1) : trimmed;

      segmentStack.length = depth;
      segmentStack[depth] = label;

      const relativePath = joinRelativePath(basePath, segmentStack.join("/"));
      entries.push({
        key: `${message.id}-${index}-${relativePath}`,
        label,
        filePath: relativePath,
        isDir,
        depth,
      });
    });

    return entries;
  }

  function openFile(filePath: string): void {
    postHostMessage({
      type: "file-open",
      payload: { filePath },
    } satisfies WebviewMessage);
  }

  function handleListDirHover(
    event: React.MouseEvent<HTMLButtonElement>,
    entry: ListDirEntry
  ): void {
    if (event.shiftKey && !entry.isDir) {
      openFile(entry.filePath);
    }
  }

  function getToolPath(message: ChatMessage): string {
    return typeof message.toolParams?.path === "string" ? message.toolParams.path : "";
  }

  function getToolMetaString(
    message: ChatMessage,
    key: string
  ): string {
    const value = message.toolMeta?.[key];
    return typeof value === "string" ? value : "";
  }

  function getToolMetaNumber(
    message: ChatMessage,
    key: string
  ): number | null {
    const value = message.toolMeta?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function formatCommandDuration(durationMs: number | null): string {
    if (durationMs === null || durationMs < 0) {
      return "";
    }

    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  }

  function getActiveShellDuration(session: ActiveShellSession): string {
    if (typeof session.durationMs === "number") {
      return formatCommandDuration(session.durationMs);
    }

    return formatCommandDuration(shellNow - session.startedAt);
  }

  async function copyCommand(messageId: string, commandText: string): Promise<void> {
    if (!commandText.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(commandText);
      setCopiedCommandMessageId(messageId);
      window.setTimeout(() => {
        setCopiedCommandMessageId((current) =>
          current === messageId ? null : current
        );
      }, 1600);
    } catch {
      setErrorText("Không thể copy lệnh vào clipboard.");
    }
  }

  function renderShellPanel(opts: {
    panelId: string;
    commandText: string;
    cwd: string;
    output: string;
    success?: boolean;
    exitCode?: number;
    durationLabel?: string;
    running?: boolean;
  }) {
    const isCopied = copiedCommandMessageId === opts.panelId;
    const expandedKey = `tool:${opts.panelId}`;

    return (
      <div className="min-w-0 max-w-full overflow-x-hidden space-y-2">
        <div className="px-1 text-xs font-medium text-muted-foreground">
          {opts.running
            ? `Running command${opts.durationLabel ? ` for ${opts.durationLabel}` : ""}`
            : opts.durationLabel
              ? `${opts.success ? "Command finished in" : "Command failed after"} ${opts.durationLabel}`
              : opts.success
                ? "Command finished"
                : "Command failed"}
        </div>
        <div className="overflow-hidden rounded-[22px] border border-white/10 bg-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <button
            type="button"
            className="flex w-full items-center justify-between bg-white/[0.05] px-4 py-3 text-left"
            onClick={() => toggleExpanded(expandedKey)}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-base font-semibold text-foreground">Shell</span>
              {typeof opts.exitCode === "number" ? (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    opts.exitCode === 0
                      ? "bg-emerald-500/10 text-emerald-300"
                      : "bg-rose-500/10 text-rose-300"
                  }`}
                >
                  exit {opts.exitCode}
                </span>
              ) : opts.running ? (
                <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
                  live
                </span>
              ) : null}
            </div>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${
                isExpanded(expandedKey) ? "rotate-180" : ""
              }`}
            />
          </button>
          {isExpanded(expandedKey) ? (
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="overflow-x-auto whitespace-nowrap font-mono text-sm text-slate-200">
                    $ {opts.commandText || "(unknown command)"}
                  </div>
                  {opts.cwd ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      cwd: {opts.cwd}
                    </div>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="shrink-0 rounded-full"
                  onClick={() => copyCommand(opts.panelId, opts.commandText)}
                >
                  {isCopied ? (
                    <>
                      <Check className="h-4 w-4" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      <span>Copy</span>
                    </>
                  )}
                </Button>
              </div>
              <div className="max-h-72 overflow-auto rounded-xl border border-white/10 bg-[#151515] px-4 py-3 shadow-[inset_0_1px_18px_rgba(255,255,255,0.03)]">
                <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-8 text-slate-300 [overflow-wrap:anywhere]">
                  {opts.output || (opts.running ? "(waiting for output)" : "(no output)")}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function updateQualityPreferences(next: QualityPreferences): void {
    setQualityPreferences(next);
    postHostMessage({
      type: "quality-set",
      payload: next,
    } satisfies WebviewMessage);
  }

  const tokenUsagePercent = Math.max(
    0,
    Math.min(100, Math.round((promptTokens / MAX_CONTEXT_TOKENS) * 100))
  );
  const tokenUsageDegrees = Math.max(
    0,
    Math.min(360, Math.round((promptTokens / MAX_CONTEXT_TOKENS) * 360))
  );

  function shortenPath(pathValue: string, maxLength = 24): string {
    const normalized = normalizeRelativePath(pathValue);
    if (!normalized || normalized.length <= maxLength) {
      return normalized;
    }

    const segments = normalized.split("/").filter(Boolean);
    if (segments.length <= 1) {
      return `...${normalized.slice(-(maxLength - 3))}`;
    }

    let suffix = segments[segments.length - 1] ?? normalized;
    for (let index = segments.length - 2; index >= 0; index -= 1) {
      const candidate = `${segments[index]}/${suffix}`;
      if (candidate.length + 4 > maxLength) {
        break;
      }
      suffix = candidate;
    }

    return `.../${suffix}`;
  }

  function getAssistantLabel(agentType?: AgentType): string {
    return (agentType ?? selectedAgent) === "manual"
      ? "Galaxy Agent"
      : "Assistant";
  }

  function buildRenderItems(
    source: readonly ChatMessage[],
    shellSessions: readonly ActiveShellSession[]
  ): RenderItem[] {
    const items: RenderItem[] = [];
    const shellSessionsByToolCallId = new Map(
      shellSessions.map((session) => [session.toolCallId, session] as const)
    );
    const renderedShellSessionIds = new Set<string>();

    for (let index = 0; index < source.length; ) {
      const message = source[index]!;

      if (message.role === "assistant") {
        if (message.thinking?.trim()) {
          items.push({
            type: "actions",
            key: `thinking:${message.id}`,
            items: Object.freeze([
              {
                key: `thinking:${message.id}`,
                kind: "thinking" as const,
                message,
              },
            ]),
          });
        }

        const actionItems: ActionItem[] = [];

        let cursor = index + 1;
        while (cursor < source.length && source[cursor]!.role === "tool") {
          actionItems.push({
            key: source[cursor]!.id,
            kind: "tool",
            message: source[cursor]!,
          });
          cursor += 1;
        }

        if (actionItems.length > 0) {
          items.push({
            type: "actions",
            key: `actions:${message.id}`,
            items: Object.freeze(actionItems),
          });
        }

        const liveSessions = (message.toolCalls ?? [])
          .map((toolCall) => shellSessionsByToolCallId.get(toolCall.id))
          .filter((session): session is ActiveShellSession => Boolean(session));

        liveSessions.forEach((session) => {
          renderedShellSessionIds.add(session.toolCallId);
          items.push({
            type: "live-shell",
            key: `live-shell:${message.id}:${session.toolCallId}`,
            session,
          });
        });

        if (message.content.trim()) {
          items.push({
            type: "message",
            key: message.id,
            message,
          });
        }

        index = cursor;
        continue;
      }

      if (message.role === "tool") {
        const actionItems: ActionItem[] = [];
        let cursor = index;
        while (cursor < source.length && source[cursor]!.role === "tool") {
          actionItems.push({
            key: source[cursor]!.id,
            kind: "tool",
            message: source[cursor]!,
          });
          cursor += 1;
        }
        items.push({
          type: "actions",
          key: `actions:${message.id}`,
          items: Object.freeze(actionItems),
        });
        index = cursor;
        continue;
      }

      items.push({
        type: "message",
        key: message.id,
        message,
      });
      index += 1;
    }

    shellSessions.forEach((session) => {
      if (renderedShellSessionIds.has(session.toolCallId)) {
        return;
      }

      items.push({
        type: "live-shell",
        key: `live-shell:orphan:${session.toolCallId}`,
        session,
      });
    });

    return items;
  }

  function renderActionIcon(
    item: ActionItem,
    key: string,
    sizeClass = "h-4 w-4"
  ) {
    const iconClass = `${sizeClass} text-slate-200`;
    if (item.kind === "thinking") {
      return (
        <span
          key={key}
          className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/5"
        >
          <Brain className={iconClass} />
        </span>
      );
    }

    if (item.message.toolName === "list_dir") {
      return (
        <span
          key={key}
          className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/5"
        >
          <FolderTree className={iconClass} />
        </span>
      );
    }

    if (item.message.toolName === "read_file") {
      return (
        <span
          key={key}
          className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/5"
        >
          <FileInput className={iconClass} />
        </span>
      );
    }

    return (
      <span
        key={key}
        className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/5"
      >
        <Wrench className={iconClass} />
      </span>
    );
  }

  function renderThinkingBody(message: ChatMessage) {
    return (
      <div className="min-w-0 max-w-full overflow-x-hidden space-y-2">
        <button
          type="button"
          className="flex w-full min-w-0 items-center justify-between rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-left"
          onClick={() => toggleExpanded(`thinking:${message.id}`)}
        >
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
            <Brain className="h-4 w-4 text-violet-300" />
            <span>Thinking</span>
          </div>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              isExpanded(`thinking:${message.id}`) ? "rotate-180" : ""
            }`}
          />
        </button>
        {isExpanded(`thinking:${message.id}`) ? (
          <div className="max-h-36 max-w-full overflow-auto rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="min-w-0 whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">
              {message.thinking}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function renderToolBody(message: ChatMessage) {
    const listDirEntries = buildListDirEntries(message);
    const toolPath = getToolPath(message);
    const listDirLabel = normalizeRelativePath(toolPath) || ".";
    const readFileLabel = shortenPath(toolPath);
    const isListDirMessage =
      message.toolName === "list_dir" && listDirEntries.length > 0;
    const isReadFileMessage =
      (message.toolName === "read_file" || message.toolName === "read_document") &&
      Boolean(toolPath);
    const isRunProjectCommand = message.toolName === "run_project_command";

    if (isRunProjectCommand) {
      const commandText =
        getToolMetaString(message, "commandText") ||
        (typeof message.toolParams?.command === "string"
          ? message.toolParams.command
          : "");
      const cwd = getToolMetaString(message, "cwd");
      const exitCode = getToolMetaNumber(message, "exitCode");
      const duration = formatCommandDuration(
        getToolMetaNumber(message, "durationMs")
      );
      return renderShellPanel({
        panelId: message.id,
        commandText,
        cwd,
        output: message.content,
        success: message.toolSuccess,
        exitCode: exitCode ?? undefined,
        durationLabel: duration || undefined,
      });
    }

    if (isReadFileMessage) {
      return (
        <div className="grid w-full min-w-0 max-w-full grid-cols-[auto,minmax(0,1fr),auto] items-center gap-2 overflow-hidden rounded-[22px] border border-border/60 bg-background/50 px-4 py-3 text-left">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden text-sm font-medium text-foreground col-span-2">
            <FileInput className="h-4 w-4 shrink-0 text-sky-300" />
            <div className="min-w-0 flex-1 overflow-hidden">
              <span
                className="block min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
              title={`${message.toolName === "read_document" ? "Đọc tài liệu" : "Đọc file"} (${toolPath})`}
              >
                {message.toolName === "read_document" ? "Đọc tài liệu" : "Đọc file"} ({readFileLabel})
              </span>
            </div>
          </div>
          <button
            type="button"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-sky-200"
            onClick={() => openFile(toolPath)}
            title="Mở hoặc chuyển tới tab file này"
          >
            <Eye className="h-4 w-4" />
          </button>
        </div>
      );
    }

    return (
      <div className="min-w-0 max-w-full overflow-x-hidden space-y-2">
        <button
          type="button"
          className="flex w-full min-w-0 items-center justify-between rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-left"
          onClick={() => toggleExpanded(`tool:${message.id}`)}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            {isListDirMessage ? (
              <>
                <FolderTree className="h-4 w-4 text-sky-300" />
                <span className="min-w-0 max-w-full break-all [overflow-wrap:anywhere]">
                  Quét thư mục ({listDirLabel})
                </span>
              </>
            ) : (
              <>
                <Wrench className="h-4 w-4 text-sky-300" />
                <span>{message.toolName ?? "Tool"}</span>
              </>
            )}
          </div>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              isExpanded(`tool:${message.id}`) ? "rotate-180" : ""
            }`}
          />
        </button>
        {isExpanded(`tool:${message.id}`) ? (
          <div className="max-h-44 max-w-full overflow-auto rounded-lg border border-border/60 bg-background/60 p-3">
            {isListDirMessage ? (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">
                  Giữ Shift rồi rê chuột vào tên file để mở bằng tab mới.
                </div>
                <div className="space-y-1">
                  {listDirEntries.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      className={`flex w-full items-center rounded-md px-2 py-1 text-left text-sm leading-6 transition-colors ${
                        entry.isDir
                          ? "cursor-default text-sky-100 hover:bg-transparent"
                          : "text-foreground hover:bg-sky-500/10"
                      }`}
                      style={{
                        paddingLeft: `${entry.depth * 14 + 8}px`,
                      }}
                      onMouseEnter={(event) => handleListDirHover(event, entry)}
                      title={
                        entry.isDir
                          ? entry.filePath
                          : `${entry.filePath}\nShift + hover để mở tab mới`
                      }
                    >
                      <span className="min-w-0 break-all [overflow-wrap:anywhere]">
                        {entry.label}
                        {entry.isDir ? "/" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                {message.content}
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderActionBody(item: ActionItem) {
    if (item.kind === "thinking") {
      return renderThinkingBody(item.message);
    }

    return renderToolBody(item.message);
  }

  function renderMessageAttachments(attachments: readonly MessageAttachment[]) {
    return (
      <div className="mb-2 grid grid-cols-1 gap-2 rounded-xl border border-sky-400/20 bg-sky-500/5 p-2">
        {attachments.map((attachment) => (
          <div
            key={`${attachment.attachmentId}-${attachment.label}`}
            className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 rounded-2xl border border-white/10 bg-background/70 px-3 py-2 text-xs text-foreground"
          >
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white/5"
              disabled={!attachment.previewDataUrl}
              onClick={() => {
                if (attachment.previewDataUrl) {
                  setPreviewAsset({
                    title: attachment.label,
                    imageUrl: attachment.previewDataUrl,
                  });
                }
              }}
              title={attachment.previewDataUrl ? "Xem preview" : attachment.label}
            >
              {attachment.previewDataUrl ? (
                <img
                  src={attachment.previewDataUrl}
                  alt={attachment.label}
                  className="h-full w-full object-cover"
                />
              ) : attachment.kind === "figma" || attachment.kind === "image" ? (
                <ImageIcon className="h-4 w-4 text-muted-foreground" />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            <div className="truncate text-sm" title={attachment.label}>
              {attachment.label}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const renderItems = buildRenderItems(messages, activeShellSessions);
  const trimmedInput = input.trim();
  const canSend =
    trimmedInput.length > 0 ||
    figmaAttachments.length > 0 ||
    localAttachments.length > 0;
  const slashQuery = trimmedInput.startsWith("/")
    ? trimmedInput.slice(1).toLowerCase()
    : "";
  const slashCommands =
    trimmedInput.startsWith("/")
      ? SLASH_COMMANDS.filter((command) =>
          command.label.slice(1).startsWith(slashQuery)
        )
      : [];

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-screen flex-col gap-2 overflow-hidden bg-[linear-gradient(180deg,#08111f_0%,#0b1220_100%)]">
        {errorText ? (
          <div className="mx-2 mt-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-3 text-sm text-rose-100">
            <div className="font-medium text-rose-200">
              {classifyErrorTitle(errorText)}
            </div>
            <div className="mt-1 text-rose-100/90">{errorText}</div>
            {retryRequest ? (
              <button
                type="button"
                className="mt-3 inline-flex items-center rounded-full border border-rose-400/30 bg-transparent px-3 py-1.5 text-sm text-rose-100 transition-colors hover:bg-rose-500/10"
                onClick={retryLastRequest}
              >
                Thử lại
              </button>
            ) : null}
          </div>
        ) : null}

        <Card className="flex-1 min-h-0 overflow-hidden rounded-none border-x-0 border-y-0">
          <CardContent className="flex flex-col h-full min-h-0 gap-2 p-0">
            <ScrollArea
              ref={scrollAreaRef}
              className="flex-1 min-h-0 overflow-x-hidden rounded-xl border border-border/60 bg-background/70"
            >
              <div className="min-w-0 max-w-full overflow-x-hidden p-3 space-y-3">
                {renderItems.map((item) => {
                  if (item.type === "live-shell") {
                    return (
                      <div
                        key={item.key}
                        className="mr-auto w-full min-w-0 max-w-[96%] overflow-x-hidden"
                      >
                        {renderShellPanel({
                          panelId: `live-shell:${item.session.toolCallId}`,
                          commandText: item.session.commandText,
                          cwd: item.session.cwd,
                          output: item.session.output,
                          success: item.session.success,
                          exitCode: item.session.exitCode,
                          durationLabel:
                            getActiveShellDuration(item.session) || undefined,
                          running:
                            typeof item.session.durationMs !== "number",
                        })}
                      </div>
                    );
                  }

                  if (item.type === "actions") {
                    if (item.items.length === 1) {
                      return (
                        <div key={item.key} className="mr-auto w-full max-w-[96%] min-w-0">
                          {renderActionBody(item.items[0]!)}
                        </div>
                      );
                    }

                    const expanded = isExpanded(`actions:${item.key}`);
                    return (
                      <div key={item.key} className="mr-auto w-full max-w-[96%] min-w-0 overflow-x-hidden">
                        <div className="space-y-2">
                          <button
                            type="button"
                            className="flex w-full min-w-0 items-center justify-between rounded-[18px] border border-white/10 bg-white/5 px-3 py-2 text-left"
                            onClick={() => toggleExpanded(`actions:${item.key}`)}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="flex items-center gap-1">
                                {item.items
                                  .slice(0, 5)
                                  .map((action, index) =>
                                    renderActionIcon(
                                      action,
                                      `${item.key}-${action.key}-${index}`
                                    )
                                  )}
                              </div>
                              <span className="min-w-0 max-w-full break-all text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                                {expanded ? "Thu gọn" : `${item.items.length} actions`}
                              </span>
                            </div>
                            <ChevronDown
                              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                                expanded ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                          {expanded ? (
                            <div className="space-y-2">
                              {item.items.map((action) => (
                                <div key={action.key}>{renderActionBody(action)}</div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  }

                  const message = item.message;
                  if (message.role === "assistant" && !message.content.trim()) {
                    return null;
                  }
                  const messageAttachments =
                    message.attachments ??
                    message.figmaAttachments?.map((attachment) =>
                      Object.freeze({
                        attachmentId: attachment.attachmentId ?? attachment.importId,
                        kind: "figma" as const,
                        label: "Design By Figma",
                        ...(attachment.previewDataUrl
                          ? { previewDataUrl: attachment.previewDataUrl }
                          : {}),
                        importId: attachment.importId,
                      })
                    ) ??
                    [];
                  return (
                    <div
                      key={item.key}
                      className={`w-full min-w-0 max-w-full overflow-x-hidden ${
                        message.role === "user"
                          ? `ml-auto max-w-[92%] rounded-xl border border-primary/30 bg-primary/10 px-3 py-3 ${
                              pendingMessageId === message.id
                                ? "opacity-50"
                                : ""
                            }`
                          : message.role === "tool"
                          ? "mr-auto max-w-[96%]"
                          : "mr-auto max-w-[96%] rounded-xl border border-border/60 bg-background/80 px-3 py-3"
                      }`}
                    >
                      {message.role !== "tool" ? (
                        <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                          <span>
                            {message.role === "assistant"
                              ? getAssistantLabel(message.agentType)
                              : "User"}
                          </span>
                          <div className="flex items-center gap-2">
                            {pendingMessageId === message.id ? (
                              <span className="normal-case tracking-normal text-[12px] text-sky-300">
                                Đang gửi...
                              </span>
                            ) : null}
                            <span>
                              {new Date(message.timestamp).toLocaleTimeString()}
                            </span>
                            <button
                              type="button"
                              className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                              onClick={() => toggleMessageExpanded(message.id)}
                              title={isMessageExpanded(message.id) ? "Thu gọn" : "Phóng to"}
                            >
                              {isMessageExpanded(message.id) ? (
                                <Minimize2 className="h-3.5 w-3.5" />
                              ) : (
                                <Maximize2 className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {messageAttachments.length > 0
                        ? renderMessageAttachments(messageAttachments)
                        : null}
                      {message.role === "tool" ? renderToolBody(message) : isMessageExpanded(message.id) ? (
                        <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                          {message.content}
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                {streamingAssistant ? (
                  <div className="mr-auto w-full min-w-0 max-w-[96%] overflow-x-hidden rounded-xl border border-border/60 bg-background/80 px-3 py-3">
                    <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      <span>{getAssistantLabel(selectedAgent)}</span>
                      <Spinner size="sm" />
                    </div>
                    <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                      {streamingAssistant}
                    </div>
                  </div>
                ) : null}

                {streamingThinking ? (
                  <div className="mr-auto w-full min-w-0 max-w-[96%] overflow-x-hidden">
                    <div className="space-y-2">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-left"
                        onClick={() => toggleExpanded("thinking:streaming")}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                          <Brain className="w-4 h-4 text-violet-300" />
                          <span>Thinking</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Spinner size="sm" className="h-3.5 w-3.5 border-[1.5px]" />
                          <ChevronDown
                            className={`h-4 w-4 text-muted-foreground transition-transform ${
                              isExpanded("thinking:streaming") ? "rotate-180" : ""
                            }`}
                          />
                        </div>
                      </button>
                      {isExpanded("thinking:streaming") ? (
                        <div className="max-h-36 overflow-auto rounded-lg border border-border/60 bg-background/60 p-3">
                          <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                            {streamingThinking}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </ScrollArea>

            <div className="sticky bottom-0 mt-auto space-y-2 rounded-[20px] border border-white/10 bg-white/5 p-2.5 shadow-[0_16px_40px_rgba(0,0,0,0.28)] backdrop-blur-xl">
              {changeSummary.fileCount > 0 ? (
                <div className="flex items-center justify-between gap-3 rounded-[18px] border border-white/10 bg-white/5 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {changeSummary.createdCount > 0
                        ? `${changeSummary.fileCount} file thay đổi • ${changeSummary.createdCount} file mới`
                        : `${changeSummary.fileCount} file thay đổi`}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <span className="text-emerald-400">+{changeSummary.addedLines}</span>
                      <span className="mx-2 text-rose-400">-{changeSummary.deletedLines}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
                      onClick={() =>
                        postHostMessage({ type: "revert-all-changes" } satisfies WebviewMessage)
                      }
                    >
                      <Undo2 className="h-4 w-4" />
                      <span>Revert</span>
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full bg-transparent px-2 py-1 text-sm text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
                      onClick={() =>
                        postHostMessage({ type: "review-open" } satisfies WebviewMessage)
                      }
                    >
                      <span>Review</span>
                      <ExternalLink className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ) : null}
              {figmaAttachments.length > 0 || localAttachments.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 rounded-xl border border-sky-400/20 bg-sky-500/5 p-2">
                  {figmaAttachments.map((attachment) => (
                    <div
                      key={attachment.importId}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-sky-400/30 bg-background/70 px-3 py-2 text-xs text-foreground"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-300">
                          <ImageIcon className="h-4 w-4" />
                        </div>
                        <button
                          type="button"
                          className="truncate text-left font-medium text-sky-300 hover:text-sky-200"
                          onClick={() => openFigmaPreview(attachment)}
                        >
                          Design By Figma
                        </button>
                      </div>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          removeFigmaAttachment(attachment.importId)
                        }
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  {localAttachments.map((attachment) => (
                    <div
                      key={attachment.attachmentId}
                      className="grid grid-cols-[40px_minmax(0,1fr)_20px] items-center gap-3 rounded-2xl border border-white/10 bg-background/70 px-3 py-2 text-xs text-foreground"
                    >
                      <button
                        type="button"
                        className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white/5"
                        onClick={() => {
                          if (attachment.previewUrl) {
                            setPreviewAsset({
                              title: attachment.name,
                              imageUrl: attachment.previewUrl,
                            });
                          }
                        }}
                        disabled={!attachment.previewUrl}
                        title={attachment.previewUrl ? "Xem preview" : attachment.name}
                      >
                        {attachment.previewUrl ? (
                          <img
                            src={attachment.previewUrl}
                            alt={attachment.name}
                            className="h-full w-full object-cover"
                          />
                        ) : attachment.isImage ? (
                          <ImageIcon className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <FileText className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                      <div className="truncate text-sm" title={attachment.name}>
                        {attachment.name}
                      </div>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          removeLocalAttachment(attachment.attachmentId)
                        }
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <Textarea
                ref={textareaRef}
                placeholder="Ask Galaxy Code..."
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={handleComposerPaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (event.shiftKey) {
                      const target = event.currentTarget;
                      const { selectionStart, selectionEnd, value } = target;
                      const nextValue =
                        value.slice(0, selectionStart) +
                        "\n" +
                        value.slice(selectionEnd);
                      setInput(nextValue);
                      queueMicrotask(() => {
                        target.selectionStart = target.selectionEnd =
                          selectionStart + 1;
                      });
                      return;
                    }

                    if (slashCommands.length > 0) {
                      executeSlashCommand(slashCommands[0]!.id);
                      return;
                    }

                    sendMessage();
                  }
                }}
                rows={1}
                className="h-10 min-h-[40px] overflow-hidden resize-none border-0 bg-transparent px-0 py-2 text-sm leading-6 shadow-none outline-none ring-0 focus-visible:ring-0"
              />

              {slashCommands.length > 0 ? (
                <div className="rounded-2xl border border-white/10 bg-[#111a2c]/95 p-2 shadow-2xl backdrop-blur-xl">
                  <div className="space-y-1">
                    {slashCommands.map((command) => (
                      <button
                        key={command.id}
                        type="button"
                        className="flex w-full items-start justify-between rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/5"
                        onClick={() => executeSlashCommand(command.id)}
                      >
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            {command.label}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {command.description}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <button
                      type="button"
                      className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
                      onClick={() => setIsPlusMenuOpen((current) => !current)}
                      title="Mở menu thêm"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    {isPlusMenuOpen ? (
                      <div className="absolute bottom-12 left-0 z-30 w-56 rounded-[18px] border border-white/10 bg-[#111a2c]/95 p-2 shadow-2xl backdrop-blur-xl">
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-white/5"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Paperclip className="h-4 w-4 text-muted-foreground" />
                          <span>Thêm ảnh và file</span>
                        </button>
                        <div className="my-2 border-t border-white/10" />
                        <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm text-foreground transition-colors hover:bg-white/5">
                          <span>Review</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={qualityPreferences.reviewEnabled}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                              qualityPreferences.reviewEnabled
                                ? "bg-sky-500"
                                : "bg-white/15"
                            }`}
                            onClick={() =>
                              updateQualityPreferences({
                                ...qualityPreferences,
                                reviewEnabled: !qualityPreferences.reviewEnabled,
                              })
                            }
                          >
                            <span
                              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                                qualityPreferences.reviewEnabled
                                  ? "translate-x-5"
                                  : "translate-x-0.5"
                              }`}
                            />
                          </button>
                        </label>
                        <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm text-foreground transition-colors hover:bg-white/5">
                          <span>Validate</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={qualityPreferences.validateEnabled}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                              qualityPreferences.validateEnabled
                                ? "bg-sky-500"
                                : "bg-white/15"
                            }`}
                            onClick={() =>
                              updateQualityPreferences({
                                ...qualityPreferences,
                                validateEnabled: !qualityPreferences.validateEnabled,
                              })
                            }
                          >
                            <span
                              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                                qualityPreferences.validateEnabled
                                  ? "translate-x-5"
                                  : "translate-x-0.5"
                              }`}
                            />
                          </button>
                        </label>
                      </div>
                    ) : null}
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={handleFileSelection}
                    />
                  </div>
                  <div className="relative w-[116px]">
                    <select
                      value={selectedAgent}
                      onChange={(event) =>
                        setSelectedAgent(event.target.value as AgentType)
                      }
                      className="h-10 w-full appearance-none rounded-[16px] bg-transparent px-4 pr-10 text-base text-foreground outline-none transition-colors hover:bg-[rgba(255,255,255,0.15)] focus:bg-[rgba(255,255,255,0.12)]"
                    >
                      {AGENTS.map((agent) => (
                        <option key={agent} value={agent}>
                          {agent}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                  <div
                    className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                    style={{
                      background: `conic-gradient(rgb(56 189 248) ${tokenUsageDegrees}deg, rgba(255,255,255,0.1) ${tokenUsageDegrees}deg 360deg)`,
                    }}
                    title={`${promptTokens} / ${MAX_CONTEXT_TOKENS} tokens`}
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1e293b] text-[10px] font-semibold text-foreground">
                      {`${tokenUsagePercent}%`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={sendMessage}
                    disabled={!canSend || isRunning}
                    size="icon"
                    className="shrink-0"
                  >
                    <SendHorizontal className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {previewAsset ? (
          <div className="absolute inset-0 z-40 flex items-center justify-center px-3 py-6 bg-black/55 backdrop-blur-sm">
            <Card className="w-full max-w-3xl border-border/80 bg-card/95">
              <CardHeader className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>{previewAsset.title}</CardTitle>
                  <Button
                    variant="outline"
                    onClick={() => setPreviewAsset(null)}
                  >
                    Close
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-3">
                {previewAsset.imageUrl ? (
                  <img
                    src={previewAsset.imageUrl}
                    alt={previewAsset.title}
                    className="max-h-[70vh] w-full rounded-lg object-contain"
                  />
                ) : (
                  <div className="px-4 py-12 text-sm text-center border border-dashed rounded-xl border-border/60 text-muted-foreground">
                    No preview asset is available for this Figma import.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {approvalRequest ? (
          <div className="absolute bottom-32 left-3 right-3 z-50 flex justify-start pointer-events-none">
            <Card className="pointer-events-auto w-full max-w-md border-border/80 bg-card/95 shadow-2xl backdrop-blur-xl">
              <CardHeader className="space-y-2 pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">{approvalRequest.title}</CardTitle>
                  <Badge variant="secondary">{approvalRequest.toolName}</Badge>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  {approvalRequest.message}
                </p>
              </CardHeader>
              <CardContent className="space-y-3 p-3 pt-0">
                {approvalRequest.details.map((detail, index) => (
                  <div
                    key={`${approvalRequest.requestId}-${index}`}
                    className="rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm leading-6"
                  >
                    {detail}
                  </div>
                ))}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => respondToApproval("deny")}
                  >
                    Từ chối
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => respondToApproval("ask")}
                  >
                    Hỏi lại
                  </Button>
                  <Button onClick={() => respondToApproval("allow")}>
                    Cho phép luôn
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
