import { useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { History } from 'lucide-react';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { HistoryPanel, HistoryPreview, type HistoryPointView } from '../history/index.ts';
import { Button, cn } from '../ui/index.ts';
import { DraftList } from './DraftList.tsx';
import { ScrollBox } from './scroll-box.ts';
import {
  createDiarySession,
  type DiarySession,
  type DiaryState,
  type PageClosed,
  type PageSource,
} from './session.ts';
import { failureText, refusalText, statusLine } from './status.ts';
import './diary-block.css';

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
 * the copy when it cannot be stored, and the recovery drafts. The day holds one per diary,
 * each with its own session, so nothing of one reaches the other (unread-and-day-page D6,
 * invariant 9). `title` heads it; `onSession` hands the session to
 * the page for the filter, unread jumps and the reading position.
 */
/** This diary in the caller's own Google Drive (server-backup-and-google-docs D9). */
export type GoogleCopy = {
  connected: boolean;
  backedUpAt: string | null;
  docUrl: string | null;
  problem: ResponseOf<'day'>['google']['problem'];
};

/** One side of the day's Doc in the caller's Drive. */
export const copyOf = (
  google: ResponseOf<'day'>['google'],
  side: 'mine' | 'partner',
): GoogleCopy => ({
  connected: google.connected,
  backedUpAt: google[side],
  docUrl: google.docUrl,
  problem: google.problem,
});

/** Why newer text is not in the Doc yet; every failure says so here (D9, Ray 2026-10-29). */
const PROBLEM_TEXT: Record<NonNullable<GoogleCopy['problem']>, string> = {
  reconnect: 'Google 备份已暂停：需要到备份页重新连接',
  storage_full: 'Google 空间已满，备份暂停',
  unreachable: '暂时连不上 Google，正在自动重试',
  failed: '备份到 Google 失败，正在自动重试',
};

function GoogleCopyLine({ copy }: { copy: GoogleCopy }) {
  if (!copy.connected) return <p className="text-sm text-ink-soft">未开启 Google 备份</p>;
  const backedUp = copy.backedUpAt && (
    <>
      已备份到 Google {writtenText.format(new Date(copy.backedUpAt))}
      {copy.docUrl && (
        <>
          {' · '}
          <a
            href={copy.docUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-ink"
          >
            在 Google Docs 打开
          </a>
        </>
      )}
    </>
  );
  if (copy.problem)
    return (
      <p className="text-sm text-warm" role="status">
        {PROBLEM_TEXT[copy.problem]}
        {backedUp && <> · {backedUp}</>}
      </p>
    );
  return <p className="text-sm text-ink-soft">{backedUp || '等待备份到 Google'}</p>;
}

const CLOSED_TEXT: Record<PageClosed, string> = {
  SPACE_READ_ONLY: '已解绑，记录只读',
  NOT_FOUND: '这一页已被删除',
};

const noticeClass = 'mt-3 rounded-xl bg-notice px-4 py-3 text-sm text-ink';
const TONE: Record<'calm' | 'busy' | 'warn', string> = {
  calm: 'font-medium text-done',
  busy: 'text-ink-soft',
  warn: 'text-warm',
};

export function DiaryBlock({
  userId,
  diaryId,
  epochId,
  page,
  people,
  title,
  googleCopy,
  keepPosition,
  onSession,
  onReport,
  onReopen,
}: {
  userId: string;
  diaryId: string;
  epochId?: string | undefined;
  /** Opens a shared page instead of a diary; it has no history or per-character origin. */
  page?: PageSource | undefined;
  /** Shown beside the save status once known; "已备份到 Google" never means more than the Doc holds. */
  googleCopy?: GoogleCopy | undefined;
  /** By user ID; author colors follow the space's slots, so one person has one color. */
  people: Map<string, Person>;
  title?: ReactNode;
  keepPosition?: (apply: () => void) => void;
  onSession?: (session: DiarySession | null) => void;
  onReport?: (report: BlockReport) => void;
  /** The partner shared this diary again while it was open; the page opens the new epoch. */
  onReopen?: () => void;
}) {
  const peopleRef = useRef(people);
  const keepRef = useRef(keepPosition);
  const pageRef = useRef(page);
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
  const scrollBox = useContext(ScrollBox);

  useEffect(() => {
    if (!place.current) return;
    const opened = createDiarySession({
      place: place.current,
      userId,
      diaryId,
      epochId,
      page: pageRef.current,
      authorClass: (author) => {
        const slot = peopleRef.current.get(author)?.slot;
        return slot ? `author-slot-${slot}` : null;
      },
      nameOf: (user) => peopleRef.current.get(user)?.name ?? '',
      onChange: setState,
      scroller: scrollBox?.current ?? undefined,
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
  }, [userId, diaryId, epochId, scrollBox]);

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
    if (page) return;
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
      scrollY: open?.scrollY ?? scrollBox?.current?.scrollTop ?? window.scrollY,
    }));
  const closePreview = () => {
    const scrollY = preview?.scrollY ?? 0;
    setPreview(null);
    requestAnimationFrame(() => {
      if (scrollBox?.current) scrollBox.current.scrollTop = scrollY;
      else window.scrollTo(0, scrollY);
    });
  };

  const status = state ? statusLine(state) : null;
  const open = state?.phase === 'open';
  return (
    <div>
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {title}
        {open && status && !state.closed && (
          // `save-status` and its tone name the line for its check mark (diary-block.css).
          <p className={cn('save-status text-sm', status.tone, TONE[status.tone])} role="status">
            {status.text}
          </p>
        )}
        {open && googleCopy && <GoogleCopyLine copy={googleCopy} />}
        {open && !page && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={historyOpen}
            onClick={() => {
              if (historyOpen) closePreview();
              setHistoryOpen(!historyOpen);
            }}
          >
            <History aria-hidden="true" />
            {historyOpen ? '收起历史' : '历史'}
          </Button>
        )}
      </div>
      {state?.closed && (
        <p className={noticeClass} role="status">
          {CLOSED_TEXT[state.closed]}
        </p>
      )}
      {state?.share === 'frozen' && (
        <p className={noticeClass} role="status">
          已停止共享，内容不再更新
        </p>
      )}
      {state?.reopened && onReopen && (
        <p className={noticeClass}>
          对方重新共享了这篇日记。
          <Button type="button" variant="link" className="text-warm underline" onClick={onReopen}>
            打开最新的版本
          </Button>
        </p>
      )}
      {origin && (
        <p className="author-info mt-3 text-sm text-ink-soft" role="status">
          {origin.name} 写于 {origin.at}
          {origin.adjusted && '（设备时间不准，按服务器收到的时间）'}
        </p>
      )}
      {(!state || state.phase === 'opening') && (
        <p className="py-8 text-center text-ink-soft">正在打开…</p>
      )}
      {state?.phase === 'failed' && (
        <p className={noticeClass} role="alert">
          {page && state.failure === 'NOT_FOUND'
            ? CLOSED_TEXT.NOT_FOUND
            : failureText(state.failure)}
        </p>
      )}
      {state?.storeFailed && (
        <div className={cn(noticeClass, 'grid gap-3')} role="alert">
          <p>这台设备暂时无法保存，刚写的字还没有存下。请先不要关闭页面。</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={copyText}>
              复制正文
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={downloadText}>
              下载正文
            </Button>
          </div>
        </div>
      )}
      {refusal && (
        <p className={cn('refusal', noticeClass)} role="alert">
          {refusal}
        </p>
      )}
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
        className="diary-editor mt-2"
        hidden={!open || preview !== null}
        onClick={(event) => void showOrigin(event)}
      />
      {state && (
        <DraftList
          drafts={state.drafts}
          onDelete={(draftIds) => void session.current?.deleteDrafts(draftIds)}
        />
      )}
      {/* Below the text at every width: the main area holds one reading column. */}
      {open && historyOpen && (
        <HistoryPanel
          diaryId={diaryId}
          commits={state.remoteChanges}
          selected={preview?.point.publicId ?? null}
          onSelect={showVersion}
        />
      )}
    </div>
  );
}
