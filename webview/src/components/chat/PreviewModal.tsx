/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Full-screen modal used to preview attached or imported assets inside the Galaxy Code webview.
 */

import { Button } from "@webview/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@webview/components/ui/card";
import type { PreviewAsset } from "@webview/entities/attachments";

/**
 * Props required to render the preview modal.
 */
type PreviewModalProps = Readonly<{
  /** Preview asset currently opened by the user. */
  previewAsset: PreviewAsset | null;
  /** Close the preview modal. */
  onClose: () => void;
}>;

/**
 * Render the full-screen preview modal when a preview asset is available.
 */
export function PreviewModal(props: PreviewModalProps) {
  if (!props.previewAsset) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center px-3 py-6 bg-black/55 backdrop-blur-sm">
      <Card className="w-full max-w-3xl border-border/80 bg-card/95">
        <CardHeader className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{props.previewAsset.title}</CardTitle>
            <Button variant="outline" onClick={props.onClose}>
              Close
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-3">
          {props.previewAsset.imageUrl ? (
            <img
              src={props.previewAsset.imageUrl}
              alt={props.previewAsset.title}
              className="max-h-[70vh] w-full rounded-lg object-contain"
            />
          ) : (
            <div className="px-4 py-12 text-sm text-center border border-dashed rounded-xl border-border/60 text-muted-foreground">
              No preview asset is available for this Figma import.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
