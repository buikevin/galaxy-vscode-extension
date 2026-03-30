/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Compact animated activity banner shown above the composer while the agent, reviewer, or validator is still working.
 */

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
    <div className="px-1 py-1 text-xs tracking-[0.02em] text-[color:var(--gc-muted)]">
      <span className="inline-flex items-center gap-1">
        <span>{props.label}</span>
        <span className="inline-flex">
          <span className="animate-pulse [animation-delay:0ms]">.</span>
          <span className="animate-pulse [animation-delay:150ms]">.</span>
          <span className="animate-pulse [animation-delay:300ms]">.</span>
        </span>
      </span>
    </div>
  );
}
