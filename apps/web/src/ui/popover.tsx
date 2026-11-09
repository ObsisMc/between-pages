import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-popover';
import { cn } from './cn.ts';

// shadcn's popover on the paper tokens: Radix gives it its focus, Escape and outside-click
// behaviour; only the look is ours.
export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 rounded-xl border border-border bg-popover p-4 font-sans text-sm leading-relaxed text-popover-foreground shadow-lg outline-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
