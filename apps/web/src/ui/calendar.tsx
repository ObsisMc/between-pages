import type { ComponentProps } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker, getDefaultClassNames } from 'react-day-picker';
import { buttonVariants } from './button.tsx';
import { cn } from './cn.ts';

export type CalendarProps = ComponentProps<typeof DayPicker>;

function Chevron({ orientation, className }: { orientation?: string; className?: string }) {
  const Icon = orientation === 'left' ? ChevronLeft : ChevronRight;
  return <Icon aria-hidden="true" className={cn('size-4', className)} />;
}

// shadcn's calendar on the paper tokens: react-day-picker's month grid with the nav as
// ghost icon buttons and the caption in the serif. It knows nothing of what the days mean:
// the caller passes the time zone, the modifiers, their classes and the labels, as it would
// to DayPicker itself. Modifier classes land on the day cell (the `td`), so a class meant
// for the clickable day styles the cell and its button together.
export function Calendar({ className, classNames, ...props }: CalendarProps) {
  const defaults = getDefaultClassNames();
  return (
    <DayPicker
      className={cn('w-full max-w-xs font-sans text-ink', className)}
      classNames={{
        root: cn('relative', defaults.root),
        months: 'relative flex flex-col gap-4',
        month: 'flex w-full flex-col gap-3',
        nav: 'absolute inset-x-0 top-0 flex items-center justify-between',
        button_previous: cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'size-9 aria-disabled:opacity-40',
        ),
        button_next: cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'size-9 aria-disabled:opacity-40',
        ),
        month_caption: 'flex h-9 items-center justify-center font-serif',
        caption_label: 'text-base',
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'flex-1 text-center text-sm font-normal text-ink-soft select-none',
        week: 'mt-1 flex w-full',
        day: 'relative flex aspect-square flex-1 items-center justify-center rounded-lg p-0 text-sm tabular-nums',
        day_button:
          'flex size-full cursor-pointer items-center justify-center rounded-lg outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        today: 'font-semibold underline underline-offset-4',
        outside: 'text-ink-soft/50',
        disabled: 'opacity-40',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{ Chevron }}
      {...props}
    />
  );
}
