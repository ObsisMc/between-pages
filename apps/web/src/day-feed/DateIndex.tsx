import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import type { Day } from '@between-pages/contracts';
import { Mascot } from '../avatar/index.ts';
import type { FeedPerson } from './DayFeed.tsx';
import type { Entry } from './model.ts';
import { useDayFeed, type Failure, type Loading } from './useDayFeed.ts';

// The diary page's date index (digital-paper-interface D2): every date the caller can see,
// newest first, loaded a page at a time at either end like the feed, each with who wrote
// and the list's unread mark. It reads the day list only, never a diary's text, so nothing
// in it can count as read (invariant 3).

const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'UTC' });

/** "11 月 3 日 · 周二", the date as written, in no time zone. */
function dayLabel(date: string) {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return `${month} 月 ${day} 日 · ${weekday.format(new Date(Date.UTC(year, month - 1, day)))}`;
}

const monthLabel = (date: string) => `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`;

/** The entries in runs of one month each, newest first. */
function byMonth(entries: readonly Entry[]) {
  const months: { month: string; entries: Entry[] }[] = [];
  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    if (months.at(-1)?.month === month) months.at(-1)!.entries.push(entry);
    else months.push({ month, entries: [entry] });
  }
  return months;
}

/** Who wrote on a date, by name: a diary someone wrote in, never one still blank. */
function writersOf(day: Day | null, me: FeedPerson, partner: FeedPerson) {
  if (!day) return [];
  return [...(day.mine?.hasText ? [me] : []), ...(day.partner?.hasText ? [partner] : [])].sort(
    (a, b) => (a.slot ?? 1) - (b.slot ?? 1),
  );
}

const failureText: Record<Failure['kind'], string> = {
  offline: '离线时无法读取日期',
  failed: '日期读取失败',
};

const edgeButton =
  'w-full min-h-0 rounded-lg border-0 bg-transparent px-3 py-2 text-sm text-ink-soft hover:bg-accent hover:text-ink';

/**
 * The index: `chosenDate`, the date the main area shows, is marked and kept in view, and is
 * jumped to when it is not loaded (two requests around it, never paging from the newest);
 * without one it starts from the newest. Choosing a date calls `onChoose`, else its link
 * navigates.
 */
export function DateIndex({
  me,
  partner,
  chosenDate = null,
  onChoose,
}: {
  me: FeedPerson;
  partner: FeedPerson;
  chosenDate?: string | null;
  onChoose?: (date: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const dates = useRef<string[]>([]);
  const { feedWindow, loading, failure, start, jump, older, newer } = useDayFeed(
    useCallback(() => dates.current, []),
  );
  const entries = feedWindow?.entries;
  useEffect(() => {
    dates.current = entries?.map((entry) => entry.date) ?? [];
  });

  // What this mount asked for: a remount (StrictMode's included) drops the reads in flight,
  // so it asks again.
  const asked = useRef<string | null | undefined>(undefined);
  useEffect(
    () => () => {
      asked.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (chosenDate === null) {
      if (asked.current === undefined) {
        asked.current = null;
        start();
      }
      return;
    }
    if (asked.current === chosenDate || entries?.some((entry) => entry.date === chosenDate)) return;
    asked.current = chosenDate;
    jump(chosenDate);
  }, [chosenDate, entries, start, jump]);

  // The chosen date is scrolled into the index's box once it is there, inside the box only.
  const placed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = box.current;
    const row = chosenDate && root?.querySelector<HTMLElement>(`[data-date="${chosenDate}"]`);
    if (!root || !row || placed.current === chosenDate) return;
    placed.current = chosenDate;
    const seen = root.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < seen.top || at.bottom > seen.bottom)
      root.scrollTop += at.top - seen.top - (seen.bottom - seen.top) / 3;
  }, [chosenDate, entries]);

  // A page more at an end that comes within a screen of the box.
  const [edges, setEdges] = useState({ newer: false, older: false });
  useEffect(() => {
    const root = box.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (changes) => {
        for (const { target, isIntersecting } of changes) {
          const edge = (target as HTMLElement).dataset.edge as 'newer' | 'older';
          setEdges((e) => (e[edge] === isIntersecting ? e : { ...e, [edge]: isIntersecting }));
        }
      },
      { root, rootMargin: '100% 0px' },
    );
    for (const el of root.querySelectorAll('[data-edge]')) observer.observe(el);
    return () => observer.disconnect();
  }, [entries]);
  useEffect(() => {
    if (edges.older && !failure) older();
  }, [edges.older, failure, loading, entries, older]);
  useEffect(() => {
    if (edges.newer && !failure) newer();
  }, [edges.newer, failure, loading, entries, newer]);

  const choosing = (date: string) =>
    onChoose &&
    ((event: MouseEvent) => {
      event.preventDefault();
      onChoose(date);
    });
  const busy = loading === 'start' || loading === 'jump';
  return (
    <nav aria-label="日期索引" className="flex min-h-0 flex-1 flex-col">
      <div ref={box} className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {busy && <p className="px-3 py-2 text-sm text-ink-soft">正在读取…</p>}
        {feedWindow?.nextAfter && (
          <div data-edge="newer">
            <EdgeButton busy={loading} end="newer" onLoad={newer}>
              更新的日期
            </EdgeButton>
          </div>
        )}
        {entries &&
          byMonth(entries).map(({ month, entries: days }) => (
            <section key={month} aria-label={monthLabel(days[0]!.date)} className="mt-3">
              <h3 className="px-3 py-1 text-xs font-normal tracking-wide text-ink-soft">
                {monthLabel(days[0]!.date)}
              </h3>
              <ul className="space-y-0.5">
                {days.map(({ date, day }) => {
                  const writers = writersOf(day, me, partner);
                  const unread = !failure && !!(day?.mine?.unread || day?.partner?.unread);
                  return (
                    <li key={date} data-date={date}>
                      <Link
                        to={`/days/${date}`}
                        aria-current={date === chosenDate ? 'page' : undefined}
                        onClick={choosing(date)}
                        className="flex items-center gap-2 rounded-xl border border-transparent px-3 py-2 text-ink no-underline hover:bg-accent aria-[current=page]:border-line aria-[current=page]:bg-paper aria-[current=page]:shadow-sm"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm">{dayLabel(date)}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-soft">
                            {writers.length > 0 ? (
                              <>
                                <span className="flex -space-x-1">
                                  {writers.map((person) => (
                                    <Mascot key={person.id} tone={person.slot} size={16} />
                                  ))}
                                </span>
                                <span className="truncate">
                                  {writers.map((person) => person.name).join('、')}
                                </span>
                              </>
                            ) : (
                              <span>{day ? '还没有写字' : '没有可以读的日记'}</span>
                            )}
                          </span>
                        </span>
                        {unread && (
                          <span
                            className="size-1.5 shrink-0 rounded-full bg-warm"
                            role="img"
                            aria-label="有新内容"
                          />
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        {entries?.length === 0 && <p className="px-3 py-2 text-sm text-ink-soft">还没有日记</p>}
        {feedWindow?.nextBefore ? (
          <div data-edge="older">
            <EdgeButton busy={loading} end="older" onLoad={older}>
              更早的日期
            </EdgeButton>
          </div>
        ) : (
          !!entries?.length && (
            <p className="px-3 py-3 text-center text-xs text-ink-soft">已经是最早的一天</p>
          )
        )}
        {failure && (
          <div className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-notice px-3 py-2 text-sm">
            <p role="alert" className="flex-1">
              {failureText[failure.kind]}
            </p>
            <button
              type="button"
              className="min-h-0 rounded-lg border-0 bg-transparent px-2 py-1 text-ink underline"
              onClick={failure.retry}
            >
              重试
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}

/** As the feed's: mounted and enabled while any page loads, so a keyboard user keeps focus. */
function EdgeButton({
  busy,
  end,
  onLoad,
  children,
}: {
  busy: Loading | null;
  end: 'newer' | 'older';
  onLoad: () => void;
  children: string;
}) {
  return (
    <button type="button" className={edgeButton} aria-disabled={!!busy} onClick={onLoad}>
      {busy === end ? '正在读取…' : children}
    </button>
  );
}
