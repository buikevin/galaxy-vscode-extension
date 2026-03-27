/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Small icon badge used in grouped action previews inside the transcript.
 */

import { Brain, FileInput, FolderTree, Wrench } from "lucide-react";
import type { ActionItem } from "@webview/entities/chat";

/**
 * Props required to render one grouped action icon.
 */
type ActionIconProps = Readonly<{
  /** Grouped action represented by the icon. */
  item: ActionItem;
  /** Additional size classes for the icon glyph. */
  sizeClass?: string;
}>;

/**
 * Render one compact action icon badge.
 */
export function ActionIcon(props: ActionIconProps) {
  const iconClass = `${props.sizeClass ?? "h-4 w-4"} text-slate-200`;

  if (props.item.kind === "thinking") {
    return (
      <span className="inline-flex items-center justify-center w-8 h-8 ">
        <Brain className={iconClass} />
      </span>
    );
  }

  if (props.item.message.toolName === "list_dir") {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 ">
        <FolderTree className={iconClass} />
      </span>
    );
  }

  if (props.item.message.toolName === "read_file") {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 ">
        <FileInput className={iconClass} />
      </span>
    );
  }

  return (
    <span className="inline-flex items-center justify-center w-6 h-6 ">
      <Wrench className={iconClass} />
    </span>
  );
}
