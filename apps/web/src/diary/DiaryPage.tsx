import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { callApi } from '../api/client.ts';
import { useMe } from '../auth/me.ts';
import { HistoryPanel, HistoryPreview, type HistoryPointView } from '../history/index.ts';
import { DraftList } from './DraftList.tsx';
import { createDiarySession, type DiarySession, type DiaryState, type Unread } from './session.ts';
import { failureText, refusalText, statusLine } from './status.ts';

const REFUSAL_SHOWN_MS = 4_000;

/** One open history preview, and where the current text stood when it opened. */
type Preview = { point: HistoryPointView; remoteChanges: number; scrollY: number };

type Person = { name: string; slot: 1 | 2 };
/** Who wrote a clicked character and when (TIME-03). */
type Origin = { name: string; at: string; adjusted: boolean };

const writtenText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * One diary: the own diary, or the partner's shared one by its epoch (`/shares/:epochId`).
 * The editor with each author's color and a legend, "只看我的文字", a click on a character
 * for its author and written time, the save status, recovery drafts and the history the
 * viewer may read (kernel D5, D6, D10; EDIT-13, EDIT-14, TIME-03).
 */
export function DiaryPage() {
  const { diaryId, epochId } = useParams();
  const userId = useMe().data?.user.id;
  // Author colors follow the space's slots, so one person has one color everywhere.
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => callApi('spaces') });
  const people = new Map<string, Person>(
    (spaces.data?.spaces ?? []).flatMap((space) =>
      space.participants.map((p) => [p.user.id, { name: p.user.displayName, slot: p.authorSlot }]),
    ),
  );
  const peopleRef = useRef(people);
  useEffect(() => {
    peopleRef.current = people;
  });
  const [origin, setOrigin] = useState<Origin | null>(null);
  const place = useRef<HTMLDivElement>(null);
  const session = useRef<DiarySession | null>(null);
  const [state, setState] = useState<DiaryState | null>(null);
  /** The refusal count the notice was last hidden at. */
  const [dismissed, setDismissed] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** "跳到第一处" was used: the opening notice has done its job. */
  const [jumped, setJumped] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  const peopleKnown = !spaces.isPending;
  useEffect(() => {
    if (!place.current || !userId || !diaryId || !peopleKnown) return;
    const opened = createDiarySession({
      place: place.current,
      userId,
      diaryId,
      epochId,
      authorClass: (author) => {
        const slot = peopleRef.current.get(author)?.slot;
        return slot ? `author-slot-${slot}` : null;
      },
      nameOf: (user) => peopleRef.current.get(user)?.name ?? '',
      onChange: setState,
    });
    session.current = opened;
    return () => {
      opened.destroy();
      session.current = null;
    };
  }, [userId, diaryId, epochId, peopleKnown]);

  // A click on a character asks the server who wrote it and when; the name comes from the space.
  const showOrigin = async (event: MouseEvent) => {
    const hit = session.current?.characterAt(event.clientX, event.clientY);
    if (!hit || !diaryId) return setOrigin(null);
    try {
      const info = await callApi('character', {
        params: { diaryId, clientId: hit.client, clock: hit.clock },
        query: epochId ? { epochId } : {},
      });
      setOrigin({
        name: peopleRef.current.get(info.author)?.name ?? '我',
        at: writtenText.format(new Date(info.writtenAt)),
        adjusted: info.clockAdjusted,
      });
    } catch {
      setOrigin(null);
    }
  };

  const refused = state?.refusal;
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => setDismissed(refused.count), REFUSAL_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [refused]);
  const refusal = refused && refused.count !== dismissed ? refusalText[refused.reason] : null;

  const copyText = () => void navigator.clipboard?.writeText(session.current?.text() ?? '');
  const downloadText = () => {
    const url = URL.createObjectURL(
      new Blob([session.current?.text() ?? ''], { type: 'text/plain' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'diary.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  // The editor stays mounted, hidden, while a version is previewed, so pending input, undo
  // and the caret are untouched; the scroll position comes back with it (kernel D6).
  const showVersion = (point: HistoryPointView) =>
    setPreview((open) => ({
      point,
      remoteChanges: open?.remoteChanges ?? state?.remoteChanges ?? 0,
      scrollY: open?.scrollY ?? window.scrollY,
    }));
  const closePreview = () => {
    const scrollY = preview?.scrollY ?? 0;
    setPreview(null);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  };

  const status = state ? statusLine(state) : null;
  const open = state?.phase === 'open';
  const unread = open && !preview ? state.unread : undefined;
  return (
    <main className="page diary">
      <header>
        <Link to="/">← 返回</Link>
        {open && status && (
          <p className={`save-status ${status.tone}`} role="status">
            {status.text}
          </p>
        )}
        {open && diaryId && (
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={() => {
              if (historyOpen) closePreview();
              setHistoryOpen(!historyOpen);
            }}
          >
            {historyOpen ? '收起历史' : '历史'}
          </button>
        )}
      </header>
      {open && people.size > 0 && (
        <div className="author-legend" aria-label="作者">
          {[...people.values()]
            .sort((a, b) => a.slot - b.slot)
            .map((person) => (
              <span key={person.slot} className={`author-slot-${person.slot}`}>
                {person.name}
              </span>
            ))}
          <label className="own-only">
            <input
              type="checkbox"
              checked={state.ownOnly}
              onChange={(e) => session.current?.setOwnTextOnly(e.target.checked)}
            />
            只看我的文字
          </label>
        </div>
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
      {state?.share === 'frozen' && (
        <p className="notice" role="status">
          已停止共享，内容不再更新
        </p>
      )}
      {state?.reopened && diaryId && (
        <p className="notice">
          对方重新共享了这篇日记。
          <Link to={`/diaries/${diaryId}/shares/${state.reopened}`}>打开最新的版本</Link>
        </p>
      )}
      {origin && (
        <p className="author-info" role="status">
          {origin.name} 写于 {origin.at}
          {origin.adjusted && '（设备时间不准，按服务器收到的时间）'}
        </p>
      )}
      {(!state || state.phase === 'opening') && <p className="status">正在打开…</p>}
      {state?.phase === 'failed' && (
        <p className="notice" role="alert">
          {failureText(state.failure)}
        </p>
      )}
      {state?.storeFailed && (
        <div className="notice" role="alert">
          <p>这台设备暂时无法保存，刚写的字还没有存下。请先不要关闭页面。</p>
          <button type="button" onClick={copyText}>
            复制正文
          </button>
          <button type="button" onClick={downloadText}>
            下载正文
          </button>
        </div>
      )}
      {refusal && (
        <p className="notice refusal" role="alert">
          {refusal}
        </p>
      )}
      <div className={historyOpen ? 'diary-body with-history' : 'diary-body'}>
        <div className="diary-main">
          {preview && diaryId && userId && (
            <HistoryPreview
              diaryId={diaryId}
              publicId={preview.point.publicId}
              userId={userId}
              currentChanged={(state?.remoteChanges ?? 0) !== preview.remoteChanges}
              onClose={closePreview}
            />
          )}
          <div
            ref={place}
            className="diary-editor"
            hidden={!open || preview !== null}
            onClick={(event) => void showOrigin(event)}
          />
          {state && (
            <DraftList
              drafts={state.drafts}
              onDelete={(draftIds) => void session.current?.deleteDrafts(draftIds)}
            />
          )}
        </div>
        {open && historyOpen && diaryId && (
          <HistoryPanel
            diaryId={diaryId}
            commits={state.remoteChanges}
            selected={preview?.point.publicId ?? null}
            onSelect={showVersion}
          />
        )}
      </div>
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
