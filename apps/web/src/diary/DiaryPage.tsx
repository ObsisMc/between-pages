import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMe } from '../auth/me.ts';
import { HistoryPanel, HistoryPreview, type HistoryPointView } from '../history/index.ts';
import { DraftList } from './DraftList.tsx';
import { createDiarySession, type DiarySession, type DiaryState } from './session.ts';
import { failureText, refusalText, statusLine } from './status.ts';

const REFUSAL_SHOWN_MS = 4_000;

/** One open history preview, and where the current text stood when it opened. */
type Preview = { point: HistoryPointView; remoteChanges: number; scrollY: number };

/** One diary: the editor, its save status, recovery drafts and own history (kernel phase 3). */
export function DiaryPage() {
  const { diaryId } = useParams();
  const userId = useMe().data?.user.id;
  const place = useRef<HTMLDivElement>(null);
  const session = useRef<DiarySession | null>(null);
  const [state, setState] = useState<DiaryState | null>(null);
  /** The refusal count the notice was last hidden at. */
  const [dismissed, setDismissed] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (!place.current || !userId || !diaryId) return;
    const opened = createDiarySession({
      place: place.current,
      userId,
      diaryId,
      onChange: setState,
    });
    session.current = opened;
    return () => {
      opened.destroy();
      session.current = null;
    };
  }, [userId, diaryId]);

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
          <div ref={place} className="diary-editor" hidden={!open || preview !== null} />
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
            selected={preview?.point.publicId ?? null}
            onSelect={showVersion}
          />
        )}
      </div>
    </main>
  );
}
