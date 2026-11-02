import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { Avatar, type AvatarPerson } from '../avatar/index.ts';
import type { Clip } from '../day-text/index.ts';
import { captureAnchor, restoreAnchor, type Anchor } from './anchor.ts';
import { FeedDiary } from './FeedDiary.tsx';
import { collapseOf, diariesOf, type Collapse, type Entry, type Side } from './model.ts';
import { UnreadArrow, useUnreadArrows } from './UnreadArrows.tsx';
import { useDayFeed, type Failure, type Loading } from './useDayFeed.ts';
import './day-feed.css';

/** A person of the feed: who they are, for whose text is whose, and their avatar. */
export type FeedPerson = AvatarPerson & { id: string };

/**
 * Where the list is read (D3): a date, and inside it a character by identity, at a
 * distance from the top of the list's box. `{ date, offset: 0 }` puts a date at the top.
 * Plain data, so it can live in the browser's history state.
 */
export type FeedPosition = Anchor;

/** How long the list rests after scrolling before it reports where it is. */
export const POSITION_MS = 400;

/** Opens a date in the left page (or the narrow day page); `edit` gives it the focus. */
type Open = (date: string, edit: boolean) => void;

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

function dateLabel(diaryDate: string) {
  const [year, month, day] = diaryDate.split('-').map(Number) as [number, number, number];
  const format = year === new Date().getFullYear() ? dateText : datedYearText;
  return format.format(new Date(Date.UTC(year, month - 1, day)));
}

const failureText: Record<Failure['kind'], string> = {
  offline: '离线时无法读取日记，联网后再试',
  failed: '日记读取失败，请稍后再试',
};

const collapseText: Record<Exclude<Collapse, null>, string> = {
  editing: '正在左页编辑',
  'writing-self': '你在别处正在写',
  'writing-partner': 'TA 正在写',
};

/**
 * One date of the feed: its label, an avatar per diary in slot order (hollow while blank),
 * the unread dot and each diary's text or collapsed row (D8). The dot follows the list until
 * a diary's text and coverage are loaded, then the text (unread-and-day-page D2, the
 * in-diary rule); while the list cannot be read, the list's marks are not trusted.
 */
function DateSection({
  entry,
  me,
  partner,
  editingDate,
  near,
  listTrusted,
  authorClass,
  clip,
  chosen,
  onOpen,
}: {
  entry: Entry;
  me: FeedPerson;
  partner: FeedPerson;
  editingDate: string | null;
  near: boolean;
  listTrusted: boolean;
  authorClass: (author: string) => string;
  clip: () => Clip;
  chosen: boolean;
  onOpen: Open | undefined;
}) {
  const [textUnread, setTextUnread] = useState<Partial<Record<Side, boolean>>>({});
  const onUnread = useCallback(
    (side: Side, unread: boolean | undefined) =>
      setTextUnread((known) => (known[side] === unread ? known : { ...known, [side]: unread })),
    [],
  );
  const label = dateLabel(entry.date);
  const to = `/days/${entry.date}`;
  const opening = (edit: boolean) =>
    onOpen &&
    ((event: MouseEvent) => {
      event.preventDefault();
      onOpen(entry.date, edit);
    });
  // The chosen date says so in words, not only by its mark (D1, D3).
  const head = (rest?: ReactNode) => (
    <header className="feed-date-head">
      <h3>
        <Link to={to} aria-current={chosen ? 'true' : undefined} onClick={opening(false)}>
          {label}
        </Link>
      </h3>
      {chosen && <span className="feed-chosen">在左页</span>}
      {rest}
      <Link className="feed-edit" to={to} state={{ edit: true }} onClick={opening(true)}>
        编辑
      </Link>
    </header>
  );
  const sectionProps = {
    className: chosen ? 'feed-date chosen' : 'feed-date',
    'data-date': entry.date,
    'aria-label': label,
  };
  if (!entry.day)
    return (
      <section {...sectionProps}>
        {head()}
        <p className="list-note">这一天没有可以读的日记</p>
      </section>
    );

  const diaries = diariesOf(entry.day)
    .map((diary) => ({ diary, person: diary.side === 'mine' ? me : partner }))
    .sort((a, b) => (a.person.slot ?? 1) - (b.person.slot ?? 1));
  const unread = diaries.some(
    ({ diary }) => textUnread[diary.side] ?? (listTrusted && diary.unread),
  );
  return (
    <section {...sectionProps}>
      {head(
        <>
          <span className="feed-avatars">
            {diaries.map(({ diary, person }) => (
              <Avatar key={diary.side} person={person} hollow={!diary.hasText} />
            ))}
          </span>
          {unread && <span className="unread-dot" role="img" aria-label="有新内容" />}
        </>,
      )}
      {diaries.map(({ diary, person }) => {
        const collapse = collapseOf(entry.date, diary, editingDate);
        if (collapse)
          return (
            <p
              key={diary.side}
              className="feed-collapsed"
              data-unread={listTrusted && diary.unread ? 'collapsed' : undefined}
            >
              {diaries.length > 1 && <span className="feed-diary-who">{person.name}</span>}
              <span>{collapseText[collapse]}</span>
              {collapse !== 'editing' && (
                <Link to={to} onClick={opening(false)}>
                  在左页打开
                </Link>
              )}
            </p>
          );
        return (
          <FeedDiary
            key={`${diary.diaryId}:${diary.epochId ?? ''}`}
            diary={diary}
            name={diaries.length > 1 ? person.name : null}
            readerId={me.id}
            near={near}
            listUnread={listTrusted && diary.unread}
            authorClass={authorClass}
            clip={clip}
            onUnread={onUnread}
          />
        );
      })}
    </section>
  );
}

/**
 * Loads a page more at one end. It stays mounted and enabled while any page loads, saying
 * so, because a disabled or replaced button drops a keyboard user's focus to the document;
 * `onLoad` itself refuses while a read is in flight.
 */
function EdgeButton({
  busy,
  end,
  onLoad,
  children,
}: {
  busy: Loading | null;
  end: 'newer' | 'older';
  onLoad: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-disabled={!!busy} onClick={onLoad}>
      {busy === end ? '正在读取…' : children}
    </button>
  );
}

/**
 * The right page (book-frontend-workspace D3, D4, D5, D8): both people's diaries by date,
 * newest first, each in full and read-only, scrolled inside its own box. Dates load a page
 * at a time as either end comes near, a date input jumps to any day, and text is read only
 * for dates near the viewport. `editingDate` names the date whose own diary the left page
 * has open; that diary shows only "正在左页编辑". `chosenDate`, the left page's date, is
 * marked "在左页". The line being read keeps its place when text above it changes height.
 * Round ↑ / ↓ buttons over the box go to the nearest unread newer / older, loaded or not.
 *
 * `position` says where to show: a reported position, a date at the top, or the newest
 * (null). The list goes there on mount and when it changes to anything but what the list
 * itself last reported through `onPosition` (after scrolling) or `onOpen` (choosing a
 * date or "编辑"), so the caller can keep it in the browser's history and bring it back.
 * Without `onOpen` a date's links simply navigate.
 */
export function DayFeed({
  me,
  partner,
  editingDate = null,
  chosenDate = null,
  position = null,
  onPosition,
  onOpen,
}: {
  me: FeedPerson;
  partner: FeedPerson;
  editingDate?: string | null;
  chosenDate?: string | null;
  position?: FeedPosition | null;
  onPosition?: (at: FeedPosition) => void;
  onOpen?: (date: string, edit: boolean, at: FeedPosition | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Without IntersectionObserver every date counts as near and nothing loads by itself.
  const [near, setNear] = useState<ReadonlySet<string> | null>(() =>
    typeof IntersectionObserver === 'undefined' ? null : new Set(),
  );
  const [edges, setEdges] = useState({ newer: false, older: false });
  const [jumpDate, setJumpDate] = useState('');
  const known = useRef<{ near: ReadonlySet<string> | null; dates: string[] }>({
    near: null,
    dates: [],
  });
  const feed = useDayFeed(
    useCallback(() => {
      const { near: nearSet, dates } = known.current;
      return nearSet ? dates.filter((date) => nearSet.has(date)) : dates;
    }, []),
  );
  const { feedWindow, loading, failure, target, older, newer } = feed;
  const entries = feedWindow?.entries;
  useEffect(() => {
    known.current = { near, dates: entries?.map((e) => e.date) ?? [] };
  });

  const clip = useCallback((): Clip => {
    const rect = scroller.current?.getBoundingClientRect();
    if (!rect) return { top: 0, bottom: 0 };
    return { top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, globalThis.innerHeight) };
  }, []);

  const authorClass = useCallback(
    (author: string) => {
      const slot = author === me.id ? me.slot : partner.slot;
      return slot ? `author-slot-${slot}` : '';
    },
    [me.id, me.slot, partner.slot],
  );

  // Dates within a screen of the viewport are near; so are the ends that load more.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (changes) => {
        setNear((previous) => {
          const next = new Set(previous);
          for (const { target: el, isIntersecting } of changes) {
            const date = (el as HTMLElement).dataset.date;
            if (date && isIntersecting) next.add(date);
            else if (date) next.delete(date);
          }
          return next;
        });
        for (const { target: el, isIntersecting } of changes) {
          const edge = (el as HTMLElement).dataset.edge as 'newer' | 'older' | undefined;
          if (edge)
            setEdges((e) => (e[edge] === isIntersecting ? e : { ...e, [edge]: isIntersecting }));
        }
      },
      { root, rootMargin: '100% 0px' },
    );
    for (const el of root.querySelectorAll('[data-date], [data-edge]')) observer.observe(el);
    return () => observer.disconnect();
  }, [entries]);

  useEffect(() => {
    if (edges.older && !failure) older();
  }, [edges.older, failure, loading, entries, older]);
  useEffect(() => {
    if (edges.newer && !failure) newer();
  }, [edges.newer, failure, loading, entries, newer]);

  // The reading position (D8): held across this feed's renders, and across height changes
  // inside a date, which re-render only that date. A position brought back whose character
  // is not shown yet stays pending until its text is, or the reader moves the list.
  const anchor = useRef<Anchor | null>(null);
  const pending = useRef<Anchor | null>(null);
  const hold = useCallback(() => {
    const root = scroller.current;
    if (!root) return;
    if (pending.current && restoreAnchor(root, pending.current)) pending.current = null;
    else if (anchor.current) restoreAnchor(root, anchor.current);
    anchor.current = captureAnchor(root);
  }, []);
  const place = useCallback((root: HTMLElement, at: Anchor) => {
    pending.current = null;
    if (!restoreAnchor(root, at)) {
      restoreAnchor(root, { date: at.date, offset: at.offset });
      pending.current = at;
    }
    anchor.current = captureAnchor(root);
  }, []);
  useLayoutEffect(hold);
  /** Puts `el` a third down the box, as the diary's own unread jump does. */
  const show = useCallback(
    (el: HTMLElement) => {
      const root = scroller.current;
      if (!root) return;
      const seen = clip();
      root.scrollTop += el.getBoundingClientRect().top - seen.top - (seen.bottom - seen.top) / 3;
      pending.current = null;
      anchor.current = captureAnchor(root);
    },
    [clip],
  );
  const unreadArrows = useUnreadArrows({
    scroller,
    clip,
    feedWindow,
    jump: feed.jump,
    show,
  });
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(hold);
    for (const el of root.querySelectorAll('[data-date]')) observer.observe(el);
    return () => observer.disconnect();
  }, [entries, hold]);

  // A jump shows the date at the top, or where the position brought back held it; the
  // dates loading above it then keep it there.
  useLayoutEffect(() => {
    const root = scroller.current;
    const section = target && root?.querySelector(`[data-date="${target.date}"]`);
    if (!root || !section) return;
    if (target.at) return place(root, target.at);
    root.scrollTop += section.getBoundingClientRect().top - root.getBoundingClientRect().top;
    anchor.current = captureAnchor(root);
  }, [target, place]);

  // Where the caller wants the list (D3): not where it already said it is. Undefined until
  // mounted: a (re)mount drops the reads in flight, so it goes there again.
  const { start, jump } = feed;
  const reported = useRef<string | null | undefined>(undefined);
  useEffect(
    () => () => {
      reported.current = undefined;
    },
    [],
  );
  const positionKey = position && JSON.stringify(position);
  useEffect(() => {
    if (positionKey === reported.current) return;
    reported.current = positionKey;
    const at = positionKey === null ? null : (JSON.parse(positionKey) as Anchor);
    const root = scroller.current;
    if (!at) start();
    else if (root?.querySelector(`[data-date="${at.date}"]`)) place(root, at);
    else jump(at.date, at);
  }, [positionKey, start, jump, place]);

  const callbacks = useRef({ onPosition, onOpen });
  useEffect(() => {
    callbacks.current = { onPosition, onOpen };
  });
  const reportTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reportTimer.current), []);
  const reportLater = () => {
    clearTimeout(reportTimer.current);
    reportTimer.current = setTimeout(() => {
      const at = anchor.current;
      if (!at || !callbacks.current.onPosition) return;
      reported.current = JSON.stringify(at);
      callbacks.current.onPosition(at);
    }, POSITION_MS);
  };
  const open = useCallback<Open>((date, edit) => {
    const root = scroller.current;
    const at = root && captureAnchor(root);
    clearTimeout(reportTimer.current);
    if (at) reported.current = JSON.stringify(at);
    callbacks.current.onOpen?.(date, edit, at);
  }, []);
  const stopPending = () => {
    pending.current = null;
    unreadArrows.cancel();
  };

  const nearDate = (date: string) => !near || near.has(date);
  const busy = loading === 'start' || loading === 'jump';
  return (
    <section className="day-feed" aria-label="所有日记">
      <form
        className="feed-jump"
        onSubmit={(event) => {
          event.preventDefault();
          if (!jumpDate) return;
          unreadArrows.cancel();
          jump(jumpDate);
        }}
      >
        <label>
          跳到日期{' '}
          <input
            type="date"
            value={jumpDate}
            required
            onChange={(event) => setJumpDate(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          跳转
        </button>
      </form>
      <div className="feed-body">
        <div
          className="day-feed-scroll"
          ref={scroller}
          onScroll={() => {
            if (scroller.current) anchor.current = captureAnchor(scroller.current);
            reportLater();
          }}
          onWheel={stopPending}
          onTouchStart={stopPending}
          onKeyDown={stopPending}
          onPointerDown={stopPending}
        >
          {busy && <p className="list-note">正在读取…</p>}
          {feedWindow?.nextAfter && (
            <div className="feed-edge" data-edge="newer">
              <EdgeButton busy={loading} end="newer" onLoad={newer}>
                加载更新的日记
              </EdgeButton>
            </div>
          )}
          {entries?.map((entry) => (
            <DateSection
              key={entry.date}
              entry={entry}
              me={me}
              partner={partner}
              editingDate={editingDate}
              near={nearDate(entry.date)}
              listTrusted={!failure}
              authorClass={authorClass}
              clip={clip}
              chosen={entry.date === chosenDate}
              onOpen={onOpen && open}
            />
          ))}
          {entries?.length === 0 && <p className="list-note">还没有日记，从今天开始写吧</p>}
          {feedWindow?.nextBefore ? (
            <div className="feed-edge" data-edge="older">
              <EdgeButton busy={loading} end="older" onLoad={older}>
                加载更早的日记
              </EdgeButton>
            </div>
          ) : (
            !!entries?.length && <p className="feed-end">已经是最早的一天</p>
          )}
          {failure && (
            <div className="notice feed-failure">
              <p role="alert">{failureText[failure.kind]}</p>
              <button type="button" onClick={failure.retry}>
                重试
              </button>
            </div>
          )}
        </div>
        {(['newer', 'older'] as const).map(
          (direction) =>
            unreadArrows.shown[direction] && (
              <UnreadArrow key={direction} direction={direction} onGo={unreadArrows.go} />
            ),
        )}
      </div>
    </section>
  );
}
