/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Reusable transcript card for tool messages, including read/list/shell tool rendering.
 */

import type { MouseEvent, ReactNode } from "react";
import { ChevronDown, Eye, FileInput, FolderTree, Wrench } from "lucide-react";
import type { ChatMessage } from "@shared/protocol";
import { RichMessageBody } from "@webview/components/chat/RichMessageBody";
import type { ListDirEntry } from "@webview/entities/chat";

/**
 * Props required to render one tool message card.
 */
type ToolCardProps = Readonly<{
  /** Source tool message rendered in the transcript. */
  message: ChatMessage;
  /** Whether the card body is currently expanded. */
  expanded: boolean;
  /** Parsed list_dir entries shown when the tool scanned a directory. */
  listDirEntries: readonly ListDirEntry[];
  /** Normalized path label shown for list_dir cards. */
  listDirLabel: string;
  /** Shortened path label shown for read_file/read_document cards. */
  readFileLabel: string;
  /** Tool path extracted from tool params/result metadata. */
  toolPath: string;
  /** Human-readable title for generic tool cards. */
  toolLabel: string;
  /** Whether the current tool card is a list_dir result with parsed entries. */
  isListDirMessage: boolean;
  /** Whether the current tool card is a read_file/read_document result. */
  isReadFileMessage: boolean;
  /** Whether the current tool card is run_project_command. */
  isRunProjectCommand: boolean;
  /** Toggle expand/collapse state for the tool card. */
  onToggle: () => void;
  /** Open the target file in the editor. */
  onOpenFile: (filePath: string) => void;
  /** Handle hover behavior for list_dir entries. */
  onListDirHover: (
    event: MouseEvent<HTMLButtonElement>,
    entry: ListDirEntry
  ) => void;
  /** Pre-rendered shell content for run_project_command cards. */
  shellContent?: ReactNode;
}>;

/**
 * Render one tool message card inside the transcript.
 */
export function ToolCard(props: ToolCardProps) {
  if (props.isRunProjectCommand) {
    return <>{props.shellContent}</>;
  }

  const listDirWasTruncated =
    props.isListDirMessage && props.message.toolMeta?.truncated === true;

  if (props.isReadFileMessage) {
    const readLabel = "Đọc file";
    return (
      <div className="grid w-full min-w-0 max-w-full grid-cols-[auto,minmax(0,1fr),auto] items-center gap-2 overflow-hidden rounded-xl bg-[color:color-mix(in_srgb,var(--gc-surface)_82%,transparent)] px-3 py-2.5 text-left">
        <div className="col-span-2 flex min-w-0 items-center gap-2 overflow-hidden text-sm font-medium text-[color:var(--gc-foreground)]">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--gc-accent)_14%,transparent)] text-[color:var(--gc-accent)]">
            <FileInput className="h-3.5 w-3.5 shrink-0" />
          </span>
          <div className="flex-1 min-w-0 overflow-hidden">
            <span
              className="block max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              title={`${readLabel} (${props.toolPath})`}
            >
              {readLabel} ({props.readFileLabel})
            </span>
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface-elevated)] hover:text-[color:var(--gc-accent)]"
          onClick={() => props.onOpenFile(props.toolPath)}
          title="Mở hoặc chuyển tới tab file này"
        >
          <Eye className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-full min-w-0 overflow-x-hidden rounded-xl bg-[color:color-mix(in_srgb,var(--gc-surface)_82%,transparent)] px-3 py-2.5">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={props.onToggle}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-[color:var(--gc-foreground)]">
          {props.isListDirMessage ? (
            <>
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--gc-accent)_14%,transparent)] text-[color:var(--gc-accent)]">
                <FolderTree className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 max-w-full break-all [overflow-wrap:anywhere]">
                Quét thư mục ({props.listDirLabel})
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--gc-accent)_14%,transparent)] text-[color:var(--gc-accent)]">
                <Wrench className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 max-w-full break-all [overflow-wrap:anywhere]">
                {props.toolLabel}
              </span>
            </>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-[color:var(--gc-muted)] transition-transform ${
            props.expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      {props.expanded ? (
        <div className="mt-2 pt-2">
          {props.isListDirMessage ? (
            <div className="space-y-2">
              <div className="text-xs text-[color:var(--gc-muted)]">
                Giữ `Shift` rồi rê chuột vào file để mở nhanh trong editor.
              </div>
              {listDirWasTruncated ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-xs leading-5 text-amber-100/90">
                  Kết quả quét đã bị cắt bớt. Hãy thu hẹp `path` hoặc giảm `depth` để xem đầy đủ hơn.
                </div>
              ) : null}
              <div className="space-y-1">
                {props.listDirEntries.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    className={`flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm leading-6 transition-colors ${
                      entry.isDir
                        ? "cursor-default text-[color:var(--gc-muted)] hover:bg-transparent"
                        : "text-[color:var(--gc-foreground)] hover:bg-[color:color-mix(in_srgb,var(--gc-surface-elevated)_92%,transparent)]"
                    }`}
                    style={{
                      paddingLeft: `${entry.depth * 14 + 8}px`,
                    }}
                    onMouseEnter={(event) => props.onListDirHover(event, entry)}
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
            <RichMessageBody content={props.message.content} tone="muted" compact />
          )}
        </div>
      ) : null}
    </div>
  );
}
