import * as React from 'react';
import { cn } from '@webview/lib/utils';

type SpinnerSize = 'sm' | 'default' | 'lg';

const sizeClasses: Record<SpinnerSize, string> = {
  sm: 'h-4 w-4 border-2',
  default: 'h-6 w-6 border-2',
  lg: 'h-8 w-8 border-[3px]',
};

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  label?: string;
}

export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
  ({ className, size = 'default', label = 'Loading...', ...props }, ref) => (
    <span
      ref={ref}
      role="status"
      aria-label={label}
      className={cn(
        'inline-block shrink-0 animate-spin rounded-full border-solid border-current border-t-transparent text-muted-foreground',
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  ),
);
Spinner.displayName = 'Spinner';
