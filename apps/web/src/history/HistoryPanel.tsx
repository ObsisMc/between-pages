import { useInfiniteQuery } from '@tanstack/react-query';
import { callApi } from '../api/client.ts';
import type { HistoryPointView } from './format.ts';
import { dayOf, dayLabel, timeLabel } from './format.ts';

/** The cache key of one diary's history pages; metadata only, never diary text. */
export const historyQueryKey = (diaryId: string) => ['history', diaryId] as const;

/**
 * The diary's own read-only history (kernel D6): points newest first, grouped by the
 * viewer's local day, one server page at a time. The points carry no text.
 */
export function HistoryPanel({
  diaryId,
  selected,
  onSelect,
}: {
  diaryId: string;
  selected: string | null;
  onSelect: (point: HistoryPointView) => void;
}) {
  const history = useInfiniteQuery({
    queryKey: historyQueryKey(diaryId),
    queryFn: ({ pageParam }) =>
      callApi('history', {
        params: { diaryId },
        query: pageParam ? { cursor: pageParam } : {},
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

  const points = history.data?.pages.flatMap((page) => page.points) ?? [];
  const days: { day: string; points: typeof points }[] = [];
  for (const point of points) {
    const day = dayOf(point.committedAt);
    if (days.at(-1)?.day !== day) days.push({ day, points: [] });
    days.at(-1)!.points.push(point);
  }

  return (
    <aside className="history" aria-label="历史版本">
      <h2>历史版本</h2>
      {history.isPending && <p className="history-note">正在读取…</p>}
      {history.isError && (
        <p className="notice" role="alert">
          历史读取失败，请稍后再试
        </p>
      )}
      {history.isSuccess && points.length === 0 && <p className="history-note">还没有历史版本</p>}
      {days.map(({ day, points: ofDay }) => (
        <section key={day}>
          <h3>{dayLabel(ofDay[0]!.committedAt)}</h3>
          <ul>
            {ofDay.map((point) => (
              <li key={point.publicId}>
                <button
                  type="button"
                  aria-pressed={selected === point.publicId}
                  onClick={() => onSelect(point)}
                >
                  {timeLabel(point.committedAt)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {history.hasNextPage && (
        <button
          type="button"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          加载更早的版本
        </button>
      )}
    </aside>
  );
}
