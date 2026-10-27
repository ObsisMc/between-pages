import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';

type DiaryCard = ResponseOf<'diaries'>['diaries'][number];
type Failure = 'offline' | 'failed';

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

/**
 * The owner's diaries as cards, newest date first, one server page at a time. The excerpts
 * are diary text, so they stay in this component's state and never enter Query
 * (ADR-0006 §8); returning to the page reads them again.
 */
export function DiaryList() {
  const [cards, setCards] = useState<DiaryCard[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);

  const read = (before: string | null) =>
    callApi('diaries', { query: before ? { before } : {} }).then(
      (page) => {
        setCards((shown) => [...(before ? (shown ?? []) : []), ...page.diaries]);
        setNextBefore(page.nextBefore);
        setLoading(false);
      },
      (error: unknown) => {
        setFailure(error instanceof ApiError ? 'failed' : 'offline');
        setLoading(false);
      },
    );

  const loadMore = (before: string) => {
    setLoading(true);
    setFailure(null);
    void read(before);
  };

  // Read once per visit: returning home shows the diaries as they are now.
  useEffect(() => void read(null), []);

  return (
    <section className="diary-list" aria-label="我的日记">
      <h2>我的日记</h2>
      {cards === null && loading && <p className="list-note">正在读取…</p>}
      {cards?.length === 0 && <p className="list-note">还没有日记，从今天开始写吧</p>}
      {cards && cards.length > 0 && (
        <ul>
          {cards.map((card) => (
            <li key={card.diaryId}>
              <Link className="diary-card" to={`/diaries/${card.diaryId}`}>
                <span className="diary-card-date">{dateLabel(card.diaryDate)}</span>
                <span className={card.excerpt ? 'diary-card-excerpt' : 'diary-card-excerpt empty'}>
                  {card.excerpt === null ? '这篇暂时无法读取' : card.excerpt || '还没有写字'}
                </span>
                <span className="diary-card-updated">
                  最后修改 {updatedText.format(new Date(card.updatedAt))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <p className="notice" role="alert">
          {failureText[failure]}
        </p>
      )}
      {nextBefore && (
        <button type="button" disabled={loading} onClick={() => loadMore(nextBefore)}>
          加载更早的日记
        </button>
      )}
    </section>
  );
}
