import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-tabs';
import { cn } from './cn.ts';

// shadcn's tabs on the paper tokens, drawn as an underlined row: Radix gives them the tab
// roles, arrow keys and the selected state. A panel given `forceMount` stays mounted and is
// hidden while another tab shows, so what was typed in it survives the switch.
export const Tabs = Primitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn('flex flex-wrap gap-x-6 gap-y-1 border-b border-line', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        '-mb-px inline-flex min-h-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-none border-0 border-b-2 border-transparent bg-transparent px-0 pt-1 pb-3 font-sans text-sm whitespace-nowrap text-ink-soft outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:border-warm data-[state=active]:text-ink',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content
      className={cn('pt-6 outline-none data-[state=inactive]:hidden', className)}
      {...props}
    />
  );
}
