import { useState } from 'react';
import type { Modifiers } from 'react-day-picker';
import type { DateSelection } from '@between-pages/contracts';
import { Calendar } from '../ui/index.ts';
import { toDate, toDay } from './day.ts';
import { isExcluded, isShared } from './range.ts';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** "10 月 5 日，共享" — what a screen reader hears for a day, and what tests click. */
function dayLabel(day: string, modifiers: Modifiers): string {
  const [, month, date] = day.split('-').map(Number) as [number, number, number];
  const state = modifiers.anchor
    ? '已点选'
    : modifiers.excluded
      ? '已排除'
      : modifiers.shared
        ? '共享'
        : '不共享';
  return `${month} 月 ${date} 日，${state}${modifiers.today ? '，今天' : ''}`;
}

/**
 * One calendar month marking the days a selection shares (the warm fill) and excludes
 * (struck through, faded). Calendar days only: they are diary dates, never instants, so
 * the grid runs in UTC and every day in and out is a `YYYY-MM-DD` string (D3). The month
 * opens on `today`. With `onDayClick` the days are buttons; `anchor` rings the day a range
 * is being started from.
 */
export function MonthView({
  selection,
  today,
  anchor = null,
  onDayClick,
}: {
  selection: DateSelection;
  /** The viewer's local today, `YYYY-MM-DD`; marks the day and opens its month. */
  today: string;
  anchor?: string | null;
  onDayClick?: (day: string) => void;
}) {
  const [month, setMonth] = useState(today);
  return (
    <Calendar
      timeZone="UTC"
      today={toDate(today)}
      month={toDate(month)}
      onMonthChange={(m) => setMonth(toDay(m))}
      modifiers={{
        shared: (d) => isShared(selection, toDay(d)),
        excluded: (d) => isExcluded(selection, toDay(d)),
        anchor: (d) => toDay(d) === anchor,
      }}
      modifiersClassNames={{
        shared: 'bg-warm text-paper',
        excluded: 'text-ink-soft/60 line-through',
        anchor: 'ring-2 ring-warm ring-inset',
      }}
      labels={{
        labelPrevious: () => '上个月',
        labelNext: () => '下个月',
        labelDayButton: (d, modifiers) => dayLabel(toDay(d), modifiers),
        labelGridcell: (d, modifiers) => dayLabel(toDay(d), modifiers ?? {}),
      }}
      formatters={{
        formatCaption: (m) => {
          const [year, month] = toDay(m).split('-').map(Number);
          return `${year} 年 ${month} 月`;
        },
        formatWeekdayName: (d) => WEEKDAYS[d.getUTCDay()]!,
      }}
      {...(onDayClick && { onDayClick: (d: Date) => onDayClick(toDay(d)) })}
    />
  );
}
