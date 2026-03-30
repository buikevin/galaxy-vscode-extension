/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Composer-only context used by the Galaxy Code webview to avoid prop drilling in the sticky composer area.
 */

import {
  createContext,
  useContext,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type {
  AgentType,
  ChangeSummary,
  ExtensionToolGroup,
  FigmaAttachment,
  QualityDetails,
  QualityPreferences,
  ToolCapabilities,
  ToolToggles,
} from "@shared/protocol";
import type { LocalAttachment } from "@webview/entities/attachments";

/**
 * One slash-command suggestion rendered below the composer textarea.
 */
export type SlashCommandItem = Readonly<{
  /** Stable command identifier used by the host command handler. */
  id: "config" | "reset" | "clear";
  /** Command label shown to the user. */
  label: string;
  /** Short description explaining what the command does. */
  description: string;
}>;

/**
 * Composer-related state and actions shared with the sticky composer panel.
 */
export type ComposerContextValue = Readonly<{
  /** Whether the current change summary card should be visible. */
  showChangeSummaryBox: boolean;
  /** Current session-level change summary. */
  changeSummary: ChangeSummary;
  /** Attached Figma design references. */
  figmaAttachments: readonly FigmaAttachment[];
  /** Attached local files and images pending send. */
  localAttachments: readonly LocalAttachment[];
  /** Current composer input text. */
  input: string;
  /** Slash-command suggestions filtered from the current input. */
  slashCommands: readonly SlashCommandItem[];
  /** Currently selected agent. */
  selectedAgent: AgentType;
  /** Available agents shown in the select box. */
  agents: readonly AgentType[];
  /** Review/validate/full-access preferences. */
  qualityPreferences: QualityPreferences;
  /** Latest quality output including persisted review findings. */
  qualityDetails: QualityDetails;
  /** Capability groups shown in Configure Tools. */
  toolCapabilities: ToolCapabilities;
  /** Individual tool toggles shown inside each capability group. */
  toolToggles: ToolToggles;
  /** Public tools discovered from installed VS Code extensions. */
  extensionToolGroups: readonly ExtensionToolGroup[];
  /** Individual toggles for discovered extension tools. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Whether the plus-menu popup is currently visible. */
  isPlusMenuOpen: boolean;
  /** Whether a request is currently running. */
  isRunning: boolean;
  /** Human-readable activity label shown while the agent is still busy. */
  activityLabel: string;
  /** Whether the send button should be enabled. */
  canSend: boolean;
  /** Ref passed into the composer textarea for autosize/focus behavior. */
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** Ref passed into the hidden file input owned by the plus menu. */
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  /** Anchor ref used to detect outside clicks for the plus menu. */
  plusMenuAnchorRef: MutableRefObject<HTMLDivElement | null>;
  /** Accept the current diff and hide the summary card. */
  onKeepChanges: () => void;
  /** Revert all current workspace changes. */
  onRevertAll: () => void;
  /** Open the Galaxy Diff review panel. */
  onReview: () => void;
  /** Dismiss one review finding from the latest review result. */
  onDismissReviewFinding: (findingId: string) => void;
  /** Run a focused repair turn for one review finding. */
  onApplyReviewFinding: (findingId: string) => void;
  /** Open preview for one attached Figma design. */
  onOpenFigmaPreview: (attachment: FigmaAttachment) => void;
  /** Remove one Figma attachment from the composer. */
  onRemoveFigmaAttachment: (importId: string) => void;
  /** Open preview for one local attachment when preview is available. */
  onOpenLocalPreview: (attachment: LocalAttachment) => void;
  /** Remove one local attachment from the composer. */
  onRemoveLocalAttachment: (attachmentId: string) => void;
  /** Update composer input text. */
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  /** Handle paste events for attachment ingestion. */
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Handle keydown logic for send/newline/slash command execution. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Toggle the plus-menu popup. */
  onTogglePlusMenu: () => void;
  /** Open the native file picker. */
  onOpenFilePicker: () => void;
  /** Apply new quality preference values. */
  onUpdateQualityPreferences: (next: QualityPreferences) => void;
  /** Apply new tool capability values. */
  onUpdateToolCapabilities: (next: ToolCapabilities) => void;
  /** Apply new tool toggle values. */
  onUpdateToolToggles: (next: ToolToggles) => void;
  /** Apply new extension-tool toggle values. */
  onUpdateExtensionToolToggles: (next: Readonly<Record<string, boolean>>) => void;
  /** Handle actual file-input change events. */
  onFileSelection: (event: ChangeEvent<HTMLInputElement>) => void;
  /** Update the selected agent. */
  onSelectedAgentChange: (agent: AgentType) => void;
  /** Execute one slash command from the suggestion list. */
  onExecuteSlashCommand: (id: SlashCommandItem["id"]) => void;
  /** Send the current composer payload. */
  onSend: () => void;
}>;

const ComposerViewContext = createContext<ComposerContextValue | null>(null);

/**
 * Provide composer state to descendant components.
 */
export function ComposerViewProvider(props: Readonly<{
  /** Shared composer state exposed to descendants. */
  value: ComposerContextValue;
  /** Child nodes that need access to the composer context. */
  children: ReactNode;
}>) {
  return (
    <ComposerViewContext.Provider value={props.value}>
      {props.children}
    </ComposerViewContext.Provider>
  );
}

/**
 * Read the composer-specific context and fail loudly when the provider is missing.
 */
export function useComposerContext(): ComposerContextValue {
  const value = useContext(ComposerViewContext);
  if (!value) {
    throw new Error(
      "useComposerContext must be used within ComposerViewProvider"
    );
  }
  return value;
}
