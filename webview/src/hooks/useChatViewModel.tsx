/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Hook that derives view state and UI wiring values so App.tsx can stay focused on state ownership and host integration.
 */

import type { Dispatch, MouseEvent, MutableRefObject, ReactNode, RefObject, SetStateAction } from "react";
import { ActionIcon } from "@webview/components/chat/ActionIcon";
import type {
  AgentType,
  ChangeSummary,
  ExtensionToolGroup,
  FigmaAttachment,
  QualityDetails,
  QualityPreferences,
  ToolCapabilities,
  ToolToggles,
  WebviewMessage,
} from "@shared/protocol";
import type { LocalAttachment, PreviewAsset } from "@webview/entities/attachments";
import type {
  ActionItem,
  ActiveShellSession,
  ListDirEntry,
  PendingRequest,
  RenderItem,
} from "@webview/entities/chat";
import type {
  ComposerContextValue,
  SlashCommandItem,
} from "@webview/context/ComposerViewContext";
import type { TranscriptContextValue } from "@webview/context/TranscriptViewContext";
import { useToolRenderers } from "@webview/hooks/useToolRenderers";
import { buildRenderItems, getAssistantLabel } from "@webview/lib/transcript-render";
import { postHostMessage } from "@webview/vscode";

/**
 * Dependencies required to derive the chat view model.
 */
type UseChatViewModelOptions = Readonly<{
  /** Selected agent in the composer. */
  selectedAgent: AgentType;
  /** Currently selected workspace files. */
  selectedFiles: readonly string[];
  /** Current composer input text. */
  input: string;
  /** Whether an agent request is currently running. */
  isRunning: boolean;
  /** Current host-provided run status text. */
  statusText: string;
  /** Current error banner text. */
  errorText: string;
  /** Pending retryable request, when available. */
  retryRequest: PendingRequest | null;
  /** Streaming assistant content. */
  streamingAssistant: string;
  /** Streaming thinking content. */
  streamingThinking: string;
  /** Prompt token count for the current turn. */
  promptTokens: number;
  /** Attached Figma design references. */
  figmaAttachments: readonly FigmaAttachment[];
  /** Attached local files/images. */
  localAttachments: readonly LocalAttachment[];
  /** Current shell copied-message id. */
  copiedCommandMessageId: string | null;
  /** Active shell sessions mirrored from the host. */
  activeShellSessions: readonly ActiveShellSession[];
  /** Timestamp used to compute live shell durations. */
  shellNow: number;
  /** Review/validate/full-access settings mirrored from the host. */
  qualityPreferences: QualityPreferences;
  /** Latest quality details including persisted review findings. */
  qualityDetails: QualityDetails;
  /** Capability groups shown in Configure Tools. */
  toolCapabilities: ToolCapabilities;
  /** Individual tool toggles shown inside each capability group. */
  toolToggles: ToolToggles;
  /** Discovered extension tool groups rendered below built-in groups. */
  extensionToolGroups: readonly ExtensionToolGroup[];
  /** Individual extension tool toggles. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Expanded grouped-action/tool ids. */
  expandedItems: readonly string[];
  /** Expanded message ids. */
  expandedMessages: readonly string[];
  /** Current session change summary. */
  changeSummary: ChangeSummary;
  /** Current kept summary cache key. */
  keptChangeSummaryKey: string;
  /** Whether the plus menu is open. */
  isPlusMenuOpen: boolean;
  /** Pending user message id. */
  pendingMessageId: string | null;
  /** Raw transcript messages. */
  messages: Parameters<typeof buildRenderItems>[0];
  /** Scroll-area ref used by the transcript. */
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  /** Composer textarea ref. */
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** Hidden file input ref. */
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  /** Plus-menu anchor ref. */
  plusMenuAnchorRef: MutableRefObject<HTMLDivElement | null>;
  /** Shell output node registry used for auto-scroll. */
  shellOutputRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  /** Update copied shell message state. */
  setCopiedCommandMessageId: Dispatch<SetStateAction<string | null>>;
  /** Update preview modal state. */
  setPreviewAsset: Dispatch<SetStateAction<PreviewAsset | null>>;
  /** Update current error banner text. */
  setErrorText: Dispatch<SetStateAction<string>>;
  /** Update expanded grouped-action/tool ids. */
  setExpandedItems: Dispatch<SetStateAction<string[]>>;
  /** Update expanded message ids. */
  setExpandedMessages: Dispatch<SetStateAction<string[]>>;
  /** Update kept summary cache key. */
  setKeptChangeSummaryKey: Dispatch<SetStateAction<string>>;
  /** Update plus-menu visibility. */
  setIsPlusMenuOpen: Dispatch<SetStateAction<boolean>>;
  /** Update composer input text. */
  setInput: Dispatch<SetStateAction<string>>;
  /** Update selected agent. */
  setSelectedAgent: Dispatch<SetStateAction<AgentType>>;
  /** Send current message through the host. */
  sendMessage: () => void;
  /** Retry the last retryable request. */
  retryLastRequest: () => void;
  /** Open a Figma preview from the composer. */
  openFigmaPreview: (attachment: FigmaAttachment) => void;
  /** Remove one Figma attachment from the composer. */
  removeFigmaAttachment: (importId: string) => void;
  /** Remove one local attachment from the composer. */
  removeLocalAttachment: (attachmentId: string) => void;
  /** Handle hidden file-input selections. */
  handleFileSelection: ComposerContextValue["onFileSelection"];
  /** Handle composer paste events. */
  handleComposerPaste: ComposerContextValue["onPaste"];
  /** Update quality preferences. */
  updateQualityPreferences: (next: QualityPreferences) => void;
  /** Update tool capability preferences. */
  updateToolCapabilities: (next: ToolCapabilities) => void;
  /** Update individual tool preferences. */
  updateToolToggles: (next: ToolToggles) => void;
  /** Update extension-tool preferences. */
  updateExtensionToolToggles: (next: Readonly<Record<string, boolean>>) => void;
  /** Execute one slash command suggestion. */
  executeSlashCommand: (id: SlashCommandItem["id"]) => void;
  /** Available slash-command suggestions. */
  slashCommandSource: readonly SlashCommandItem[];
  /** Available agent options. */
  agents: readonly AgentType[];
  /** Max supported context token budget. */
  maxContextTokens: number;
}>;

/**
 * Final view model returned to App.tsx.
 */
type ChatViewModel = Readonly<{
  /** Title chosen for the current error banner. */
  errorTitle: string;
  /** Whether the change summary card should be shown. */
  showChangeSummaryBox: boolean;
  /** Circular token usage percentage. */
  tokenUsagePercent: number;
  /** Circular token usage degrees. */
  tokenUsageDegrees: number;
  /** Filtered slash command suggestions. */
  slashCommands: readonly SlashCommandItem[];
  /** Flattened render items consumed by the transcript. */
  renderItems: readonly RenderItem[];
  /** Retry action mirrored for the top error banner. */
  retryLastRequest: () => void;
  /** Composer context value passed into the composer provider. */
  composerContextValue: ComposerContextValue;
  /** Transcript context value passed into the transcript provider. */
  transcriptContextValue: TranscriptContextValue;
}>;

/**
 * Derive the presentation-focused chat view model from App state.
 */
export function useChatViewModel(options: UseChatViewModelOptions): ChatViewModel {
  const changeSummaryKey = [
    options.changeSummary.fileCount,
    options.changeSummary.createdCount,
    options.changeSummary.addedLines,
    options.changeSummary.deletedLines,
    ...options.changeSummary.files.map(
      (file) =>
        `${file.filePath}:${file.wasNew ? "new" : "existing"}:${file.addedLines}:${file.deletedLines}`
    ),
  ].join("|");

  const showChangeSummaryBox =
    options.changeSummary.fileCount > 0 &&
    changeSummaryKey !== options.keptChangeSummaryKey;

  function keepCurrentChangeSummary(): void {
    if (options.changeSummary.fileCount === 0) {
      return;
    }
    options.setKeptChangeSummaryKey(changeSummaryKey);
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

  function toggleExpanded(key: string): void {
    options.setExpandedItems((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    );
  }

  function isExpanded(key: string): boolean {
    return options.expandedItems.includes(key);
  }

  function toggleMessageExpanded(messageId: string): void {
    options.setExpandedMessages((current) =>
      current.includes(messageId)
        ? current.filter((item) => item !== messageId)
        : [...current, messageId]
    );
  }

  function isMessageExpanded(messageId: string): boolean {
    return !options.expandedMessages.includes(messageId);
  }

  function openFile(filePath: string): void {
    postHostMessage({
      type: "file-open",
      payload: { filePath },
    } satisfies WebviewMessage);
  }

  function handleListDirHover(
    event: MouseEvent<HTMLButtonElement>,
    entry: ListDirEntry
  ): void {
    if (event.shiftKey && !entry.isDir) {
      openFile(entry.filePath);
    }
  }

  function renderActionIcon(
    item: ActionItem,
    key: string,
    sizeClass = "h-4 w-4"
  ): ReactNode {
    return (
      <span key={key}>
        <ActionIcon item={item} sizeClass={sizeClass} />
      </span>
    );
  }

  function openShellTerminal(toolCallId: string): void {
    postHostMessage({
      type: "shell-open-terminal",
      payload: { toolCallId },
    } satisfies WebviewMessage);
  }

  const toolRenderers = useToolRenderers({
    copiedCommandMessageId: options.copiedCommandMessageId,
    setCopiedCommandMessageId: options.setCopiedCommandMessageId,
    setErrorText: options.setErrorText,
    expandedItems: options.expandedItems,
    toggleExpanded,
    openFile,
    handleListDirHover,
    shellOutputRefs: options.shellOutputRefs,
    shellNow: options.shellNow,
    openShellTerminal,
  });

  function renderActionBody(item: ActionItem): ReactNode {
    return toolRenderers.renderActionBody(item);
  }

  const renderItems = buildRenderItems(
    options.messages,
    options.activeShellSessions
  );

  const trimmedInput = options.input.trim();
  const canSend =
    trimmedInput.length > 0 ||
    options.figmaAttachments.length > 0 ||
    options.localAttachments.length > 0;
  const slashQuery = trimmedInput.startsWith("/")
    ? trimmedInput.slice(1).toLowerCase()
    : "";
  const slashCommands = trimmedInput.startsWith("/")
    ? options.slashCommandSource.filter((command) =>
        command.label.slice(1).startsWith(slashQuery)
      )
    : [];

  const tokenUsagePercent = Math.max(
    0,
    Math.min(
      100,
      Math.round((options.promptTokens / options.maxContextTokens) * 100)
    )
  );
  const tokenUsageDegrees = Math.max(
    0,
    Math.min(
      360,
      Math.round((options.promptTokens / options.maxContextTokens) * 360)
    )
  );

  function buildActivityLabel(statusText: string, isRunning: boolean): string {
    if (!isRunning) {
      return "";
    }

    const normalized = statusText.trim().toLowerCase();
    if (normalized.includes("review quality gate") || normalized.includes("running code review")) {
      return "Đang review code";
    }
    if (normalized.includes("validation quality gate") || normalized.includes("running final validation")) {
      return "Đang validate code";
    }
    return "Thinking";
  }

  const activityLabel = buildActivityLabel(
    options.statusText,
    options.isRunning
  );

  const composerContextValue: ComposerContextValue = {
    showChangeSummaryBox,
    changeSummary: options.changeSummary,
    figmaAttachments: options.figmaAttachments,
    localAttachments: options.localAttachments,
    input: options.input,
    slashCommands,
    selectedAgent: options.selectedAgent,
    agents: options.agents,
    qualityPreferences: options.qualityPreferences,
    qualityDetails: options.qualityDetails,
    toolCapabilities: options.toolCapabilities,
    toolToggles: options.toolToggles,
    extensionToolGroups: options.extensionToolGroups,
    extensionToolToggles: options.extensionToolToggles,
    isPlusMenuOpen: options.isPlusMenuOpen,
    promptTokens: options.promptTokens,
    tokenUsagePercent,
    tokenUsageDegrees,
    maxContextTokens: options.maxContextTokens,
    isRunning: options.isRunning,
    activityLabel,
    canSend,
    textareaRef: options.textareaRef,
    fileInputRef: options.fileInputRef,
    plusMenuAnchorRef: options.plusMenuAnchorRef,
    onKeepChanges: keepCurrentChangeSummary,
    onRevertAll: () =>
      postHostMessage({ type: "revert-all-changes" } satisfies WebviewMessage),
    onReview: () =>
      postHostMessage({ type: "review-open" } satisfies WebviewMessage),
    onDismissReviewFinding: (findingId) =>
      postHostMessage({
        type: "review-finding-dismiss",
        payload: { findingId },
      } satisfies WebviewMessage),
    onApplyReviewFinding: (findingId) =>
      postHostMessage({
        type: "review-finding-apply",
        payload: { findingId },
      } satisfies WebviewMessage),
    onOpenFigmaPreview: options.openFigmaPreview,
    onRemoveFigmaAttachment: options.removeFigmaAttachment,
    onOpenLocalPreview: (attachment) => {
      if (!attachment.previewUrl) {
        return;
      }
      options.setPreviewAsset({
        title: attachment.name,
        imageUrl: attachment.previewUrl,
      });
    },
    onRemoveLocalAttachment: options.removeLocalAttachment,
    onInputChange: (event) => options.setInput(event.target.value),
    onPaste: options.handleComposerPaste,
    onKeyDown: (event) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (event.shiftKey) {
          const target = event.currentTarget;
          const { selectionStart, selectionEnd, value } = target;
          const nextValue =
            value.slice(0, selectionStart) +
            "\n" +
            value.slice(selectionEnd);
          options.setInput(nextValue);
          queueMicrotask(() => {
            target.selectionStart = target.selectionEnd = selectionStart + 1;
          });
          return;
        }

        if (slashCommands.length > 0) {
          options.executeSlashCommand(slashCommands[0]!.id);
          return;
        }

        options.sendMessage();
      }
    },
    onTogglePlusMenu: () =>
      options.setIsPlusMenuOpen((current) => !current),
    onOpenFilePicker: () => options.fileInputRef.current?.click(),
    onUpdateQualityPreferences: options.updateQualityPreferences,
    onUpdateToolCapabilities: options.updateToolCapabilities,
    onUpdateToolToggles: options.updateToolToggles,
    onUpdateExtensionToolToggles: options.updateExtensionToolToggles,
    onFileSelection: options.handleFileSelection,
    onSelectedAgentChange: options.setSelectedAgent,
    onExecuteSlashCommand: options.executeSlashCommand,
    onSend: options.sendMessage,
  };

  const transcriptContextValue: TranscriptContextValue = {
    scrollAreaRef: options.scrollAreaRef,
    renderItems,
    pendingMessageId: options.pendingMessageId,
    streamingAssistant: options.streamingAssistant,
    streamingThinking: options.streamingThinking,
    selectedAgent: options.selectedAgent,
    getAssistantLabel: (agentType) =>
      getAssistantLabel(options.selectedAgent, agentType),
    isExpanded,
    toggleExpanded,
    isMessageExpanded,
    toggleMessageExpanded,
    renderShellSession: toolRenderers.renderShellSession,
    renderActionBody,
    renderActionIcon,
    onOpenMessageAttachmentPreview: (attachment) => {
      if (!attachment.previewDataUrl) {
        return;
      }
      options.setPreviewAsset({
        title: attachment.label,
        imageUrl: attachment.previewDataUrl,
      });
    },
    renderToolBody: toolRenderers.renderToolBody,
  };

  return {
    errorTitle: classifyErrorTitle(options.errorText),
    showChangeSummaryBox,
    tokenUsagePercent,
    tokenUsageDegrees,
    slashCommands,
    renderItems,
    retryLastRequest: options.retryLastRequest,
    composerContextValue,
    transcriptContextValue,
  };
}
