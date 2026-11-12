import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, callApi } from '../api/client.ts';
import type { Anchor } from './anchor.ts';
import {
  addDays,
  fromNewest,
  jumpedTo,
  refreshQuery,
  refreshed,
  withNewer,
  withOlder,
  type FeedWindow,
} from './model.ts';

/** How often the dates near the viewport are read again while the feed is shown (D8). */
export const REFRESH_MS = 45_000;

export type Loading = 'start' | 'jump' | 'older' | 'newer';
export type Failure = { kind: 'offline' | 'failed'; retry: () => void };

const kindOf = (error: unknown) => (error instanceof ApiError ? 'failed' : 'offline');

/**
 * The list's dates (book-frontend-workspace D4, D8): the first page from the newest
 * (`start`), a page more at either end, a jump to any date, and the dates near the viewport
 * read again on window focus, on the page coming back and every REFRESH_MS while visible.
 * A start or a jump begins a new window; answers for an earlier one are dropped, and of the
 * refreshes only the latest applies. A failure keeps what is shown and offers its retry.
 */
export function useDayFeed(nearDates: () => readonly string[]) {
  const [feedWindow, setWindow] = useState<FeedWindow | null>(null);
  const [loading, setLoading] = useState<Loading | null>('start');
  const [failure, setFailure] = useState<Failure | null>(null);
  /**
   * The date a jump brought into the window, to show once rendered: at the top, or where
   * `at` held it.
   */
  const [target, setTarget] = useState<{ date: string; at?: Anchor } | null>(null);
  const current = useRef<FeedWindow | null>(null);
  const loadingRef = useRef<Loading | null>('start');
  const epoch = useRef(0);
  const refreshes = useRef(0);

  // In the commit itself: a focus or timer in the task that shows a page must see it loaded,
  // or its refresh is dropped as if the page were still coming.
  useLayoutEffect(() => {
    current.current = feedWindow;
    loadingRef.current = loading;
  });

  /** Runs one read for the current window; its answer applies only while that window lasts. */
  const run = useCallback(
    <T>(kind: Loading, read: () => Promise<T>, apply: (answer: T) => void, fresh = false) => {
      const mine = fresh ? ++epoch.current : epoch.current;
      loadingRef.current = kind;
      setLoading(kind);
      function attempt() {
        read().then(
          (answer) => {
            if (mine !== epoch.current) return;
            apply(answer);
            setFailure(null);
            setLoading(null);
          },
          (error: unknown) => {
            if (mine !== epoch.current) return;
            setFailure({
              kind: kindOf(error),
              retry: () => {
                setFailure(null);
                setLoading(kind);
                attempt();
              },
            });
            setLoading(null);
          },
        );
      }
      attempt();
    },
    [],
  );

  const start = useCallback(
    () =>
      run(
        'start',
        () => callApi('days', { query: {} }),
        (page) => setWindow(fromNewest(page)),
        true,
      ),
    [run],
  );

  const jump = useCallback(
    (date: string, at?: Anchor) =>
      run(
        'jump',
        () =>
          Promise.all([
            callApi('days', { query: { before: addDays(date, 1) } }),
            callApi('days', { query: { after: date } }),
          ]),
        ([older, newer]) => {
          setWindow(jumpedTo(date, older, newer));
          setTarget(at ? { date, at } : { date });
        },
        true,
      ),
    [run],
  );

  const older = useCallback(() => {
    const before = current.current?.nextBefore;
    if (!before || loadingRef.current) return;
    run(
      'older',
      () => callApi('days', { query: { before } }),
      (page) => setWindow((w) => (w?.nextBefore === before ? withOlder(w, page) : w)),
    );
  }, [run]);

  const newer = useCallback(() => {
    const after = current.current?.nextAfter;
    if (!after || loadingRef.current) return;
    run(
      'newer',
      () => callApi('days', { query: { after } }),
      (page) => setWindow((w) => (w?.nextAfter === after ? withNewer(w, page) : w)),
    );
  }, [run]);

  const nearRef = useRef(nearDates);
  useEffect(() => {
    nearRef.current = nearDates;
  });

  const refresh = useCallback(function refreshNear() {
    const shown = current.current;
    if (!shown || loadingRef.current === 'start' || loadingRef.current === 'jump') return;
    const mine = epoch.current;
    const latest = ++refreshes.current;
    const query = refreshQuery(shown, [...nearRef.current()].sort().at(-1));
    callApi('days', { query }).then(
      (page) => {
        if (mine !== epoch.current || latest !== refreshes.current) return;
        setWindow((w) => w && refreshed(w, query, page));
        setFailure(null);
      },
      (error: unknown) => {
        if (mine !== epoch.current || latest !== refreshes.current) return;
        // The text stays; the dots from the list go out until a read succeeds (D4 失败与恢复).
        setFailure({ kind: kindOf(error), retry: refreshNear });
      },
    );
  }, []);

  useEffect(() => {
    const reads = epoch;
    const onForeground = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = setInterval(onForeground, REFRESH_MS);
    globalThis.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    return () => {
      clearInterval(timer);
      globalThis.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
      // Reads still in flight must not land on an unmounted feed.
      reads.current++;
    };
  }, [refresh]);

  return { feedWindow, loading, failure, target, start, jump, older, newer };
}
