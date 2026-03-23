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

  if (props.isReadFileMessage) {
    const readLabel =
      props.message.toolName === "read_document" ? "Đọc tài liệu" : "Đọc file";
    return (
      <div className="grid w-full min-w-0 max-w-full grid-cols-[auto,minmax(0,1fr),auto] items-center gap-2 overflow-hidden rounded-[22px] border border-border/60 bg-background/50 px-4 py-3 text-left">
        <div className="flex items-center min-w-0 col-span-2 gap-2 overflow-hidden text-sm font-medium text-foreground">
          <FileInput className="w-4 h-4 shrink-0 text-sky-300" />
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
          className="inline-flex items-center justify-center w-4 h-4 transition-colors shrink-0 text-muted-foreground hover:text-sky-200"
          onClick={() => props.onOpenFile(props.toolPath)}
          title="Mở hoặc chuyển tới tab file này"
        >
          <Eye className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-full min-w-0 space-y-2 overflow-x-hidden">
      <button
        type="button"
        className="flex items-center justify-between w-full min-w-0 px-3 py-2 text-left border rounded-lg border-border/60 bg-background/50"
        onClick={props.onToggle}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {props.isListDirMessage ? (
            <>
              <FolderTree className="w-4 h-4 text-sky-300" />
              <span className="min-w-0 max-w-full break-all [overflow-wrap:anywhere]">
                Quét thư mục ({props.listDirLabel})
              </span>
            </>
          ) : (
            <>
              <Wrench className="w-4 h-4 text-sky-300" />
              <span className="min-w-0 max-w-full break-all [overflow-wrap:anywhere]">
                {props.toolLabel}
              </span>
            </>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${
            props.expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      {props.expanded ? (
        <div className="max-w-full p-3 overflow-auto border rounded-lg max-h-44 border-border/60 bg-background/60">
          {props.isListDirMessage ? (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                Giữ Shift rồi rê chuột vào tên file để mở bằng tab mới.
              </div>
              <div className="space-y-1">
                {props.listDirEntries.map((entry) => (
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
            <div className="min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-all text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
              {props.message.content}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
