/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Floating approval popup rendered when the host requires a user decision for a tool call.
 */

import type { ApprovalRequestPayload } from "@shared/protocol";
import { Badge } from "@webview/components/ui/badge";
import { Button } from "@webview/components/ui/button";

/**
 * Props required to render the approval popup.
 */
type ApprovalPopupProps = Readonly<{
  /** Approval request currently awaiting the user's decision. */
  approvalRequest: ApprovalRequestPayload | null;
  /** Deny the tool request. */
  onDeny: () => void;
  /** Ask the model to clarify or retry later. */
  onAsk: () => void;
  /** Permanently allow the pending tool request. */
  onAllow: () => void;
}>;

/**
 * Render the approval popup for the current tool request.
 */
export function ApprovalPopup(props: ApprovalPopupProps) {
  if (!props.approvalRequest) {
    return null;
  }
  const request = props.approvalRequest;

  return (
    <div className="pointer-events-none absolute bottom-32 left-3 right-3 z-50 flex justify-start">
      <div className="pointer-events-auto w-full max-w-xl rounded-2xl bg-[color:color-mix(in_srgb,var(--gc-surface-elevated)_94%,transparent)] shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl">
        <div className="space-y-3 px-4 pb-4 pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold text-[color:var(--gc-foreground)]">
                {request.title}
              </div>
              <p className="text-sm leading-6 text-[color:var(--gc-muted)]">
                {request.message}
              </p>
            </div>
            <Badge
              variant="secondary"
              className="shrink-0 border-0 bg-[color:color-mix(in_srgb,var(--gc-accent)_14%,transparent)] text-[color:var(--gc-accent)]"
            >
              {request.toolName}
            </Badge>
          </div>

          {request.details.length > 0 ? (
            <div className="space-y-2">
              {request.details.map((detail, index) => (
                <div
                  key={`${request.requestId}-${index}`}
                  className="rounded-xl bg-[color:color-mix(in_srgb,var(--gc-surface)_90%,transparent)] px-3 py-2 text-sm leading-6 text-[color:var(--gc-foreground)]"
                >
                  {detail}
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              className="rounded-full text-[color:var(--gc-muted)] hover:bg-[var(--gc-surface)] hover:text-[color:var(--gc-foreground)]"
              onClick={props.onDeny}
            >
              Từ chối
            </Button>
            <Button
              variant="outline"
              className="rounded-full border-[color:var(--gc-border)] bg-transparent"
              onClick={props.onAsk}
            >
              Hỏi lại
            </Button>
            <Button
              className="rounded-full border border-[color:var(--gc-accent)]/20 bg-[var(--gc-accent-soft)] text-[color:var(--gc-accent)] hover:opacity-90"
              onClick={props.onAllow}
            >
              Cho phép luôn
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
