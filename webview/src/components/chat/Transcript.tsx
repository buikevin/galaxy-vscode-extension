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
import { RichMessageBody } from "@webview/components/chat/RichMessageBody";
import { ThinkingCard } from "@webview/components/chat/ThinkingCard";
import { StreamingAssistantCard } from "@webview/components/chat/StreamingAssistantCard";
import type { ChatMessage, MessageAttachment } from "@shared/protocol";
import { useTranscriptContext } from "@webview/context/TranscriptViewContext";

/**
 * Render the chat transcript area with grouped tool/thinking actions and messages.
 */
export function Transcript() {
  const transcript = useTranscriptContext();

  function formatCount(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function buildActionSummaryLabel(items: readonly Parameters<typeof transcript.renderActionSummary>[0][]): string {
    let readCount = 0;
    let scanCount = 0;
    let searchCount = 0;
    let thinkCount = 0;
    let otherCount = 0;

    items.forEach((item) => {
      if (item.kind === "thinking") {
        thinkCount += 1;
        return;
      }

      switch (item.message.toolName) {
        case "read_file":
        case "read_document":
        case "head":
        case "tail":
          readCount += 1;
          break;
        case "list_dir":
          scanCount += 1;
          break;
        case "grep":
        case "search_web":
        case "vscode_workspace_search":
        case "find_test_files":
        case "vscode_find_references":
        case "search_extension_tools":
          searchCount += 1;
          break;
        default:
          otherCount += 1;
          break;
      }
    });

    const parts: string[] = [];
    if (readCount > 0) {
      parts.push(`Đã đọc ${formatCount(readCount, "file", "file")}`);
    }
    if (scanCount > 0) {
      parts.push(`quét ${formatCount(scanCount, "thư mục", "thư mục")}`);
    }
    if (searchCount > 0) {
      parts.push(`tìm ${formatCount(searchCount, "lần", "lần")}`);
    }
    if (thinkCount > 0 && parts.length === 0) {
      parts.push("Đang phân tích");
    }
    if (otherCount > 0) {
      parts.push(`thực hiện ${formatCount(otherCount, "tác vụ", "tác vụ")}`);
    }

    return parts.length > 0 ? parts.join(", ") : `Hoạt động ${items.length}`;
  }

  function buildMessageAttachments(message: ChatMessage): readonly MessageAttachment[] {
    return (
      message.attachments ??
      message.figmaAttachments?.map((attachment) =>
        Object.freeze({
          attachmentId: attachment.attachmentId ?? attachment.importId,
          kind: "figma" as const,
          label: "Thiết kế Figma",
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
      <div className="mx-auto flex w-full max-w-[980px] min-w-0 flex-col overflow-x-hidden px-3 pb-5 pt-3 max-[620px]:px-2 max-[620px]:pb-3 max-[620px]:pt-2">
        {transcript.renderItems.map((item) => {
          if (item.type === "live-shell") {
            return (
              <div
                key={item.key}
                className="mr-auto mt-2 w-full min-w-0 max-w-[90%] overflow-x-hidden max-[620px]:max-w-full"
              >
                {transcript.renderShellSession(item.session)}
              </div>
            );
          }

          if (item.type === "actions") {
            if (item.items.length === 1) {
              return (
                <div key={item.key} className="mr-auto mt-2 w-full max-w-[90%] min-w-0 max-[620px]:max-w-full">
                  {transcript.renderActionBody(item.items[0]!)}
                </div>
              );
            }

            const expanded = transcript.isExpanded(`actions:${item.key}`);
            return (
              <div
                key={item.key}
                className="mr-auto mt-2 w-full max-w-[90%] min-w-0 overflow-x-hidden max-[620px]:max-w-full"
              >
                <ActionGroupCard
                  expanded={expanded}
                  actionCount={item.items.length}
                  summaryLabel={buildActionSummaryLabel(item.items)}
                  summaryRows={item.items.map((action) =>
                    transcript.renderActionSummary(action)
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
                  <RichMessageBody
                    content={message.content}
                    tone={message.role === "assistant" ? "assistant" : "muted"}
                  />
                ) : null
              }
              onToggleExpand={() => transcript.toggleMessageExpanded(message.id)}
            />
          );
        })}

        {transcript.streamingAssistant ? (
          <div className="mt-3">
            <StreamingAssistantCard content={transcript.streamingAssistant} />
          </div>
        ) : null}

        {transcript.streamingThinking ? (
          <div className="mr-auto mt-2 w-full min-w-0 max-w-[90%] overflow-x-hidden max-[620px]:max-w-full">
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
