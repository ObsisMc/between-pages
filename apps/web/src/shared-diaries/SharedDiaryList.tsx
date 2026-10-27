import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';

type SharedCard = ResponseOf<'sharedDiaries'>['diaries'][number];

// A diary date is a calendar day, not an instant: shown as written, in no time zone.
const dateText = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
  timeZone: 'UTC',
});
const dayOf = (diaryDate: string) => {
  const [year, month, day] = diaryDate.split('-').map(Number) as [number, number, number];
  return dateText.format(new Date(Date.UTC(year, month - 1, day)));
};
// The last change is an instant, in the viewer's own time zone (spec §8.2).
const updatedText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The diaries the partner shares with the caller in one space, newest date first (kernel
 * D5, spaces-and-invitations D4): each by its live share, or else its last frozen one,
 * marked so. Like the own list, the excerpts are diary text and stay in this component's
 * state, never in Query (ADR-0006 §8).
 */
export function SharedDiaryList({ spaceId, partner }: { spaceId: string; partner: string }) {
  const [cards, setCards] = useState<SharedCard[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<'offline' | 'failed' | null>(null);

  const read = useCallback(
    (before: string | null) =>
      callApi('sharedDiaries', { params: { spaceId }, query: before ? { before } : {} }).then(
        (page) => {
          setCards((shown) => [...(before ? (shown ?? []) : []), ...page.diaries]);
          setNextBefore(page.nextBefore);
          setLoading(false);
        },
        (error: unknown) => {
          setFailed(error instanceof ApiError ? 'failed' : 'offline');
          setLoading(false);
        },
      ),
    [spaceId],
  );

  // Read once per visit, like the own list.
  useEffect(() => void read(null), [read]);

  const title = `${partner} 共享的日记`;
  return (
    <section className="diary-list shared-diaries" aria-label={title}>
      <h2>{title}</h2>
      {cards === null && loading && <p className="list-note">正在读取…</p>}
      {cards?.length === 0 && <p className="list-note">对方还没有共享日记</p>}
      {cards && cards.length > 0 && (
        <ul>
          {cards.map((card) => (
            <li key={card.diaryId}>
              <Link className="diary-card" to={`/diaries/${card.diaryId}/shares/${card.epochId}`}>
                <span className="diary-card-date">{dayOf(card.diaryDate)}</span>
                {card.share === 'frozen' && <span className="share-state">已停止共享</span>}
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
      {failed && (
        <p className="notice" role="alert">
          {failed === 'offline'
            ? '离线时无法读取对方共享的日记'
            : '对方共享的日记读取失败，请稍后再试'}
        </p>
      )}
      {nextBefore && (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void read(nextBefore);
          }}
        >
          加载更早的日记
        </button>
      )}
    </section>
  );
}
