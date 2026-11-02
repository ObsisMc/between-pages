import { useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError, callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import { BookSpread } from '../book/index.ts';
import { DayFeed, type FeedPosition } from '../day-feed/index.ts';
import { DayEditor, timezone } from './DayEditor.tsx';
import { usePeople } from './DiaryPage.tsx';
import { useNarrow } from './narrow.ts';
import { ScrollBox } from './scroll-box.ts';
import './workspace.css';

/**
 * What a workspace entry keeps in the browser's history, never in the address (D3): where
 * the list was read, and whether the left page's own diary should take the focus.
 */
export type WorkspaceState = { feed?: FeedPosition; edit?: boolean };

export function workspaceState(state: unknown): WorkspaceState {
  if (typeof state !== 'object' || state === null) return {};
  const { feed, edit } = state as Record<string, unknown>;
  const position =
    typeof feed === 'object' && feed !== null && typeof (feed as FeedPosition).date === 'string'
      ? (feed as FeedPosition)
      : undefined;
  return { ...(position ? { feed: position } : {}), ...(edit === true ? { edit } : {}) };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `/days` and `/days/:date`, the diary workspace (book-frontend-workspace D3, D6). Wide: a
 * spread whose left page edits the date in the address, or offers "从右页选一天" and
 * "写今天" without one, and whose right page is the feed of all diaries; each page scrolls
 * inside itself. Narrow: `/days` is the feed alone and `/days/:date` the day editor alone,
 * with "← 所有日记" back to where the feed was. Choosing a date pushes a history entry; the
 * feed's position lives in each entry's state, so a new left date keeps it, and back brings
 * the previous date and position again. The left page never waits for the feed.
 */
export function DaysWorkspace() {
  const { date } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const user = useMe().data?.user;
  const { people } = usePeople();
  const leftBox = useRef<HTMLDivElement>(null);
  if (date !== undefined && !DATE.test(date)) return <Navigate to="/days" replace />;
  if (!user) return null;

  const state = workspaceState(location.state);
  // "编辑" asks once per history entry; a new entry asks again.
  const focus = state.edit ? location.key : null;
  const here = { pathname: location.pathname, search: location.search, hash: location.hash };

  const partnerId = [...people.keys()].find((id) => id !== user.id);
  const partner = partnerId && people.get(partnerId);
  const feed = (
    <DayFeed
      me={{ id: user.id, name: user.displayName, slot: people.get(user.id)?.slot ?? null }}
      partner={
        partner && partnerId
          ? { id: partnerId, name: partner.name, slot: partner.slot }
          : { id: '', name: 'TA', slot: null }
      }
      editingDate={date ?? null}
      chosenDate={date ?? null}
      position={state.feed ?? (date ? { date, offset: 0 } : null)}
      onPosition={(at) =>
        void navigate(here, {
          replace: true,
          state: { ...(location.state as object | null), feed: at, edit: false },
        })
      }
      onOpen={(to, edit, at) => {
        // The entry being left remembers the list as it is, for back.
        if (at) void navigate(here, { replace: true, state: { feed: at } });
        if (to !== date || edit) void navigate(`/days/${to}`, { state: { feed: at, edit } });
      }}
    />
  );
  const writeToday = (diaryDate: string) =>
    void navigate(`/days/${diaryDate}`, { state: { feed: state.feed, edit: true } });

  if (narrow)
    return date ? (
      <Workspace className="narrow-day">
        <nav className="workspace-nav">
          <Link
            to="/days"
            state={{ feed: state.feed ?? { date, offset: 0 } }}
            onClick={(event) => {
              // Came here from the feed: its entry is the one before, with its position.
              if (!state.feed || location.key === 'default') return;
              event.preventDefault();
              void navigate(-1);
            }}
          >
            ← 所有日记
          </Link>
        </nav>
        <DayEditor date={date} focus={focus} />
      </Workspace>
    ) : (
      <Workspace className="narrow-feed">
        <nav className="workspace-nav">
          <Link to="/">← 序言</Link>
        </nav>
        <h1 className="workspace-title">所有日记</h1>
        <WriteToday onOpened={writeToday} />
        {feed}
      </Workspace>
    );

  return (
    <main className="days-workspace">
      <BookSpread
        className="workspace wide"
        left={
          <div className="workspace-left" ref={leftBox}>
            <ScrollBox value={leftBox}>
              <nav className="workspace-nav">
                <Link to="/">← 序言</Link>
              </nav>
              {date ? (
                <DayEditor date={date} focus={focus} />
              ) : (
                <section className="choose-day" aria-label="选择日期">
                  <h1 className="workspace-title">日记</h1>
                  <p>从右页选一天</p>
                  <WriteToday onOpened={writeToday} />
                </section>
              )}
            </ScrollBox>
          </div>
        }
        right={
          <>
            <h2 className="workspace-title">所有日记</h2>
            {feed}
          </>
        }
      />
    </main>
  );
}

/** The narrow workspace: one page, everything in it. */
function Workspace({ className, children }: { className: string; children: ReactNode }) {
  return (
    <main className="days-workspace">
      <BookSpread className={`workspace ${className}`} left={children} right={null} />
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
      <button type="button" className="primary" disabled={opening} onClick={() => void open()}>
        写今天
      </button>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
