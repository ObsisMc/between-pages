import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

// Form fields on the paper tokens. The select is the browser's own, so its keyboard and
// mobile picker stay native.
const control =
  'h-11 w-full min-w-0 rounded-xl border border-input bg-background px-3 font-sans text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(control, 'h-auto min-h-24 py-2 leading-relaxed', className)}
      {...props}
    />
  );
}

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(control, 'cursor-pointer pr-8', className)} {...props} />;
}

/** A label above its control. */
export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('grid gap-1.5 text-sm text-ink-soft', className)} {...props} />;
}

/** A checkbox with its words on the same line. */
export function CheckboxLabel({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 text-sm text-ink [&_input]:size-4 [&_input]:accent-warm',
        className,
      )}
      {...props}
    />
  );
}
