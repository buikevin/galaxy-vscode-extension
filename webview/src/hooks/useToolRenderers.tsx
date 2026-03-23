/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Hook that groups transcript-side render helpers for shell panels, tool cards, and grouped action bodies.
 */

import type { Dispatch, MouseEvent, MutableRefObject, ReactNode, SetStateAction } from "react";
import type { ChatMessage } from "@shared/protocol";
import { ShellPanel } from "@webview/components/chat/ShellPanel";
import { ThinkingCard } from "@webview/components/chat/ThinkingCard";
import { ToolCard } from "@webview/components/chat/ToolCard";
import type { ActionItem, ActiveShellSession, ListDirEntry } from "@webview/entities/chat";
import {
  buildListDirEntries,
  formatCommandDuration,
  getToolMetaNumber,
  getToolMetaString,
  getToolPath,
  normalizeRelativePath,
  shortenPath,
} from "@webview/lib/chat-render";
import { getToolLabel } from "@webview/lib/transcript-render";

/**
 * Dependencies required by transcript render helper functions.
 */
type UseToolRenderersOptions = Readonly<{
  /** Current copied shell message id used to flip the copy button state. */
  copiedCommandMessageId: string | null;
  /** Update copied shell message state after a copy action. */
  setCopiedCommandMessageId: Dispatch<SetStateAction<string | null>>;
  /** Push user-facing error text into the error banner. */
  setErrorText: Dispatch<SetStateAction<string>>;
  /** Expanded grouped-action/tool ids. */
  expandedItems: readonly string[];
  /** Toggle one grouped-action/tool panel. */
  toggleExpanded: (key: string) => void;
  /** Open one workspace file in the editor. */
  openFile: (filePath: string) => void;
  /** Hover handler for list_dir entries. */
  handleListDirHover: (
    event: MouseEvent<HTMLButtonElement>,
    entry: ListDirEntry
  ) => void;
  /** Ref map used to auto-scroll shell outputs. */
  shellOutputRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  /** Current timestamp used to derive live shell durations. */
  shellNow: number;
}>;

/**
 * Bundle transcript render helpers outside App.tsx.
 */
export function useToolRenderers(options: UseToolRenderersOptions) {
  function isExpanded(key: string): boolean {
    return options.expandedItems.includes(key);
  }

  async function copyCommand(
    messageId: string,
    commandText: string
  ): Promise<void> {
    if (!commandText.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(commandText);
      options.setCopiedCommandMessageId(messageId);
      window.setTimeout(() => {
        options.setCopiedCommandMessageId((current) =>
          current === messageId ? null : current
        );
      }, 1600);
    } catch {
      options.setErrorText("Không thể copy lệnh vào clipboard.");
    }
  }

  function getActiveShellDuration(session: ActiveShellSession): string {
    if (typeof session.durationMs === "number") {
      return formatCommandDuration(session.durationMs);
    }

    return formatCommandDuration(options.shellNow - session.startedAt);
  }

  /**
   * Render one shell execution panel.
   *
   * @param panelId Stable panel id, typically message id or live-shell id.
   * @param commandText Exact command rendered in the shell header.
   * @param cwd Effective cwd used by the command.
   * @param output Streamed stdout/stderr shown in the shell body.
   * @param success Final success state when available.
   * @param exitCode Final exit code when available.
   * @param durationLabel Optional human-readable duration.
   * @param running Whether the shell process is still active.
   * @returns One reusable shell panel node.
   */
  function renderShellPanel(opts: {
    panelId: string;
    commandText: string;
    cwd: string;
    output: string;
    success?: boolean;
    exitCode?: number;
    durationLabel?: string;
    running?: boolean;
  }): ReactNode {
    const isCopied = options.copiedCommandMessageId === opts.panelId;
    const expandedKey = `tool:${opts.panelId}`;

    return (
      <ShellPanel
        panelId={opts.panelId}
        commandText={opts.commandText}
        cwd={opts.cwd}
        output={opts.output}
        success={opts.success}
        exitCode={opts.exitCode}
        durationLabel={opts.durationLabel}
        running={opts.running}
        expanded={isExpanded(expandedKey)}
        copied={isCopied}
        onToggle={() => options.toggleExpanded(expandedKey)}
        onCopy={() => copyCommand(opts.panelId, opts.commandText)}
        onOutputNode={(node) => {
          if (!node) {
            options.shellOutputRefs.current.delete(opts.panelId);
            return;
          }
          options.shellOutputRefs.current.set(opts.panelId, node);
        }}
      />
    );
  }

  /**
   * Render one collapsed/expanded thinking block.
   *
   * @param message Source thinking message.
   * @returns Thinking card node.
   */
  function renderThinkingBody(message: ChatMessage): ReactNode {
    return (
      <ThinkingCard
        panelId={`thinking:${message.id}`}
        expanded={isExpanded(`thinking:${message.id}`)}
        content={message.thinking ?? ""}
        onToggle={() => options.toggleExpanded(`thinking:${message.id}`)}
      />
    );
  }

  /**
   * Render one tool message body.
   *
   * @param message Source tool message.
   * @returns Tool-specific transcript content.
   */
  function renderToolBody(message: ChatMessage): ReactNode {
    const listDirEntries = buildListDirEntries(message);
    const toolPath = getToolPath(message);
    const listDirLabel = normalizeRelativePath(toolPath) || ".";
    const readFileLabel = shortenPath(toolPath);
    const isListDirMessage =
      message.toolName === "list_dir" && listDirEntries.length > 0;
    const isReadFileMessage =
      (message.toolName === "read_file" ||
        message.toolName === "read_document") &&
      Boolean(toolPath);
    const isRunProjectCommand = message.toolName === "run_project_command";

    const commandText =
      getToolMetaString(message, "commandText") ||
      (typeof message.toolParams?.command === "string"
        ? message.toolParams.command
        : "");
    const cwd = getToolMetaString(message, "cwd");
    const exitCode = getToolMetaNumber(message, "exitCode");
    const duration = formatCommandDuration(getToolMetaNumber(message, "durationMs"));

    return (
      <ToolCard
        message={message}
        expanded={isExpanded(`tool:${message.id}`)}
        listDirEntries={listDirEntries}
        listDirLabel={listDirLabel}
        readFileLabel={readFileLabel}
        toolPath={toolPath}
        toolLabel={getToolLabel(message, toolPath)}
        isListDirMessage={isListDirMessage}
        isReadFileMessage={isReadFileMessage}
        isRunProjectCommand={isRunProjectCommand}
        onToggle={() => options.toggleExpanded(`tool:${message.id}`)}
        onOpenFile={options.openFile}
        onListDirHover={options.handleListDirHover}
        shellContent={renderShellPanel({
          panelId: message.id,
          commandText,
          cwd,
          output: message.content,
          success: message.toolSuccess,
          exitCode: exitCode ?? undefined,
          durationLabel: duration || undefined,
        })}
      />
    );
  }

  /**
   * Render one grouped action body, delegating to thinking or tool renderers.
   *
   * @param item Grouped transcript action.
   * @returns Grouped action content.
   */
  function renderActionBody(item: ActionItem): ReactNode {
    if (item.kind === "thinking") {
      return renderThinkingBody(item.message);
    }

    return renderToolBody(item.message);
  }

  /**
   * Render one live shell session that is still streaming in the transcript.
   *
   * @param session Active shell session mirrored from the host.
   * @returns Live shell panel content.
   */
  function renderShellSession(session: ActiveShellSession): ReactNode {
    return renderShellPanel({
      panelId: `live-shell:${session.toolCallId}`,
      commandText: session.commandText,
      cwd: session.cwd,
      output: session.output,
      success: session.success,
      exitCode: session.exitCode,
      durationLabel: getActiveShellDuration(session) || undefined,
      running: typeof session.durationMs !== "number",
    });
  }

  return {
    renderActionBody,
    renderShellPanel,
    renderShellSession,
    renderThinkingBody,
    renderToolBody,
  };
}
