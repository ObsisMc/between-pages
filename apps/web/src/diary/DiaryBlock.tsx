import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { HistoryPanel, HistoryPreview, type HistoryPointView } from '../history/index.ts';
import { DraftList } from './DraftList.tsx';
import { createDiarySession, type DiarySession, type DiaryState } from './session.ts';
import { failureText, refusalText, statusLine } from './status.ts';

const REFUSAL_SHOWN_MS = 4_000;

export type Person = { name: string; slot: 1 | 2 };

/** What a page holding diaries learns of one: its state, whether it has text, a preview. */
export type BlockReport = { state: DiaryState; hasText: boolean; previewing: boolean };

/** One open history preview, and where the current text stood when it opened. */
type Preview = { point: HistoryPointView; remoteChanges: number; scrollY: number };
/** Who wrote a clicked character and when (TIME-03). */
type Origin = { name: string; at: string; adjusted: boolean };

const writtenText = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * One diary session and everything that belongs to it alone (kernel D5, D6, D10; EDIT-13,
 * TIME-03): the editor in each author's color, the save status, its own history, the
 * frozen and reopened notices, a click on a character for its author and time, refusals,
 * the copy when it cannot be stored, and the recovery drafts. The single diary page shows
 * one; the day page two, each with its own session, so nothing of one reaches the other
 * (unread-and-day-page D6, invariant 9). `title` heads it; `onSession` hands the session to
 * the page for the filter, unread jumps and the reading position.
 */
/** This diary in the caller's own Google Drive (server-backup-and-google-docs D9). */
export type GoogleCopy = { connected: boolean; backedUpAt: string | null; docUrl: string | null };

/** One side of the day's Doc in the caller's Drive. */
export const copyOf = (
  google: ResponseOf<'day'>['google'],
  side: 'mine' | 'partner',
): GoogleCopy => ({ connected: google.connected, backedUpAt: google[side], docUrl: google.docUrl });

function GoogleCopyLine({ copy }: { copy: GoogleCopy }) {
  if (!copy.connected) return <p className="google-copy">未开启 Google 备份</p>;
  if (!copy.backedUpAt) return <p className="google-copy">等待备份到 Google</p>;
  return (
    <p className="google-copy">
      已备份到 Google {writtenText.format(new Date(copy.backedUpAt))}
      {copy.docUrl && (
        <>
          {' · '}
          <a href={copy.docUrl} target="_blank" rel="noreferrer">
            在 Google Docs 打开
          </a>
        </>
      )}
    </p>
  );
}

export function DiaryBlock({
  userId,
  diaryId,
  epochId,
  people,
  title,
  googleCopy,
  keepPosition,
  onSession,
  onReport,
}: {
  userId: string;
  diaryId: string;
  epochId?: string | undefined;
  /** Shown beside the save status once known; "已备份到 Google" never means more than the Doc holds. */
  googleCopy?: GoogleCopy | undefined;
  /** By user ID; author colors follow the space's slots, so one person has one color. */
  people: Map<string, Person>;
  title?: ReactNode;
  keepPosition?: (apply: () => void) => void;
  onSession?: (session: DiarySession | null) => void;
  onReport?: (report: BlockReport) => void;
}) {
  const peopleRef = useRef(people);
  const keepRef = useRef(keepPosition);
  const reportRef = useRef(onReport);
  const sessionRef = useRef(onSession);
  useEffect(() => {
    peopleRef.current = people;
    keepRef.current = keepPosition;
    reportRef.current = onReport;
    sessionRef.current = onSession;
  });
  const [origin, setOrigin] = useState<Origin | null>(null);
  const place = useRef<HTMLDivElement>(null);
  const session = useRef<DiarySession | null>(null);
  const [state, setState] = useState<DiaryState | null>(null);
  /** The refusal count the notice was last hidden at. */
  const [dismissed, setDismissed] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (!place.current) return;
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
      // A page that holds the position itself says so when the diary opens.
      ...(keepRef.current
        ? { keepPosition: (apply: () => void) => keepRef.current?.(apply) ?? apply() }
        : {}),
    });
    session.current = opened;
    sessionRef.current?.(opened);
    return () => {
      opened.destroy();
      session.current = null;
      sessionRef.current?.(null);
    };
  }, [userId, diaryId, epochId]);

  useEffect(() => {
    if (state)
      reportRef.current?.({
        state,
        hasText: (session.current?.text() ?? '').trim() !== '',
        previewing: preview !== null,
      });
  }, [state, preview]);

  // A click on a character asks the server who wrote it and when; the name comes from the space.
  const showOrigin = async (event: MouseEvent) => {
    const hit = session.current?.characterAt(event.clientX, event.clientY);
    if (!hit) return setOrigin(null);
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
  return (
    <div className="diary-block">
      <div className="diary-block-head">
        {title}
        {open && status && (
          <p className={`save-status ${status.tone}`} role="status">
            {status.text}
          </p>
        )}
        {open && googleCopy && <GoogleCopyLine copy={googleCopy} />}
        {open && (
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
      </div>
      {state?.share === 'frozen' && (
        <p className="notice" role="status">
          已停止共享，内容不再更新
        </p>
      )}
      {state?.reopened && (
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
          {preview && (
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
        {open && historyOpen && (
          <HistoryPanel
            diaryId={diaryId}
            commits={state.remoteChanges}
            selected={preview?.point.publicId ?? null}
            onSelect={showVersion}
          />
        )}
      </div>
    </div>
  );
}
