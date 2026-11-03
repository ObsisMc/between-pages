import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from './cn.ts';

// shadcn's dialog on the paper tokens: Radix gives it the focus trap, Escape, the outside
// click and the focus back on the trigger; only the look is ours. The close button sets what
// the old global `button` rule (legacy.css) sets, as `Button` does.
export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-ink/30" />
      <Primitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl border border-border bg-popover p-6 font-sans text-popover-foreground shadow-lg',
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Close
          aria-label="关闭"
          className="absolute top-4 right-4 min-h-0 cursor-pointer rounded-lg border-0 bg-transparent p-1 text-ink-soft outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
        >
          <X aria-hidden="true" />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return (
    <Primitive.Title
      className={cn('pr-8 font-serif text-xl font-medium text-ink', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn('text-sm text-ink-soft', className)} {...props} />;
}
