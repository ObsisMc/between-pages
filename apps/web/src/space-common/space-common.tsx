import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SpaceRecordType } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';
import { Button, cn } from '../ui/index.ts';

// What every space feature beyond the diary shows the same way (space-records ADR): the
// entry dot, records reported as seen once on screen for about a second, "有 N 处新内容 ·
// 跳到第一处" and "下一处", the read-only notice after unbinding, and who did what when. It
// knows no feature; each feature's page passes its own records.

/** How long a record must stay on a visible page to count as seen (D8, as in the diary). */
export const SEEN_DWELL_MS = 1_000;
/** The entry-dot summary; features refresh it after a write. */
export const spaceUnreadKey = ['space-unread'] as const;

/** Unread per feature for the entry dots, refreshed like the day list. */
/** With `inBackground`, it keeps reading while the page is hidden, for the icon badge. */
export const useSpaceUnread = (enabled: boolean, inBackground = false) =>
  useQuery({
    queryKey: spaceUnreadKey,
    queryFn: () => callApi('spaceUnread'),
    enabled,
    refetchInterval: 45_000,
    refetchIntervalInBackground: inBackground,
  });

export function EntryDot({ count }: { count: number | undefined }) {
  return count ? (
    <span className="inline-block size-2 rounded-full bg-warm" role="img" aria-label="有新内容" />
  ) : null;
}

export type SeenTarget = { type: SpaceRecordType; id: string; mark: number };

/**
 * Reports records once each has stayed on a visible page for `SEEN_DWELL_MS`, at the mark it
 * was loaded with, then refreshes `queryKey` and the entry dots. A failed report is dropped;
 * the record stays unread and is reported again when next seen.
 */
export function useSeenReporter(queryKey: readonly unknown[]) {
  const client = useQueryClient();
  const sent = useRef(new Set<string>());
  return useCallback(
    (target: SeenTarget) => {
      const key = `${target.type}:${target.id}:${target.mark}`;
      if (sent.current.has(key)) return;
      sent.current.add(key);
      callApi('reportSeen', { body: { records: [target] } }).then(
        () => {
          void client.invalidateQueries({ queryKey });
          void client.invalidateQueries({ queryKey: spaceUnreadKey });
        },
        () => sent.current.delete(key),
      );
    },
    [client, queryKey],
  );
}

/**
 * A ref for one record's element: while `target` is set (the record holds something
 * unread), it is reported once it has been at least half visible on a visible page for
 * about a second without a break.
 */
export function useSeen(target: SeenTarget | null, report: (target: SeenTarget) => void) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const type = target?.type;
  const id = target?.id;
  const mark = target?.mark;
  useEffect(() => {
    if (!element || !type || !id || mark === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inView = false;
    const arm = () => {
      clearTimeout(timer);
      if (inView && document.visibilityState === 'visible')
        timer = setTimeout(() => report({ type, id, mark }), SEEN_DWELL_MS);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = !!entry?.isIntersecting;
        arm();
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    document.addEventListener('visibilitychange', arm);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', arm);
    };
  }, [element, type, id, mark, report]);
  return setElement;
}

/** How long a jumped-to record stays highlighted; the style fades it out meanwhile. */
const FLASH_MS = 2_000;

/**
 * "有 N 处新内容 · 跳到第一处", then "下一处" (D8, as in the diary). `ids` are the elements
 * of unread records in page order; the count is the one the page opened with. `show(id)`
 * reveals a record the page keeps out of sight (another tab) before it is scrolled to.
 */
export function UnreadJump({ ids, show }: { ids: readonly string[]; show?: (id: string) => void }) {
  const [atOpen] = useState(ids.length);
  const [next, setNext] = useState(0);
  if (!ids.length) return null;
  const jump = (index: number) => {
    const id = ids[index % ids.length]!;
    if (show) flushSync(() => show(id));
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.add('unread-flash');
    setTimeout(() => target.classList.remove('unread-flash'), FLASH_MS);
    setNext(index + 1);
  };
  return (
    <p className="my-2 flex min-h-11 items-center gap-1 text-sm">
      {next === 0 ? (
        <>
          有 {atOpen} 处新内容 ·{' '}
          <Button
            type="button"
            variant="link"
            className="text-warm underline"
            onClick={() => jump(0)}
          >
            跳到第一处
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="link"
          className="text-warm underline"
          onClick={() => jump(next)}
        >
          下一处
        </Button>
      )}
    </p>
  );
}

export function ReadOnlyNotice() {
  return (
    <p className="my-4 rounded-xl bg-notice px-4 py-3 text-sm" role="status">
      已解绑，记录只读
    </p>
  );
}

/** "10 月 31 日" in the viewer's own zone. */
export const dayText = (iso: string) => {
  const date = new Date(iso);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
};

/** Who did something and when (D4): "A 改了 · 10 月 31 日"; marked when it is new to the viewer. */
export function StampText({
  name,
  verb,
  at,
  fresh,
}: {
  name: string;
  verb: string;
  at: string;
  fresh?: boolean;
}) {
  return (
    <span className={cn('mr-3 text-sm', fresh ? 'text-warm' : 'text-ink-soft')}>
      {name} {verb} · {dayText(at)}
    </span>
  );
}

/** The label of a record new to the viewer: "新" or "改过" (D8). */
export function UnreadLabel({ unread }: { unread: 'new' | 'edited' | 'acted' | null }) {
  const text = unread === 'new' ? '新' : unread === 'edited' ? '改过' : null;
  return text ? (
    <span className="ml-1 rounded-md bg-notice px-1.5 py-0.5 align-middle font-sans text-xs font-normal">
      {text}
    </span>
  ) : null;
}

/** What a refused or failed write tells the person (space-records 失败与恢复). */
export function refusalText(error: unknown): string {
  if (!(error instanceof ApiError)) return '离线时无法保存，请联网后再试';
  switch (error.code) {
    case 'SPACE_READ_ONLY':
      return '已解绑，记录只读';
    case 'RECORD_STALE':
      return '这条已经改过了，刷新后再改';
    case 'NOT_FOUND':
      return '这条已经不在了';
    case 'RECORD_EXISTS':
      return '已经有一个了，打开那一个修改';
    default:
      return '没有保存成功，请稍后再试';
  }
}

/**
 * A request ID kept until the request succeeds, so sending again after a lost answer is
 * the same request and is stored once (D4).
 */
export function useRequestId(): [string, () => void] {
  const [id, setId] = useState(() => crypto.randomUUID());
  return [id, useCallback(() => setId(crypto.randomUUID()), [])];
}

/**
 * Said when deleting something that is already in both people's Drive: deleting in the app
 * takes nothing out of the partner's Doc or its version history (google-copy-beyond-diaries
 * D8). Not for a gift in preparation, which only ever reached the giver's own Drive.
 */
export const COPY_STAYS_NOTE = '已经备份到对方 Google Drive 的内容不会因此删除。';
