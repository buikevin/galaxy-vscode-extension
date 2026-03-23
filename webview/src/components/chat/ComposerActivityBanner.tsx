/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Compact animated activity banner shown above the composer while the agent, reviewer, or validator is still working.
 */

import { Spinner } from "@webview/components/ui/spinner";

/**
 * Props used to render the composer activity banner.
 */
type ComposerActivityBannerProps = Readonly<{
  /** Human-readable activity label currently shown to the user. */
  label: string;
}>;

/**
 * Render the animated activity banner above the sticky composer.
 */
export function ComposerActivityBanner(
  props: ComposerActivityBannerProps
) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-sky-400/20 bg-sky-500/10 px-3 py-2 text-sm text-sky-100">
      <Spinner
        size="sm"
        label={props.label}
        className="text-sky-300"
      />
      <span className="font-medium tracking-[0.01em]">{props.label}</span>
    </div>
  );
}
