import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-toggle-group';
import { cn } from './cn.ts';

// shadcn's toggle group on the paper tokens: a row of choices where one (`type="single"`,
// a radio group) or several are on; Radix gives the roles, the arrow keys and the state.
export function ToggleGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      className={cn('inline-flex flex-wrap items-center gap-1', className)}
      {...props}
    />
  );
}

export function ToggleGroupItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        'inline-flex h-9 min-h-0 cursor-pointer items-center rounded-full border border-line bg-transparent px-3.5 font-sans text-sm text-ink-soft outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:border-ink data-[state=on]:bg-ink data-[state=on]:text-paper',
        className,
      )}
      {...props}
    />
  );
}
