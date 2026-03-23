/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Popup menu opened from the composer plus button for attachments and quality toggles.
 */

import type { ChangeEvent, Ref } from "react";
import { Paperclip, Plus } from "lucide-react";
import type { QualityPreferences } from "@shared/protocol";

/**
 * Props for the composer plus-menu popup.
 */
type PlusMenuProps = Readonly<{
  /** Anchor ref used for outside-click detection. */
  anchorRef: Ref<HTMLDivElement>;
  /** Hidden input ref used for local file attachments. */
  fileInputRef: Ref<HTMLInputElement>;
  /** Whether the popup is currently visible. */
  isOpen: boolean;
  /** Current review/validate/full-access settings. */
  qualityPreferences: QualityPreferences;
  /** Toggle the popup open or closed. */
  onToggleOpen: () => void;
  /** Trigger the hidden file input. */
  onOpenFilePicker: () => void;
  /** Apply new quality preference values. */
  onUpdateQualityPreferences: (next: QualityPreferences) => void;
  /** Handle actual file-input change events. */
  onFileSelection: (event: ChangeEvent<HTMLInputElement>) => void;
}>;

/**
 * Render the popup attached to the composer plus button.
 */
export function PlusMenu(props: PlusMenuProps) {
  return (
    <div className="relative" ref={props.anchorRef}>
      <button
        type="button"
        className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
        onClick={props.onToggleOpen}
        title="Mở menu thêm"
      >
        <Plus className="h-4 w-4" />
      </button>
      {props.isOpen ? (
        <div className="absolute bottom-12 left-0 z-30 w-56 rounded-[18px] border border-white/10 bg-[#111a2c]/95 p-2 shadow-2xl backdrop-blur-xl">
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-white/5"
            onClick={props.onOpenFilePicker}
          >
            <Paperclip className="h-4 w-4 text-muted-foreground" />
            <span>Thêm ảnh và file</span>
          </button>
          <div className="my-2 border-t border-white/10" />
          <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm text-foreground transition-colors hover:bg-white/5">
            <span>Review</span>
            <button
              type="button"
              role="switch"
              aria-checked={props.qualityPreferences.reviewEnabled}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                props.qualityPreferences.reviewEnabled
                  ? "bg-sky-500"
                  : "bg-white/15"
              }`}
              onClick={() =>
                props.onUpdateQualityPreferences({
                  ...props.qualityPreferences,
                  reviewEnabled: !props.qualityPreferences.reviewEnabled,
                })
              }
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  props.qualityPreferences.reviewEnabled
                    ? "translate-x-5"
                    : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
          <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm text-foreground transition-colors hover:bg-white/5">
            <span>Validate</span>
            <button
              type="button"
              role="switch"
              aria-checked={props.qualityPreferences.validateEnabled}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                props.qualityPreferences.validateEnabled
                  ? "bg-sky-500"
                  : "bg-white/15"
              }`}
              onClick={() =>
                props.onUpdateQualityPreferences({
                  ...props.qualityPreferences,
                  validateEnabled: !props.qualityPreferences.validateEnabled,
                })
              }
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  props.qualityPreferences.validateEnabled
                    ? "translate-x-5"
                    : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
          <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm text-foreground transition-colors hover:bg-white/5">
            <span>Full Access</span>
            <button
              type="button"
              role="switch"
              aria-checked={props.qualityPreferences.fullAccessEnabled}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                props.qualityPreferences.fullAccessEnabled
                  ? "bg-sky-500"
                  : "bg-white/15"
              }`}
              onClick={() =>
                props.onUpdateQualityPreferences({
                  ...props.qualityPreferences,
                  fullAccessEnabled: !props.qualityPreferences.fullAccessEnabled,
                })
              }
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  props.qualityPreferences.fullAccessEnabled
                    ? "translate-x-5"
                    : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
          <div className="px-3 pb-1 text-xs text-muted-foreground">
            Bỏ hỏi quyền cho project command, git, delete, scaffold
          </div>
        </div>
      ) : null}
      <input
        ref={props.fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={props.onFileSelection}
      />
    </div>
  );
}
