/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-10
 * @modify date 2026-04-10
 * @desc Confirmation modal shown before enabling full-access mode from the composer permission selector.
 */

import { useEffect } from "react";
import { Button } from "@webview/components/ui/button";

/**
 * Props required to render the full-access confirmation modal.
 */
type FullAccessConfirmModalProps = Readonly<{
  /** Whether the confirmation modal is visible. */
  isOpen: boolean;
  /** Cancel the full-access change and keep default permissions. */
  onCancel: () => void;
  /** Confirm the full-access change. */
  onConfirm: () => void;
}>;

/**
 * Render the confirmation modal shown before switching the composer into full-access mode.
 */
export function FullAccessConfirmModal(
  props: FullAccessConfirmModalProps,
) {
  useEffect(() => {
    if (!props.isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.isOpen, props.onCancel]);

  if (!props.isOpen) {
    return null;
  }

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 px-4 py-6 backdrop-blur-sm"
      onClick={props.onCancel}
    >
      <div
        className="w-full max-w-2xl rounded-[28px] border border-white/8 bg-[#171717] px-6 py-7 text-[color:#f2f2f2] shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="space-y-6">
          <div className="space-y-4">
            <h2 className="text-[clamp(1.65rem,3vw,2.15rem)] font-semibold tracking-[-0.03em] text-white">
              Cho phép toàn quyền truy cập?
            </h2>
            <p className="text-lg leading-9 text-white/70">
              Khi chạy với toàn quyền truy cập, Galaxy Code có thể chỉnh sửa
              bất kỳ tệp nào trên máy tính của bạn và chạy lệnh qua mạng mà
              không cần bạn phê duyệt.
            </p>
            <p className="text-lg leading-9 text-white/70">
              Hãy thận trọng khi cấp toàn quyền truy cập. Điều này làm tăng
              đáng kể nguy cơ mất dữ liệu, rò rỉ dữ liệu hoặc hành vi bất ngờ.
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              className="h-14 rounded-2xl bg-[#d8d8d8] px-7 text-lg font-medium text-[#202020] hover:bg-[#e5e5e5]"
              onClick={props.onCancel}
            >
              Hủy
            </Button>
            <Button
              type="button"
              className="h-14 rounded-2xl border border-[#5c3a31] bg-[#2f221e] px-7 text-lg font-medium text-[#ff9e79] hover:bg-[#382822]"
              onClick={props.onConfirm}
            >
              Có, hãy tiếp tục
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}