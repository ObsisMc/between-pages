import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';
import { Button } from '../ui/index.ts';

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
 * marked so. Each opens its date in the diary workspace, which shows the same share
 * (book-frontend-workspace D3). The excerpts are diary text and stay in this component's
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
    <section className="border-b border-line pb-8" aria-label={title}>
      <h2 className="mb-4 font-serif text-xl font-medium">{title}</h2>
      {cards === null && loading && <p className="text-sm text-ink-soft">正在读取…</p>}
      {cards?.length === 0 && <p className="text-sm text-ink-soft">对方还没有共享日记</p>}
      {cards && cards.length > 0 && (
        <ul className="mb-4 grid gap-3">
          {cards.map((card) => (
            <li key={card.diaryId}>
              <Link
                className="grid gap-1 rounded-xl border border-line px-4 py-3 text-ink no-underline hover:border-warm focus-visible:border-warm"
                to={`/days/${card.diaryDate}`}
              >
                <span className="font-serif">
                  {dayOf(card.diaryDate)}
                  {card.share === 'frozen' && (
                    <span className="ml-2 font-sans text-sm text-ink-soft">已停止共享</span>
                  )}
                </span>
                <span className={card.excerpt ? 'line-clamp-2' : 'text-sm text-ink-soft'}>
                  {card.excerpt === null ? '这篇暂时无法读取' : card.excerpt || '还没有写字'}
                </span>
                <span className="text-sm text-ink-soft">
                  最后修改 {updatedText.format(new Date(card.updatedAt))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {failed && (
        <p className="rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          {failed === 'offline'
            ? '离线时无法读取对方共享的日记'
            : '对方共享的日记读取失败，请稍后再试'}
        </p>
      )}
      {nextBefore && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void read(nextBefore);
          }}
        >
          加载更早的日记
        </Button>
      )}
    </section>
  );
}
