import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { callApi } from '../api/client.ts';
import type { HistoryPointView } from './format.ts';
import { dayOf, dayLabel, timeLabel } from './format.ts';

/** The cache key of one diary's history pages; metadata only, never diary text. */
export const historyQueryKey = (diaryId: string) => ['history', diaryId] as const;

/** Past the server's estimate, so the group is closed when asked again. */
const CLOSE_MARGIN_MS = 500;

/**
 * The diary's own read-only history (kernel D6): points newest first, grouped by the
 * viewer's local day, one server page at a time. The points carry no text. A point
 * appears only once its group closes, so the open panel asks again when the server says
 * the group being written will close, and after a commit starts a new group.
 */
export function HistoryPanel({
  diaryId,
  commits,
  selected,
  onSelect,
}: {
  diaryId: string;
  /** Commits applied to the open diary so far; a change may start a new group. */
  commits: number;
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
  const { refetch, dataUpdatedAt, isFetching } = history;
  const nextPointInMs = history.data?.pages[0]?.nextPointInMs ?? null;

  // Each answer either holds the new point or says when to ask next; a commit that joins
  // the open group only moves that time later, which the next answer reports.
  useEffect(() => {
    if (nextPointInMs === null) return;
    const timer = setTimeout(() => void refetch(), nextPointInMs + CLOSE_MARGIN_MS);
    return () => clearTimeout(timer);
  }, [nextPointInMs, dataUpdatedAt, refetch]);

  // An answer already on its way may predate the commit, so it is asked again too.
  const seenCommits = useRef(commits);
  useEffect(() => {
    if (commits === seenCommits.current) return;
    seenCommits.current = commits;
    if (nextPointInMs === null || isFetching) void refetch();
  }, [commits, nextPointInMs, isFetching, refetch]);

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
