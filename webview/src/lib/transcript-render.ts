/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Pure helpers used to assemble transcript render items and human-readable labels.
 */

import type { AgentType, ChatMessage } from "@shared/protocol";
import type { ActiveShellSession, ActionItem, RenderItem } from "@webview/entities/chat";
import { getToolMetaString, shortenPath } from "@webview/lib/chat-render";

/**
 * Resolve the assistant label shown in transcript headers.
 *
 * @param fallbackAgent Currently selected agent in the composer.
 * @param agentType Agent type carried by an individual assistant message.
 * @returns Display label for the assistant card header.
 */
export function getAssistantLabel(
  fallbackAgent: AgentType,
  agentType?: AgentType
): string {
  return (agentType ?? fallbackAgent) === "manual"
    ? "Galaxy Agent"
    : "Assistant";
}

/**
 * Determine whether a tool message should be excluded from grouped transcript rendering.
 *
 * @param message Tool message candidate.
 * @returns `true` when the tool message should stay hidden from the visible transcript.
 */
export function shouldHideToolMessage(message: ChatMessage): boolean {
  return (
    message.role === "tool" &&
    (message.toolName === "validate_code" ||
      message.toolName === "request_code_review")
  );
}

/**
 * Build the flattened transcript render list from raw chat messages and live shell sessions.
 *
 * @param source Raw chat messages received from the host.
 * @param shellSessions Live shell sessions mirrored in the webview.
 * @returns Render items consumed by the Transcript component.
 */
export function buildRenderItems(
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
        if (!shouldHideToolMessage(source[cursor]!)) {
          actionItems.push({
            key: source[cursor]!.id,
            kind: "tool",
            message: source[cursor]!,
          });
        }
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
        if (!shouldHideToolMessage(source[cursor]!)) {
          actionItems.push({
            key: source[cursor]!.id,
            kind: "tool",
            message: source[cursor]!,
          });
        }
        cursor += 1;
      }
      if (actionItems.length > 0) {
        items.push({
          type: "actions",
          key: `actions:${message.id}`,
          items: Object.freeze(actionItems),
        });
      }
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

/**
 * Resolve the human-readable label for a tool card.
 *
 * @param message Tool message being rendered.
 * @param toolPath Primary path extracted from tool params.
 * @returns User-facing label shown in the transcript.
 */
export function getToolLabel(message: ChatMessage, toolPath: string): string {
  const normalizedPath = toolPath ? shortenPath(toolPath) : "";
  const operation = getToolMetaString(message, "operation");
  const query =
    typeof message.toolParams?.query === "string"
      ? message.toolParams.query.trim()
      : "";
  const url =
    typeof message.toolParams?.url === "string"
      ? message.toolParams.url.trim()
      : "";

  switch (message.toolName) {
    case "write_file":
      return `${operation === "create" ? "Tạo file" : "Ghi file"}${normalizedPath ? ` (${normalizedPath})` : ""}`;
    case "edit_file":
      return `Sửa file${normalizedPath ? ` (${normalizedPath})` : ""}`;
    case "grep":
      return `Tìm kiếm${normalizedPath ? ` (${shortenPath(toolPath)})` : ""}`;
    case "head":
      return `Xem đầu file${normalizedPath ? ` (${normalizedPath})` : ""}`;
    case "tail":
      return `Xem cuối file${normalizedPath ? ` (${normalizedPath})` : ""}`;
    case "validate_code":
      return "Kiểm tra mã";
    case "request_code_review":
      return "Review code";
    case "galaxy_design_project_info":
      return normalizedPath
        ? `Kiểm tra Galaxy Design (${normalizedPath})`
        : "Kiểm tra Galaxy Design";
    case "galaxy_design_init":
      return normalizedPath
        ? `Khởi tạo Galaxy Design (${normalizedPath})`
        : "Khởi tạo Galaxy Design";
    case "galaxy_design_add": {
      const components = Array.isArray(message.toolParams?.components)
        ? (message.toolParams?.components as unknown[])
            .map((item) => String(item ?? "").trim())
            .filter(Boolean)
        : [];
      const suffix = components.length > 0 ? `: ${components.join(", ")}` : "";
      return normalizedPath
        ? `Thêm component Galaxy Design (${normalizedPath})${suffix}`
        : `Thêm component Galaxy Design${suffix}`;
    }
    case "galaxy_design_registry":
      return "Tra cứu Galaxy Design";
    case "diff_file":
      return normalizedPath ? `Xem thay đổi (${normalizedPath})` : "Xem thay đổi";
    case "read_document":
      return normalizedPath ? `Đọc tài liệu (${normalizedPath})` : "Đọc tài liệu";
    case "search_web":
      return query ? `Tìm kiếm web (${query})` : "Tìm kiếm web";
    case "extract_web":
      return url ? `Đọc nội dung web (${url})` : "Đọc nội dung web";
    case "map_web":
      return url ? `Lập sơ đồ website (${url})` : "Lập sơ đồ website";
    case "crawl_web":
      return url ? `Crawl website (${url})` : "Crawl website";
    default:
      return message.toolName ?? "Tool";
  }
}
