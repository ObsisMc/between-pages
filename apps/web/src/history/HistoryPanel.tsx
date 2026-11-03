import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { HistoryPointView } from './format.ts';
import { Button, cn } from '../ui/index.ts';
import { countdownLabel, dayOf, dayLabel, timeLabel } from './format.ts';

/** The cache key of one diary's history pages; metadata only, never diary text. */
export const historyQueryKey = (diaryId: string) => ['history', diaryId] as const;

/** Past the server's estimate, so the group is closed when asked again. */
const CLOSE_MARGIN_MS = 500;
/** Commits closer together than this are one stretch of typing, asked about once. */
const SETTLE_MS = 1_000;

/**
 * The diary's own read-only history (kernel D6): points newest first, grouped by the
 * viewer's local day, one server page at a time. The points carry no text. A point
 * appears only once its group closes, so the open panel counts down to the close the
 * server reports, asks again then, and asks again once commits settle, since each one may
 * start a group or move its close later.
 */
export function HistoryPanel({
  diaryId,
  commits,
  selected,
  onSelect,
}: {
  diaryId: string;
  /** Commits applied to the open diary so far; a change may start or extend a group. */
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
  const { refetch, dataUpdatedAt } = history;
  const nextPointInMs = history.data?.pages[0]?.nextPointInMs ?? null;
  // By this device's clock: the server reports a duration, not its own time.
  const closesAt = nextPointInMs === null ? null : dataUpdatedAt + nextPointInMs;

  useEffect(() => {
    if (closesAt === null) return;
    const timer = setTimeout(() => void refetch(), closesAt - Date.now() + CLOSE_MARGIN_MS);
    return () => clearTimeout(timer);
  }, [closesAt, refetch]);

  const seenCommits = useRef(commits);
  useEffect(() => {
    if (commits === seenCommits.current) return;
    seenCommits.current = commits;
    const timer = setTimeout(() => void refetch(), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [commits, refetch]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (closesAt === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [closesAt]);
  // `now` stops ticking while no group is open; the answer's own time is never older.
  const left = closesAt === null ? null : closesAt - Math.max(now, dataUpdatedAt);

  const points = history.data?.pages.flatMap((page) => page.points) ?? [];
  const days: { day: string; points: typeof points }[] = [];
  for (const point of points) {
    const day = dayOf(point.committedAt);
    if (days.at(-1)?.day !== day) days.push({ day, points: [] });
    days.at(-1)!.points.push(point);
  }

  return (
    <aside
      className="mt-6 grid gap-3 rounded-2xl border border-line p-5 text-sm"
      aria-label="历史版本"
    >
      <h2 className="font-serif text-lg font-medium">历史版本</h2>
      {history.isPending && <p className="text-ink-soft">正在读取…</p>}
      {history.isError && (
        <p className="rounded-xl bg-notice px-4 py-3" role="alert">
          历史读取失败，请稍后再试
        </p>
      )}
      {left !== null && (
        <p className="text-ink-soft">
          {left > 0 ? `正在写的这段约 ${countdownLabel(left)}后成为历史版本` : '正在生成历史版本…'}
        </p>
      )}
      {history.isSuccess && points.length === 0 && <p className="text-ink-soft">还没有历史版本</p>}
      {days.map(({ day, points: ofDay }) => (
        <section key={day}>
          <h3 className="mb-2 text-ink-soft">{dayLabel(ofDay[0]!.committedAt)}</h3>
          <ul className="flex flex-wrap gap-2">
            {ofDay.map((point) => (
              <li key={point.publicId}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    'tabular-nums',
                    selected === point.publicId && 'border-warm bg-accent text-warm',
                  )}
                  aria-pressed={selected === point.publicId}
                  onClick={() => onSelect(point)}
                >
                  {timeLabel(point.committedAt)}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {history.hasNextPage && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-self-start"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          加载更早的版本
        </Button>
      )}
    </aside>
  );
}
