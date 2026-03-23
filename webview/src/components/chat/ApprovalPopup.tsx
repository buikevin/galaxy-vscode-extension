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
import { Card, CardContent, CardHeader, CardTitle } from "@webview/components/ui/card";

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
    <div className="absolute z-50 flex justify-start pointer-events-none bottom-32 left-3 right-3">
      <Card className="w-full max-w-md shadow-2xl pointer-events-auto border-border/80 bg-card/95 backdrop-blur-xl">
        <CardHeader className="pb-2 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">{request.title}</CardTitle>
            <Badge variant="secondary">{request.toolName}</Badge>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            {request.message}
          </p>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-3">
          {request.details.map((detail, index) => (
            <div
              key={`${request.requestId}-${index}`}
              className="px-3 py-2 text-sm leading-6 border rounded-xl border-border/60 bg-background/70"
            >
              {detail}
            </div>
          ))}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="destructive" onClick={props.onDeny}>
              Từ chối
            </Button>
            <Button variant="outline" onClick={props.onAsk}>
              Hỏi lại
            </Button>
            <Button onClick={props.onAllow}>Cho phép luôn</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
