/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Transcript-only context used by the Galaxy Code webview to avoid prop drilling in the transcript area.
 */

import {
  createContext,
  useContext,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  AgentType,
  ChatMessage,
  MessageAttachment,
} from "@shared/protocol";
import type {
  ActionItem,
  ActiveShellSession,
  RenderItem,
} from "@webview/entities/chat";

/**
 * Transcript-related state and callbacks shared with the transcript view.
 */
export type TranscriptContextValue = Readonly<{
  /** Scroll container ref used for transcript auto-scroll. */
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  /** Flattened render items consumed by the transcript. */
  renderItems: readonly RenderItem[];
  /** Pending user message id while a request is in flight. */
  pendingMessageId: string | null;
  /** Streaming assistant content accumulated so far. */
  streamingAssistant: string;
  /** Streaming thinking content accumulated so far. */
  streamingThinking: string;
  /** Currently selected agent in the composer. */
  selectedAgent: AgentType;
  /** Resolve assistant card labels from agent type. */
  getAssistantLabel: (agentType?: AgentType) => string;
  /** Whether a grouped action/thinking block is expanded. */
  isExpanded: (key: string) => boolean;
  /** Toggle one grouped action/thinking block. */
  toggleExpanded: (key: string) => void;
  /** Whether a message card is expanded. */
  isMessageExpanded: (id: string) => boolean;
  /** Toggle one message card expansion state. */
  toggleMessageExpanded: (id: string) => void;
  /** Render one active shell session block. */
  renderShellSession: (session: ActiveShellSession) => ReactNode;
  /** Render one grouped action body. */
  renderActionBody: (item: ActionItem) => ReactNode;
  /** Render one compact grouped action summary row. */
  renderActionSummary: (item: ActionItem) => ReactNode;
  /** Render one action icon preview. */
  renderActionIcon: (item: ActionItem, key: string) => ReactNode;
  /** Open preview for one message attachment. */
  onOpenMessageAttachmentPreview: (attachment: MessageAttachment) => void;
  /** Render one full tool message body. */
  renderToolBody: (message: ChatMessage) => ReactNode;
}>;

const TranscriptViewContext = createContext<TranscriptContextValue | null>(null);

/**
 * Provide transcript state to descendant components.
 */
export function TranscriptViewProvider(props: Readonly<{
  /** Shared transcript state exposed to descendants. */
  value: TranscriptContextValue;
  /** Child nodes that need access to the transcript context. */
  children: ReactNode;
}>) {
  return (
    <TranscriptViewContext.Provider value={props.value}>
      {props.children}
    </TranscriptViewContext.Provider>
  );
}

/**
 * Read the transcript-specific context and fail loudly when the provider is missing.
 */
export function useTranscriptContext(): TranscriptContextValue {
  const value = useContext(TranscriptViewContext);
  if (!value) {
    throw new Error(
      "useTranscriptContext must be used within TranscriptViewProvider"
    );
  }
  return value;
}
