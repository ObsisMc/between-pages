import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReadRange } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { DayText, decodeText, visibleOthers, type Clip, type TextRun } from '../day-text/index.ts';
import {
  createReadTracker,
  keptSpans,
  unreadSpans,
  type ReadMarks,
} from '../read-tracker/index.ts';
import { needsText, type DiaryRef, type LoadedVersion, type Side } from './model.ts';

type Loaded = LoadedVersion & { runs: TextRun[] };

const NO_MARKS: readonly ReadRange[] = [];
const quiet = () => () => undefined;

/** The authorized state of a diary: the own one, or the partner's share by its epoch (kernel D17). */
function readState({ diaryId, epochId }: DiaryRef) {
  return epochId
    ? callApi('sharedDiary', { params: { diaryId, epochId } }).then(({ diary }) => ({
        runs: decodeText(diary),
        frozen: diary.share === 'frozen',
      }))
    : callApi('diary', { params: { diaryId } }).then(({ diary }) => ({
        runs: decodeText(diary),
        frozen: false,
      }));
}

/**
 * One expanded diary of the feed (book-frontend-workspace D4, D5, D8). Its text is read
 * only while the date is near the viewport, and again there when the list's `updatedAt`
 * moved; far away it keeps the text it has, which is then stale, until it comes near. The
 * text lives in this component's state only (ADR-0006 §8) and goes with it, so a diary
 * that collapses is read afresh when it opens again. Once text is shown, a read tracker
 * reports the other person's characters that stayed inside `clip` for about a second; its
 * coverage gives the unread passages, and `onUnread` hears whether any is left (undefined
 * until both text and coverage are known, and when this unmounts). What it reads goes to
 * `marks`, the diary page's record of the visit, and the text that record keeps is drawn
 * light, so it outlives this component (read-marks-until-leaving D1, D3).
 */
export function FeedDiary({
  diary,
  name,
  readerId,
  near,
  listUnread,
  authorClass,
  clip,
  onUnread,
  marks,
}: {
  diary: DiaryRef;
  /** Shown above the text when the date has both diaries. */
  name: string | null;
  readerId: string;
  near: boolean;
  /** Whether the list marks this diary unread, and is trusted. */
  listUnread: boolean;
  authorClass: (author: string) => string;
  clip: () => Clip;
  onUnread: (side: Side, unread: boolean | undefined) => void;
  marks?: ReadMarks | undefined;
}) {
  const [text, setText] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [read, setRead] = useState<ReadRange[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const clipRef = useRef(clip);
  useEffect(() => {
    clipRef.current = clip;
  });

  const { diaryId, updatedAt, side } = diary;
  const kept = useSyncExternalStore(
    marks?.subscribe ?? quiet,
    useCallback(() => marks?.kept(diaryId) ?? NO_MARKS, [marks, diaryId]),
  );
  const wanted = near && !failed && needsText(diary, text);
  const diaryRef = useRef(diary);
  useEffect(() => {
    diaryRef.current = diary;
  });
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    readState(diaryRef.current).then(
      (state) => current && setText({ ...state, updatedAt }),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [wanted, updatedAt]);

  const loaded = text !== null;
  useEffect(() => {
    if (!loaded) return;
    const tracker = createReadTracker({
      diaryId,
      visible: () => (root.current ? visibleOthers(root.current, clipRef.current()) : []),
      onRead: setRead,
      marks,
    });
    return () => tracker.stop();
  }, [loaded, diaryId, marks]);

  const others = text?.runs
    .filter((run) => run.author !== readerId)
    .map((run) => ({ ...run, length: run.text.length }));
  const unread = others && read ? unreadSpans(others, read) : undefined;
  const anyUnread = unread && unread.length > 0;
  useEffect(() => {
    onUnread(side, anyUnread);
    return () => onUnread(side, undefined);
  }, [onUnread, side, anyUnread]);

  return (
    <div
      className="feed-diary mt-4"
      data-diary={diaryId}
      data-unread={listUnread && anyUnread === undefined ? 'loading' : undefined}
    >
      {(name || diary.frozen) && (
        <p className="feed-diary-who mb-1 flex gap-2 text-sm text-ink-soft">
          {name}
          {diary.frozen && <span className="text-xs">已停止共享</span>}
        </p>
      )}
      {text &&
        (text.runs.length ? (
          <DayText
            runs={text.runs}
            readerId={readerId}
            authorClass={authorClass}
            unread={unread ?? []}
            kept={others && read ? keptSpans(others, kept, read) : []}
            rootRef={root}
          />
        ) : (
          <p className="text-sm text-ink-soft">还没有写字</p>
        ))}
      {!text && !failed && <p className="text-sm text-ink-soft">正在读取…</p>}
      {failed && (
        <p className="flex items-center gap-3 rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          这篇暂时无法读取
          <button
            type="button"
            className="h-8 cursor-pointer rounded-lg border border-line px-3 text-ink hover:bg-paper"
            onClick={() => setFailed(false)}
          >
            重试
          </button>
        </p>
      )}
    </div>
  );
}
