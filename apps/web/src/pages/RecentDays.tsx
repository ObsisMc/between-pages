import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowRight, ChevronRight } from 'lucide-react';
import type { Day } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { Mascot, type MascotTone } from '../avatar/index.ts';
import { localToday } from './today.ts';

// The home's recent dates (digital-paper-interface D2, invariant 9): for each, the date, who
// wrote and whether the partner left something unread, and never any diary text: the day
// list's excerpts are not rendered here. Opening a date is the explicit entry to its text.

export const RECENT_DAYS = 3;

export type HomePerson = { name: string; tone: MascotTone };

const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'UTC' });

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** "今天", "昨天", or "10 月 30 日", with the weekday. */
function dateLabel(date: string, today: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const named =
    date === today
      ? '今天'
      : date === addDays(today, -1)
        ? '昨天'
        : `${day.getUTCMonth() + 1} 月 ${day.getUTCDate()} 日`;
  return `${named} · ${weekday.format(day)}`;
}

function whoWrote(day: Day, me: HomePerson, partner: HomePerson): string {
  const mine = !!day.mine?.hasText;
  const theirs = !!day.partner?.hasText;
  if (mine && theirs) return `你和${partner.name}都写了`;
  if (theirs) return `${partner.name}写了`;
  if (mine) return '你写了';
  return '还没有写字';
}

export function RecentDays({ me, partner }: { me: HomePerson; partner: HomePerson }) {
  const days = useQuery({
    queryKey: ['home', 'days'],
    queryFn: () => callApi('days', { query: {} }),
  });
  const today = localToday();
  const recent = days.data?.days.slice(0, RECENT_DAYS) ?? [];
  return (
    <section aria-labelledby="recent-days-title">
      <div className="flex items-baseline justify-between">
        <h2 id="recent-days-title" className="font-serif text-2xl text-ink">
          最近的几页
        </h2>
        <Link
          to="/days"
          className="inline-flex items-center gap-1 text-sm text-ink-soft no-underline hover:text-ink"
        >
          所有日记
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
      {days.isError ? (
        <p className="mt-6 text-sm text-ink-soft">暂时读不到日记列表，稍后再看</p>
      ) : days.data && recent.length === 0 ? (
        <p className="mt-6 text-sm text-ink-soft">还没有日记，从今天开始写吧</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {recent.map((day) => {
            const unread = !!(day.partner?.unread || day.mine?.unread);
            const writers = [
              ...(day.mine?.hasText ? [me] : []),
              ...(day.partner?.hasText ? [partner] : []),
            ];
            return (
              <li key={day.diaryDate}>
                <Link
                  to={`/days/${day.diaryDate}`}
                  className="group flex items-center gap-5 py-4 text-ink no-underline"
                >
                  <span className="w-12 font-serif text-4xl leading-none text-ink-soft/80 tabular-nums">
                    {day.diaryDate.slice(8)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base group-hover:underline">
                      {dateLabel(day.diaryDate, today)}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
                      {writers.length > 0 && (
                        <span className="flex -space-x-1.5">
                          {writers.map((person) => (
                            <Mascot key={person.name} tone={person.tone} size={22} />
                          ))}
                        </span>
                      )}
                      {whoWrote(day, me, partner)}
                      {unread && (
                        <span className="inline-flex items-center gap-1.5 text-warm">
                          <span className="size-1.5 rounded-full bg-warm" aria-hidden="true" />
                          {day.partner?.unread ? `${partner.name}有新内容` : '有新内容'}
                        </span>
                      )}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 text-ink-soft" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
