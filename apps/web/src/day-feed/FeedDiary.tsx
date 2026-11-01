import { useEffect, useRef, useState } from 'react';
import type { ReadRange } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { DayText, decodeText, visibleOthers, type Clip, type TextRun } from '../day-text/index.ts';
import { createReadTracker, unreadSpans } from '../read-tracker/index.ts';
import { needsText, type DiaryRef, type LoadedVersion, type Side } from './model.ts';

type Loaded = LoadedVersion & { runs: TextRun[] };

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
 * until both text and coverage are known, and when this unmounts).
 */
export function FeedDiary({
  diary,
  name,
  readerId,
  near,
  authorClass,
  clip,
  onUnread,
}: {
  diary: DiaryRef;
  /** Shown above the text when the date has both diaries. */
  name: string | null;
  readerId: string;
  near: boolean;
  authorClass: (author: string) => string;
  clip: () => Clip;
  onUnread: (side: Side, unread: boolean | undefined) => void;
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
    });
    return () => tracker.stop();
  }, [loaded, diaryId]);

  const unread =
    text && read
      ? unreadSpans(
          text.runs
            .filter((run) => run.author !== readerId)
            .map((run) => ({ ...run, length: run.text.length })),
          read,
        )
      : undefined;
  const anyUnread = unread && unread.length > 0;
  useEffect(() => {
    onUnread(side, anyUnread);
    return () => onUnread(side, undefined);
  }, [onUnread, side, anyUnread]);

  return (
    <div className="feed-diary" data-diary={diaryId}>
      {(name || diary.frozen) && (
        <p className="feed-diary-who">
          {name}
          {diary.frozen && <span className="share-state">已停止共享</span>}
        </p>
      )}
      {text &&
        (text.runs.length ? (
          <DayText
            runs={text.runs}
            readerId={readerId}
            authorClass={authorClass}
            unread={unread ?? []}
            rootRef={root}
          />
        ) : (
          <p className="list-note">还没有写字</p>
        ))}
      {!text && !failed && <p className="list-note">正在读取…</p>}
      {failed && (
        <p className="notice" role="alert">
          这篇暂时无法读取{' '}
          <button type="button" onClick={() => setFailed(false)}>
            重试
          </button>
        </p>
      )}
    </div>
  );
}
