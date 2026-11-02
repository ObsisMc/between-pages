import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import { BookSpread } from '../book/index.ts';
import { DiaryBlock, copyOf, type BlockReport, type Person } from './DiaryBlock.tsx';
import { useNarrow } from './narrow.ts';
import { ScrollBox } from './scroll-box.ts';
import type { DiarySession, Unread } from './session.ts';
import './workspace.css';

/** The people of the caller's spaces by user ID, for author colors and names. */
export function usePeople(): { people: Map<string, Person>; known: boolean } {
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => callApi('spaces') });
  const people = new Map<string, Person>(
    (spaces.data?.spaces ?? []).flatMap((space) =>
      space.participants.map((p) => [p.user.id, { name: p.user.displayName, slot: p.authorSlot }]),
    ),
  );
  return { people, known: !spaces.isPending };
}

/** The author legend with the one "只看我的文字" switch of the page (EDIT-13, EDIT-14). */
export function AuthorLegend({
  people,
  ownOnly,
  onOwnOnly,
}: {
  people: Map<string, Person>;
  ownOnly: boolean;
  onOwnOnly: (on: boolean) => void;
}) {
  if (people.size === 0) return null;
  return (
    <div className="author-legend" aria-label="作者">
      {[...people.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((person) => (
          <span key={person.slot} className={`author-slot-${person.slot}`}>
            {person.name}
          </span>
        ))}
      <label className="own-only">
        <input type="checkbox" checked={ownOnly} onChange={(e) => onOwnOnly(e.target.checked)} />
        只看我的文字
      </label>
    </div>
  );
}

/** How often an open own diary asks whether the partner wrote the same day (D6). */
export const DAY_CHECK_MS = 45_000;

/**
 * The date as the day page sees it, checked on entry, when the window comes back and every
 * DAY_CHECK_MS; a failed check keeps the last answer: whether the partner has a diary they
 * share with the caller (unread-and-day-page D6), and the caller's Google copy of the day
 * (server-backup-and-google-docs D9). The page never changes its layout by itself (invariant 13).
 */
function useDayCheck(date: string | undefined): ResponseOf<'day'> | null {
  const [checked, setChecked] = useState<ResponseOf<'day'> | null>(null);
  useEffect(() => {
    if (!date) return;
    let live = true;
    const check = () =>
      callApi('day', { params: { date } }).then(
        (answer) => live && setChecked(answer),
        () => undefined,
      );
    void check();
    const onForeground = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const timer = setInterval(onForeground, DAY_CHECK_MS);
    window.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
    };
  }, [date]);
  return checked;
}

/**
 * One diary: the own diary, or the partner's shared one by its epoch (`/shares/:epochId`).
 * The diary block, the author legend with "只看我的文字", and what is unread (kernel D5,
 * D6, D10; EDIT-13, EDIT-14, TIME-03; unread-and-day-page D4). On the own diary, once the
 * partner shares the same day, "TA 也写了这天 · 切到双人页" offers the day page (D6).
 */
export function DiaryPage() {
  const { diaryId, epochId } = useParams();
  const userId = useMe().data?.user.id;
  const { people, known } = usePeople();
  const session = useRef<DiarySession | null>(null);
  const [report, setReport] = useState<BlockReport | null>(null);
  /** "跳到第一处" was used: the opening notice has done its job. */
  const [jumped, setJumped] = useState(false);
  // Held here so the switch shows the click at once; the session follows it.
  const [ownOnly, setOwnOnly] = useState(false);
  const state = report?.state;
  const open = state?.phase === 'open';
  const dayCheck = useDayCheck(state?.diaryDate);
  const partnerWrote = !epochId && !!dayCheck?.day.partner;
  const unread = open && !report?.previewing ? state.unread : undefined;
  const narrow = useNarrow();
  const box = useRef<HTMLDivElement>(null);
  const page = (
    <>
      <header>
        <Link to="/">← 返回</Link>
      </header>
      {partnerWrote && state?.diaryDate && (
        <p className="notice day-offer">
          TA 也写了这天 · <Link to={`/days/${state.diaryDate}`}>切到双人页</Link>
        </p>
      )}
      {open && (
        <AuthorLegend
          people={people}
          ownOnly={ownOnly}
          onOwnOnly={(on) => {
            session.current?.setOwnTextOnly(on);
            setOwnOnly(on);
          }}
        />
      )}
      {open && (
        <UnreadNotices
          unread={unread}
          jumped={jumped}
          onJump={(which) => {
            if (which === 'first') setJumped(true);
            session.current?.jumpToUnread(which);
          }}
        />
      )}
      {userId && diaryId && known && (
        <DiaryBlock
          key={`${diaryId}:${epochId ?? ''}`}
          userId={userId}
          diaryId={diaryId}
          epochId={epochId}
          people={people}
          googleCopy={dayCheck ? copyOf(dayCheck.google, epochId ? 'partner' : 'mine') : undefined}
          onSession={(opened) => {
            session.current = opened;
            if (opened && ownOnly) opened.setOwnTextOnly(true);
          }}
          onReport={setReport}
        />
      )}
    </>
  );
  // An old link (book-frontend-workspace D3): the diary on the left page, scrolling in its
  // own box on wide windows like the workspace's, and the way to its date on the right.
  return (
    <main className="diary-page">
      <BookSpread
        className={narrow ? 'workspace narrow-day' : 'workspace wide'}
        left={
          narrow ? (
            page
          ) : (
            <div className="workspace-left" ref={box}>
              <ScrollBox value={box}>{page}</ScrollBox>
            </div>
          )
        }
        right={
          state?.diaryDate && <Link to={`/days/${state.diaryDate}`}>在所有日记中打开这一天</Link>
        }
      />
    </main>
  );
}

/**
 * What the reader has not read yet (unread-and-day-page D4): on opening, "有 N 处新内容 ·
 * 跳到第一处" until used; "下一处未读" while any is left; and which way more lies outside
 * the window, without a count. None of it moves the page by itself, and none of it moves
 * the text either: the notice keeps its line while the diary is open, the rest floats over
 * the window's edge, so the reading position holds when they come and go (D5).
 */
export function UnreadNotices({
  unread,
  jumped,
  onJump,
}: {
  unread: Unread | undefined;
  jumped: boolean;
  onJump: (which: 'first' | 'next') => void;
}) {
  const left = unread?.left ?? 0;
  const offer = !!unread && left > 0 && unread.atOpen > 0 && !jumped;
  return (
    <>
      <p className={offer ? 'unread-banner' : 'unread-banner idle'} aria-hidden={!offer}>
        {offer && (
          <>
            有 {unread.atOpen} 处新内容 ·{' '}
            <button type="button" className="link" onClick={() => onJump('first')}>
              跳到第一处
            </button>
          </>
        )}
      </p>
      {left > 0 && (
        <div className="unread-tools">
          {unread?.above && (
            <p className="unread-direction above" role="status">
              ↑ 上面有新内容
            </p>
          )}
          {unread?.below && (
            <p className="unread-direction below" role="status">
              ↓ 下面有新内容
            </p>
          )}
          <button type="button" onClick={() => onJump('next')}>
            下一处未读
          </button>
        </div>
      )}
    </>
  );
}
