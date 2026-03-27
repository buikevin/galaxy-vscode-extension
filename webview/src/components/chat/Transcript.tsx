/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Transcript renderer for Galaxy Code chat, including grouped actions, message cards, and live streaming blocks.
 */

import type { RefObject } from "react";
import { ScrollArea } from "@webview/components/ui/scroll-area";
import { ActionGroupCard } from "@webview/components/chat/ActionGroupCard";
import { MessageAttachmentGrid } from "@webview/components/chat/MessageAttachmentGrid";
import { MessageCard } from "@webview/components/chat/MessageCard";
import { ThinkingCard } from "@webview/components/chat/ThinkingCard";
import { StreamingAssistantCard } from "@webview/components/chat/StreamingAssistantCard";
import type { ChatMessage, MessageAttachment } from "@shared/protocol";
import { useTranscriptContext } from "@webview/context/TranscriptViewContext";

/**
 * Render the chat transcript area with grouped tool/thinking actions and messages.
 */
export function Transcript() {
  const transcript = useTranscriptContext();

  function buildMessageAttachments(message: ChatMessage): readonly MessageAttachment[] {
    return (
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
      []
    );
  }

  return (
    <ScrollArea
      ref={transcript.scrollAreaRef as RefObject<HTMLDivElement>}
      className="flex-1 min-h-0 overflow-x-hidden"
    >
      <div className="max-w-full min-w-0 space-y-3 overflow-x-hidden">
        {transcript.renderItems.map((item) => {
          if (item.type === "live-shell") {
            return (
              <div
                key={item.key}
                className="mr-auto w-full min-w-0 max-w-[96%] overflow-x-hidden"
              >
                {transcript.renderShellSession(item.session)}
              </div>
            );
          }

          if (item.type === "actions") {
            if (item.items.length === 1) {
              return (
                <div key={item.key} className="mr-auto w-full max-w-[96%] min-w-0">
                  {transcript.renderActionBody(item.items[0]!)}
                </div>
              );
            }

            const expanded = transcript.isExpanded(`actions:${item.key}`);
            return (
              <div
                key={item.key}
                className="mr-auto w-full max-w-[96%] min-w-0 overflow-x-hidden"
              >
                <ActionGroupCard
                  expanded={expanded}
                  actionCount={item.items.length}
                  previewIcons={item.items
                    .slice(0, 5)
                    .map((action, index) =>
                      transcript.renderActionIcon(
                        action,
                        `${item.key}-${action.key}-${index}`
                      )
                    )}
                  onToggle={() => transcript.toggleExpanded(`actions:${item.key}`)}
                >
                  {item.items.map((action) => (
                    <div key={action.key}>{transcript.renderActionBody(action)}</div>
                  ))}
                </ActionGroupCard>
              </div>
            );
          }

          const message = item.message;
          if (message.role === "assistant" && !message.content.trim()) {
            return null;
          }
          const messageAttachments = buildMessageAttachments(message);

          return (
            <MessageCard
              key={item.key}
              message={message}
              expanded={transcript.isMessageExpanded(message.id)}
              pending={transcript.pendingMessageId === message.id}
              titleLabel={
                message.role === "assistant"
                  ? transcript.getAssistantLabel(message.agentType)
                  : "User"
              }
              timestampLabel={new Date(message.timestamp).toLocaleTimeString()}
              attachmentsContent={
                messageAttachments.length > 0
                  ? (
                    <MessageAttachmentGrid
                      attachments={messageAttachments}
                      onOpenPreview={transcript.onOpenMessageAttachmentPreview}
                    />
                  )
                  : null
              }
              body={
                message.role === "tool" ? transcript.renderToolBody(message) : transcript.isMessageExpanded(message.id) ? (
                  <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                    {message.content}
                  </div>
                ) : null
              }
              onToggleExpand={() => transcript.toggleMessageExpanded(message.id)}
            />
          );
        })}

        {transcript.streamingAssistant ? (
          <StreamingAssistantCard
            titleLabel={transcript.getAssistantLabel(transcript.selectedAgent)}
            content={transcript.streamingAssistant}
          />
        ) : null}

        {transcript.streamingThinking ? (
          <div className="mr-auto w-full min-w-0 max-w-[96%] overflow-x-hidden">
            <ThinkingCard
              panelId="thinking:streaming"
              expanded={transcript.isExpanded("thinking:streaming")}
              content={transcript.streamingThinking}
              streaming
              onToggle={() => transcript.toggleExpanded("thinking:streaming")}
            />
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}
