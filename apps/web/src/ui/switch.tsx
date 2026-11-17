import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-switch';
import { cn } from './cn.ts';

// shadcn's switch on the paper tokens: Radix gives it the switch role, the checked state
// and Space to toggle.
export function Switch({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      className={cn(
        'peer inline-flex h-6 w-11 min-h-0 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent p-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-warm data-[state=unchecked]:bg-line',
        className,
      )}
      {...props}
    >
      <Primitive.Thumb className="pointer-events-none block size-5 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
    </Primitive.Root>
  );
}
