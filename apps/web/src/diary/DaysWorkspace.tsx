import { useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { CalendarDays, ChevronDown, PenLine } from 'lucide-react';
import { ApiError, callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import { DateIndex, DayFeed, type FeedPerson, type FeedPosition } from '../day-feed/index.ts';
import { Button, cn, Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/index.ts';
import { DayEditor, timezone, todayHere } from './DayEditor.tsx';
import { usePeople } from './DiaryPage.tsx';
import { ScrollBox } from './scroll-box.ts';
import './workspace.css';

/** Below this width the date index folds into a date picker over the main area. */
const NARROW = '(max-width: 56rem)';

function onWidthChange(changed: () => void) {
  const query = globalThis.matchMedia?.(NARROW);
  query?.addEventListener('change', changed);
  return () => query?.removeEventListener('change', changed);
}
// Without matchMedia (jsdom) the window counts as wide.
const isNarrow = () => globalThis.matchMedia?.(NARROW).matches ?? false;
const useNarrow = () => useSyncExternalStore(onWidthChange, isNarrow);

/**
 * What a diary page entry keeps in the browser's history, never in the address
 * (book-frontend-workspace D3): where the feed was read, whether the day's own diary should
 * take the focus, and whether the entry before this one is the feed (`back`).
 */
export type WorkspaceState = { feed?: FeedPosition; edit?: boolean; back?: boolean };

export function workspaceState(state: unknown): WorkspaceState {
  if (typeof state !== 'object' || state === null) return {};
  const { feed, edit, back } = state as Record<string, unknown>;
  const position =
    typeof feed === 'object' && feed !== null && typeof (feed as FeedPosition).date === 'string'
      ? (feed as FeedPosition)
      : undefined;
  return {
    ...(position ? { feed: position } : {}),
    ...(edit === true ? { edit } : {}),
    ...(back === true ? { back } : {}),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const switchItem =
  'inline-flex h-8 items-center rounded-lg px-3 text-sm text-ink-soft no-underline transition-colors hover:text-ink aria-[current=page]:bg-paper aria-[current=page]:text-ink aria-[current=page]:shadow-sm';

/**
 * `/days` and `/days/:date`, the diary page (digital-paper-interface D2): the date index
 * beside one main area, which is the feed of all diaries ("连续读", `/days`) or the day
 * editor of the date in the address ("这一天"). Opening a date pushes a history entry; the
 * feed's position lives in each entry's state, so going back to the feed shows it where it
 * was. Narrow, the index folds into a date picker above the main area, which fills the
 * width; the feed and the day are one page each (book-frontend-workspace D6).
 */
export function DaysWorkspace() {
  const { date } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const user = useMe().data?.user;
  const { people } = usePeople();
  const dayBox = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  if (date !== undefined && !DATE.test(date)) return <Navigate to="/days" replace />;
  if (!user) return null;

  const state = workspaceState(location.state);
  // "编辑" asks once per history entry; a new entry asks again.
  const focus = state.edit ? location.key : null;
  const here = { pathname: location.pathname, search: location.search, hash: location.hash };

  const me: FeedPerson = {
    id: user.id,
    name: user.displayName,
    slot: people.get(user.id)?.slot ?? null,
  };
  const partnerId = [...people.keys()].find((id) => id !== user.id);
  const partnerOf = partnerId && people.get(partnerId);
  const partner: FeedPerson =
    partnerOf && partnerId
      ? { id: partnerId, name: partnerOf.name, slot: partnerOf.slot }
      : { id: '', name: 'TA', slot: null };

  /** Opens a date's day; from the feed, the feed's entry is the one to go back to. */
  const openDay = (to: string, edit = false) =>
    void navigate(`/days/${to}`, {
      state: { feed: state.feed, edit, ...(date ? {} : { back: true }) },
    });
  const choose = (to: string) => {
    setPicking(false);
    if (to !== date) openDay(to);
  };
  const backToFeed = (event: MouseEvent) => {
    // Came here from the feed: its entry is the one before, with its position.
    if (!state.back || location.key === 'default') return;
    event.preventDefault();
    void navigate(-1);
  };
  // "这一天" from the feed opens the date it was read at, else today.
  const dayToOpen = date ?? state.feed?.date ?? todayHere();

  const views = (
    <nav aria-label="日记视图" className="inline-flex shrink-0 rounded-xl bg-accent p-1">
      <Link
        to="/days"
        state={date ? { feed: state.feed ?? { date, offset: 0 } } : location.state}
        aria-current={date ? undefined : 'page'}
        className={switchItem}
        onClick={date ? backToFeed : (event) => event.preventDefault()}
      >
        连续读
      </Link>
      <Link
        to={`/days/${dayToOpen}`}
        aria-current={date ? 'page' : undefined}
        className={switchItem}
        onClick={(event) => {
          event.preventDefault();
          if (!date) openDay(dayToOpen);
        }}
      >
        这一天
      </Link>
    </nav>
  );
  const index = <DateIndex me={me} partner={partner} chosenDate={date ?? null} onChoose={choose} />;
  const writeToday = <WriteToday onOpened={(diaryDate) => openDay(diaryDate, true)} />;

  const feed = (
    <DayFeed
      me={me}
      partner={partner}
      position={state.feed ?? null}
      onPosition={(at) =>
        void navigate(here, {
          replace: true,
          state: { ...(location.state as object | null), feed: at, edit: false },
        })
      }
      onOpen={(to, edit, at) => {
        // The entry being left remembers the list as it is, for back.
        if (at) void navigate(here, { replace: true, state: { feed: at } });
        void navigate(`/days/${to}`, { state: { feed: at ?? state.feed, edit, back: true } });
      }}
    />
  );
  const feedView = (
    <>
      <h1 className="mx-auto w-full max-w-(--measure) font-serif text-2xl font-normal text-ink px-(--measure-pad)">
        所有日记
      </h1>
      {feed}
    </>
  );

  if (narrow)
    return (
      <main
        className={cn(
          'flex flex-col wrap-anywhere',
          // The feed scrolls inside itself, so it takes the rest of the window's height; the
          // day scrolls with the window.
          !date && 'h-[calc(100dvh-var(--site-header))]',
        )}
      >
        <Collapsible
          open={picking}
          onOpenChange={setPicking}
          className="flex min-h-0 shrink-0 flex-col border-b border-line px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            {views}
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm">
                <CalendarDays aria-hidden="true" />
                日期
                <ChevronDown
                  aria-hidden="true"
                  className={cn('transition-transform', picking && 'rotate-180')}
                />
              </Button>
            </CollapsibleTrigger>
            <div className="ml-auto">{writeToday}</div>
          </div>
          <CollapsibleContent className="mt-2 flex max-h-[55dvh] min-h-0 flex-col rounded-xl border border-line">
            {index}
          </CollapsibleContent>
        </Collapsible>
        {date ? (
          <div className="px-4 py-5">
            <DayEditor date={date} focus={focus} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-4">{feedView}</div>
        )}
      </main>
    );

  return (
    // Long words and links wrap inside their region, never across the index or the window.
    // The feed and the day share one reading width (`--measure`, `--measure-pad` inside it);
    // their boxes span the main area, so the scrollbar sits at its edge, away from the text.
    <main className="grid h-[calc(100dvh-var(--site-header))] grid-cols-[17rem_minmax(0,1fr)] wrap-anywhere [--measure-pad:2rem] [--measure:68rem]">
      <aside className="flex min-h-0 flex-col border-r border-line bg-accent/30">
        <div className="px-6 pt-6 pb-3">
          <p className="font-serif text-lg text-ink">我们的日记</p>
        </div>
        <div className="px-4 pb-3">{writeToday}</div>
        {index}
      </aside>
      {date ? (
        // The day scrolls inside the main area, the index staying beside it; its unread tools
        // float over this box, not the window (workspace.css).
        <div className="day-box relative min-h-0">
          <div
            ref={dayBox}
            className="day-scroll scroll-quiet h-full overflow-y-auto [overflow-anchor:none]"
          >
            <ScrollBox value={dayBox}>
              <div className="mx-auto max-w-(--measure) px-(--measure-pad) py-6">
                <div className="mb-6">{views}</div>
                <DayEditor date={date} focus={focus} />
              </div>
            </ScrollBox>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 w-full flex-col gap-3 pt-6">
          <div className="mx-auto mb-3 w-full max-w-(--measure) px-(--measure-pad)">{views}</div>
          {feedView}
        </div>
      )}
    </main>
  );
}

/**
 * "写今天": opens or creates today's diary in the device's IANA zone, the server deciding
 * the date (spec §4). Offline nothing is created and nothing claims to be (DATE-06).
 */
function WriteToday({ onOpened }: { onOpened: (diaryDate: string) => void }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setError(null);
    setOpening(true);
    try {
      const { diary } = await callApi('openDiary', { body: { timezone: timezone() } });
      onOpened(diary.diaryDate);
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? '打开失败，请稍后再试'
          : '离线时无法确认要打开的日记，请联网后再试',
      );
    } finally {
      setOpening(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        className="w-full"
        size="sm"
        disabled={opening}
        onClick={() => void open()}
      >
        <PenLine aria-hidden="true" />
        写今天
      </Button>
      {error && (
        <p className="mt-2 rounded-lg bg-notice px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
