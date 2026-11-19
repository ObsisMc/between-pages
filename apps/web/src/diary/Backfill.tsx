import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Modifiers } from 'react-day-picker';
import type { ResponseOf } from '@between-pages/contracts';
import { CalendarPlus } from 'lucide-react';
import { callApi } from '../api/client.ts';
import { Button, Calendar, Popover, PopoverContent, PopoverTrigger } from '../ui/index.ts';
import { openFailureText, openOwnDiary, todayHere, type OpenFailure } from './open-day.ts';

// A diary date is a calendar day, never an instant: the calendar runs in UTC, so a day is
// its UTC midnight whatever zone the device is in.
const pad = (n: number) => String(n).padStart(2, '0');
const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** The first day of the month after the one `month` (`YYYY-MM`) names. */
function nextMonthStart(month: string) {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${year + 1}-01-01` : `${year}-${pad(m + 1)}-01`;
}

/**
 * The dates of `month` whose own diary has text, from the day list (`GET /api/days`
 * `before` the next month, a page more while the page still reaches into the month).
 */
async function writtenIn(month: string): Promise<string[]> {
  const start = `${month}-01`;
  const written: string[] = [];
  let before: string | null = nextMonthStart(month);
  while (before) {
    const page: ResponseOf<'days'> = await callApi('days', { query: { before } });
    for (const day of page.days)
      if (day.diaryDate >= start && day.mine?.hasText) written.push(day.diaryDate);
    const oldest: string | undefined = page.days.at(-1)?.diaryDate;
    before = oldest !== undefined && oldest > start ? page.nextBefore : null;
  }
  return written;
}

/** "11 月 6 日，你写过，今天" — what a screen reader hears for a day, and what tests click. */
function dayLabel(day: string, modifiers: Modifiers) {
  const [, month, date] = day.split('-').map(Number) as [number, number, number];
  const notes = [
    ...(modifiers.written ? ['你写过'] : []),
    ...(modifiers.today ? ['今天'] : []),
    ...(modifiers.disabled ? ['还没到'] : []),
  ];
  return [`${month} 月 ${date} 日`, ...notes].join('，');
}

/**
 * "补写…": a calendar of the device's months up to today, the days after today disabled and
 * the days the caller wrote on dotted (a mark, not only a color). Choosing a day opens or
 * creates its own diary (`openOwnDiary`) and, once the server has answered, calls
 * `onOpened(date)`; a refusal or no connection says so in the calendar, which stays open.
 * It reads the day list only, never a diary's text.
 */
export function Backfill({
  onOpened,
  className,
}: {
  onOpened: (date: string) => void;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const today = todayHere();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [opening, setOpening] = useState<string | null>(null);
  const [failure, setFailure] = useState<OpenFailure | null>(null);
  const written = useQuery({
    queryKey: ['backfill-written', month],
    queryFn: () => writtenIn(month),
    enabled: open,
  });
  const writtenSet = new Set(written.data);

  const choose = async (date: string) => {
    if (opening) return;
    setFailure(null);
    setOpening(date);
    const opened = await openOwnDiary(date);
    setOpening(null);
    if ('failure' in opened) return setFailure(opened.failure);
    setOpen(false);
    onOpened(opened.diary.diaryDate);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setFailure(null);
          setMonth(todayHere().slice(0, 7));
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={className}>
          <CalendarPlus aria-hidden="true" />
          补写…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))]" aria-label="补写哪一天">
        <p className="mb-2 font-serif text-base text-ink">补写哪一天</p>
        <Calendar
          timeZone="UTC"
          today={toDate(today)}
          month={toDate(`${month}-01`)}
          onMonthChange={(m) => setMonth(toDay(m).slice(0, 7))}
          endMonth={toDate(today)}
          disabled={{ after: toDate(today) }}
          modifiers={{ written: (d) => writtenSet.has(toDay(d)) }}
          modifiersClassNames={{
            written:
              'after:pointer-events-none after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-ink',
          }}
          labels={{
            labelPrevious: () => '上个月',
            labelNext: () => '下个月',
            labelDayButton: (d, modifiers) => dayLabel(toDay(d), modifiers),
            labelGridcell: (d, modifiers) => dayLabel(toDay(d), modifiers ?? {}),
          }}
          formatters={{
            formatCaption: (m) => `${m.getUTCFullYear()} 年 ${m.getUTCMonth() + 1} 月`,
            formatWeekdayName: (d) => WEEKDAYS[d.getUTCDay()]!,
          }}
          onDayClick={(d, modifiers) => {
            if (!modifiers.disabled) void choose(toDay(d));
          }}
        />
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-soft">
          <span aria-hidden="true" className="size-1 rounded-full bg-ink" />
          {written.isError ? '暂时无法读取写过的日子' : '你写过的日子'}
        </p>
        {opening && <p className="mt-2 text-sm text-ink-soft">正在打开…</p>}
        {failure && (
          <p className="mt-2 rounded-lg bg-notice px-3 py-2 text-sm" role="alert">
            {openFailureText[failure]}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
