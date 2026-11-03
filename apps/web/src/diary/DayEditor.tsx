import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Day, ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import { Avatar } from '../avatar/index.ts';
import { Button, cn } from '../ui/index.ts';
import { DiaryBlock, copyOf, type BlockReport } from './DiaryBlock.tsx';
import { AuthorLegend, usePeople } from './people.tsx';
import { UnreadNotices } from './UnreadNotices.tsx';
import type { DiarySession, ReadingPosition, Unread } from './session.ts';

type Side = 'mine' | 'theirs';
type View = 'both' | Side;

/** This device's choice to show the diaries in the other order; nowhere else (D6). */
const ORDER_KEY = 'between-pages:day-order';

function storedSwap(): boolean {
  try {
    return localStorage.getItem(ORDER_KEY) === 'swapped';
  } catch {
    // Storage unavailable: the default order (D6 失败与恢复).
    return false;
  }
}

function storeSwap(swapped: boolean) {
  try {
    if (swapped) localStorage.setItem(ORDER_KEY, 'swapped');
    else localStorage.removeItem(ORDER_KEY);
  } catch {
    // Not remembered; this page still shows the order chosen.
  }
}

/** The device's IANA zone decides which date "today" is (spec §4); the server checks it. */
export const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Today's date in the device's zone, as the server would decide it. */
export const todayHere = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone() }).format(new Date());

// A diary date is a calendar day, not an instant: shown as written, in no time zone.
const dateText = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
  timeZone: 'UTC',
});
const dayLabel = (date: string) => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return dateText.format(new Date(Date.UTC(year, month - 1, day)));
};

/** The unread of the diaries shown, as one: passages add up, directions combine. */
function combined(reports: (BlockReport | undefined)[]): Unread | undefined {
  const known = reports.flatMap((r) =>
    r && !r.previewing && r.state.unread ? [r.state.unread] : [],
  );
  if (!known.length) return undefined;
  return {
    atOpen: known.reduce((n, u) => n + u.atOpen, 0),
    left: known.reduce((n, u) => n + u.left, 0),
    above: known.some((u) => u.above),
    below: known.some((u) => u.below),
  };
}

/**
 * One date's day editor, the diary page's "这一天" view (digital-paper-interface D2); a new
 * date is a new editor. `focus` asks ("编辑" in the
 * feed, "写今天") for the caller's diary to take the focus once open, or "写这天" without
 * one; a new value asks again.
 */
export function DayEditor({ date, focus = null }: { date: string; focus?: string | null }) {
  return <DayView key={date} date={date} focus={focus} />;
}

/**
 * Both diaries of one date, stacked (unread-and-day-page D6): each a diary session of its
 * own with its own save state, drafts, undo, carets, history and unread, so an edit, an
 * undo or a paste never reaches the other (invariant 9). The order follows the space's
 * slots unless this device swapped it. "双人 | 我的 | TA 的" shows one or both while both
 * have text; a hidden diary stays mounted and is not read. One "只看我的文字" switch covers
 * both, and the reading position holds across remote commits, the filter and the view.
 * Without the caller's diary, "写这天" starts it in place, unless the date has not begun
 * here yet. The page never changes its layout by itself (invariant 13).
 */
function DayView({ date, focus }: { date: string; focus: string | null }) {
  const titleId = useId();
  const user = useMe().data?.user;
  const { people, known } = usePeople();
  const [day, setDay] = useState<Day | null>(null);
  const [google, setGoogle] = useState<ResponseOf<'day'>['google'] | null>(null);
  const [failed, setFailed] = useState<'offline' | 'failed' | null>(null);
  const [mineId, setMineId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [notYet, setNotYet] = useState(() => date > todayHere());
  const [swapped, setSwapped] = useState(storedSwap);
  const [view, setView] = useState<View>('both');
  const [ownOnly, setOwnOnly] = useState(false);
  const [jumped, setJumped] = useState(false);
  const [reports, setReports] = useState<Partial<Record<Side, BlockReport>>>({});
  const sessions = useRef<Record<Side, DiarySession | null>>({ mine: null, theirs: null });
  const blocks = useRef<Record<Side, HTMLElement | null>>({ mine: null, theirs: null });
  const writeButton = useRef<HTMLButtonElement>(null);
  const focusedFor = useRef<string | null>(null);

  const load = useCallback(
    () =>
      callApi('day', { params: { date } }).then(
        ({ day: loaded, google: copy }) => {
          setDay(loaded);
          setGoogle(copy);
          setFailed(null);
          if (loaded.mine) setMineId(loaded.mine.diaryId);
        },
        (error: unknown) => setFailed(error instanceof ApiError ? 'failed' : 'offline'),
      ),
    [date],
  );
  useEffect(() => void load(), [load]);

  const me = user && people.get(user.id);
  const partnerId = user && [...people.keys()].find((id) => id !== user.id);
  const partner = partnerId ? people.get(partnerId) : undefined;
  const theirs = day?.partner ?? null;
  const sides: Side[] = theirs ? ['mine', 'theirs'] : ['mine'];
  const slotOf = (side: Side) => (side === 'mine' ? me?.slot : partner?.slot) ?? 1;
  const order = [...sides].sort((a, b) => slotOf(a) - slotOf(b));
  if (swapped) order.reverse();
  const shown = view === 'both' ? order : order.filter((side) => side === view);

  // Read through refs by the sessions' callbacks, which outlive a render.
  const shownRef = useRef(shown);
  const ownOnlyRef = useRef(ownOnly);
  useEffect(() => {
    shownRef.current = shown;
    ownOnlyRef.current = ownOnly;
  });

  /**
   * The reading position of the page (D5): a focused caret in the window wins, else the
   * character at the window's top, in the first of `among` that has one.
   */
  const hold = (among: Side[], ownOnlyNext?: boolean) => {
    const held = among.flatMap((side) => {
      const position = sessions.current[side]?.hold(ownOnlyNext);
      return position ? [{ side, position }] : [];
    });
    return held.find((h) => h.position.caret) ?? held[0] ?? null;
  };
  const restore = (held: { side: Side; position: ReadingPosition } | null) => {
    if (held) sessions.current[held.side]?.restore(held.position);
  };
  const keepPosition = (apply: () => void) => {
    const held = hold(shownRef.current, ownOnlyRef.current);
    apply();
    restore(held);
  };

  const switchOwnOnly = (on: boolean) => {
    const held = hold(shown, on);
    for (const side of sides) sessions.current[side]?.setOwnTextOnly(on, false);
    restore(held);
    setOwnOnly(on);
  };
  const switchView = (next: View) => {
    const held = hold(next === 'both' ? order : [next], ownOnly);
    flushSync(() => setView(next));
    restore(held);
  };
  const swap = () => {
    storeSwap(!swapped);
    setSwapped(!swapped);
  };

  /** "跳到第一处" and "下一处未读" across the diaries shown, in display order (D4). */
  const jump = (which: 'first' | 'next') => {
    const shownSessions = shown.flatMap((side) => sessions.current[side] ?? []);
    if (which === 'next' && shownSessions.some((s) => s.jumpToUnread('next', false))) return;
    shownSessions.some((s) => s.jumpToUnread('first'));
  };

  const write = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const { diary } = await callApi('openDiary', { body: { timezone: timezone(), date } });
      setMineId(diary.diaryId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') setNotYet(true);
      else
        setCreateError(
          error instanceof ApiError ? '创建失败，请稍后再试' : '离线时无法创建，请联网后再试',
        );
    } finally {
      setCreating(false);
    }
  };

  const onSession = (side: Side) => (session: DiarySession | null) => {
    sessions.current[side] = session;
    if (session && ownOnlyRef.current) session.setOwnTextOnly(true, false);
  };
  const onReport = (side: Side) => (report: BlockReport) =>
    setReports((all) => ({ ...all, [side]: report }));

  const bothWrote = !!theirs && !!reports.mine?.hasText && !!reports.theirs?.hasText;
  const sharedNow = reports.mine?.state.shared ?? day?.mine?.sharedWithPartner ?? false;
  const unread = combined(shown.map((side) => reports[side]));
  const ready = !!user && known && !!day;

  // "编辑" hands the focus to this page's own diary, once, when it can take it (D3).
  const ownPhase = reports.mine?.state.phase;
  useEffect(() => {
    if (!focus || focusedFor.current === focus || !ready) return;
    const target = mineId
      ? ownPhase === 'open' &&
        blocks.current.mine?.querySelector<HTMLElement>('[contenteditable="true"]')
      : writeButton.current;
    if (!target) return;
    target.focus();
    focusedFor.current = focus;
  }, [focus, ready, mineId, ownPhase]);

  const titleOf = (side: Side): ReactNode => {
    const person = side === 'mine' ? me : partner;
    const name = side === 'mine' ? (user?.displayName ?? '我') : (partner?.name ?? 'TA');
    return (
      <h2 className="mr-auto inline-flex items-center gap-2 text-base font-semibold">
        <Avatar person={{ name, slot: person?.slot ?? null }} />
        <span>{side === 'mine' ? `${name}（我）` : name}</span>
        {side === 'mine' && mineId && !sharedNow && <span className="share-state">仅自己可见</span>}
      </h2>
    );
  };

  // The diaries keep the single-diary page's look (`legacy`) until it is redrawn.
  return (
    <article className="legacy diary day" aria-labelledby={titleId}>
      <h1 id={titleId} className="m-0 font-serif text-3xl font-normal text-ink">
        {dayLabel(date)}
      </h1>
      {failed && (
        <div className="notice" role="alert">
          <p>{failed === 'offline' ? '离线时无法读取这一天' : '这一天暂时无法读取'}</p>
          <button
            type="button"
            onClick={() => {
              setFailed(null);
              void load();
            }}
          >
            重试
          </button>
        </div>
      )}
      {ready && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {bothWrote && (
              <div className="inline-flex rounded-xl bg-accent p-1" role="group" aria-label="视图">
                {(
                  [
                    ['both', '双人'],
                    ['mine', '我的'],
                    ['theirs', 'TA 的'],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-8 rounded-lg text-ink-soft hover:bg-paper/60',
                      view === value && 'bg-paper text-ink shadow-sm',
                    )}
                    aria-pressed={view === value}
                    onClick={() => switchView(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
            {view === 'both' && theirs && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => blocks.current.theirs?.scrollIntoView({ block: 'start' })}
                >
                  跳到 TA 的
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => blocks.current.mine?.scrollIntoView({ block: 'start' })}
                >
                  跳到我的
                </Button>
              </>
            )}
            {theirs && (
              <Button variant="outline" size="sm" onClick={swap}>
                交换顺序
              </Button>
            )}
          </div>
          <AuthorLegend people={people} ownOnly={ownOnly} onOwnOnly={switchOwnOnly} />
          <UnreadNotices
            unread={unread}
            jumped={jumped}
            onJump={(which) => {
              if (which === 'first') setJumped(true);
              jump(which);
            }}
          />
          {order.map((side) => (
            <section
              key={side}
              ref={(element) => {
                blocks.current[side] = element;
              }}
              className="mt-6 border-t border-line pt-4"
              aria-label={side === 'mine' ? '我的日记' : 'TA 的日记'}
              hidden={!shown.includes(side)}
            >
              {side === 'theirs' && theirs ? (
                <DiaryBlock
                  // A share reopened while shown comes back as a new epoch: a new session.
                  key={`${theirs.diaryId}:${theirs.epochId}`}
                  userId={user.id}
                  diaryId={theirs.diaryId}
                  epochId={theirs.epochId}
                  onReopen={() => void load()}
                  people={people}
                  title={titleOf('theirs')}
                  googleCopy={google ? copyOf(google, 'partner') : undefined}
                  keepPosition={keepPosition}
                  onSession={onSession('theirs')}
                  onReport={onReport('theirs')}
                />
              ) : mineId ? (
                <DiaryBlock
                  userId={user.id}
                  diaryId={mineId}
                  people={people}
                  title={titleOf('mine')}
                  googleCopy={google ? copyOf(google, 'mine') : undefined}
                  keepPosition={keepPosition}
                  onSession={onSession('mine')}
                  onReport={onReport('mine')}
                />
              ) : (
                <>
                  {titleOf('mine')}
                  {notYet ? (
                    <p className="list-note">你这边还没到这一天</p>
                  ) : (
                    <button
                      ref={writeButton}
                      type="button"
                      disabled={creating}
                      onClick={() => void write()}
                    >
                      写这天
                    </button>
                  )}
                  {createError && (
                    <p className="notice" role="alert">
                      {createError}
                    </p>
                  )}
                </>
              )}
            </section>
          ))}
        </>
      )}
      {!ready && !failed && <p className="status">正在打开…</p>}
    </article>
  );
}
