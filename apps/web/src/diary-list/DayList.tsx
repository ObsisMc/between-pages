import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Day, ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';
import { Avatar, type AvatarPerson } from '../avatar/index.ts';

type Failure = 'offline' | 'failed';
type Shown = { days: Day[]; nextBefore: string | null; pages: number };

/** How often the list is read again while the home page stays open (unread-and-day-page D3). */
export const REFRESH_MS = 45_000;

// A diary date is a calendar day, not an instant: shown as written, in no time zone.
const dateText = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  weekday: 'short',
  timeZone: 'UTC',
});
const datedYearText = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
  timeZone: 'UTC',
});
// The last change is an instant, shown in the viewer's own time zone (spec §8.2).
const updatedText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function dateLabel(diaryDate: string) {
  const [year, month, day] = diaryDate.split('-').map(Number) as [number, number, number];
  const format = year === new Date().getFullYear() ? dateText : datedYearText;
  return format.format(new Date(Date.UTC(year, month - 1, day)));
}

const failureText: Record<Failure, string> = {
  offline: '离线时无法读取日记列表，联网后再试',
  failed: '日记列表读取失败，请稍后再试',
};

const excerptText = (excerpt: string | null) =>
  excerpt === null ? '这篇暂时无法读取' : excerpt || '还没有写字';

/** The first `pages` pages, from the newest date, as one list. */
async function readPages(pages: number): Promise<Shown> {
  const days: Day[] = [];
  let before: string | null = null;
  let read = 0;
  do {
    const page: ResponseOf<'days'> = await callApi('days', { query: before ? { before } : {} });
    days.push(...page.days);
    before = page.nextBefore;
    read++;
  } while (before && read < pages);
  return { days, nextBefore: before, pages: read };
}

/**
 * Both people's diaries merged by date, newest first (unread-and-day-page D3): one card per
 * date with an initial avatar for each person who has a diary on it (hollow while it has no
 * text), a dot when either has list unread, and a link to each diary. It is read again on
 * entry, when the page comes back to the foreground, and every REFRESH_MS while shown,
 * keeping as many pages as were loaded. Excerpts are diary text, so they stay in this
 * component's state and never enter Query (ADR-0006 §8).
 */
export function DayList({ me, partner }: { me: AvatarPerson; partner: AvatarPerson }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const pages = useRef(1);
  // Only the latest read may change the list; an older one finishing late is dropped.
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++generation.current;
    readPages(pages.current).then(
      (read) => {
        if (mine !== generation.current) return;
        setShown(read);
        setFailure(null);
        setLoading(false);
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        // The cards stay, without unread dots that may no longer be true (D3 失败与恢复).
        setFailure(error instanceof ApiError ? 'failed' : 'offline');
        setLoading(false);
      },
    );
  }, []);

  const loadMore = (before: string) => {
    const mine = ++generation.current;
    setLoading(true);
    callApi('days', { query: { before } }).then(
      (page) => {
        if (mine !== generation.current) return;
        pages.current++;
        setShown((list) => ({
          days: [...(list?.days ?? []), ...page.days],
          nextBefore: page.nextBefore,
          pages: pages.current,
        }));
        setLoading(false);
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        setFailure(error instanceof ApiError ? 'failed' : 'offline');
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    const reads = generation;
    refresh();
    const onForeground = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = setInterval(onForeground, REFRESH_MS);
    window.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
      // A read still in flight must not land on an unmounted list.
      reads.current++;
    };
  }, [refresh]);

  const days = shown?.days;
  return (
    <section className="diary-list" aria-label="日记">
      <h2>日记</h2>
      {!days && loading && <p className="list-note">正在读取…</p>}
      {days?.length === 0 && <p className="list-note">还没有日记，从今天开始写吧</p>}
      {days && days.length > 0 && (
        <ul>
          {days.map((day) => {
            const unread = !failure && (day.mine?.unread || day.partner?.unread);
            const sides = [
              day.mine && { person: me, side: day.mine, to: `/diaries/${day.mine.diaryId}` },
              day.partner && {
                person: partner,
                side: day.partner,
                to: `/diaries/${day.partner.diaryId}/shares/${day.partner.epochId}`,
              },
            ]
              .filter((s) => !!s)
              .sort((a, b) => (a.person.slot ?? 1) - (b.person.slot ?? 1));
            const updatedAt = Math.max(...sides.map((s) => Date.parse(s.side.updatedAt)));
            return (
              <li key={day.diaryDate} className="day-card">
                <div className="day-card-head">
                  <span className="diary-card-date">{dateLabel(day.diaryDate)}</span>
                  <span className="day-card-avatars">
                    {sides.map((s) => (
                      <Avatar key={s.to} person={s.person} hollow={!s.side.hasText} />
                    ))}
                  </span>
                  {unread && <span className="unread-dot" role="img" aria-label="有新内容" />}
                </div>
                {sides.map((s) => (
                  <Link key={s.to} className="diary-card" to={s.to}>
                    {sides.length > 1 && <span className="diary-card-who">{s.person.name}</span>}
                    {'share' in s.side && s.side.share === 'frozen' && (
                      <span className="share-state">已停止共享</span>
                    )}
                    <span
                      className={s.side.excerpt ? 'diary-card-excerpt' : 'diary-card-excerpt empty'}
                    >
                      {excerptText(s.side.excerpt)}
                    </span>
                  </Link>
                ))}
                <span className="diary-card-updated">
                  最后修改 {updatedText.format(new Date(updatedAt))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {failure && (
        <p className="notice" role="alert">
          {failureText[failure]}
        </p>
      )}
      {shown?.nextBefore && (
        <button
          type="button"
          disabled={loading}
          onClick={() => shown.nextBefore && loadMore(shown.nextBefore)}
        >
          加载更早的日记
        </button>
      )}
    </section>
  );
}
