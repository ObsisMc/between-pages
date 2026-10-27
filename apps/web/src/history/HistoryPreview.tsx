import { useEffect, useState } from 'react';
import type { ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';
import { fullLabel } from './format.ts';

type Version = ResponseOf<'historyVersion'>;

/**
 * One committed version, read-only, as the server renders it (kernel D6). The text is
 * fetched here and held only while it is shown: diary text stays out of the query cache
 * (ADR-0006 §8). There is no way to restore it; copying and pasting it back is new input.
 */
export function HistoryPreview({
  diaryId,
  publicId,
  userId,
  currentChanged,
  onClose,
}: {
  diaryId: string;
  publicId: string;
  userId: string;
  /** New text reached the current diary since the preview opened. */
  currentChanged: boolean;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{ publicId: string; version?: Version; failed?: string }>();

  useEffect(() => {
    let current = true;
    callApi('historyVersion', { params: { diaryId, publicId } }).then(
      (version) => current && setLoaded({ publicId, version }),
      (error: unknown) =>
        current &&
        setLoaded({
          publicId,
          failed:
            error instanceof ApiError && error.code === 'VERSION_UNREADABLE'
              ? '这个版本暂时无法读取'
              : '读取失败，请稍后再试',
        }),
    );
    return () => {
      current = false;
    };
  }, [diaryId, publicId]);

  const shown = loaded?.publicId === publicId ? loaded : undefined;
  return (
    <section className="history-preview" aria-label="历史版本预览">
      <header>
        <p className="history-badge">
          历史版本{shown?.version ? ` · ${fullLabel(shown.version.committedAt)}` : ''}，只读
        </p>
        <button type="button" onClick={onClose}>
          返回当前正文
        </button>
      </header>
      {currentChanged && (
        <p className="notice" role="status">
          当前正文有更新
        </p>
      )}
      {!shown && <p className="history-note">正在读取…</p>}
      {shown?.failed && (
        <p className="notice" role="alert">
          {shown.failed}
        </p>
      )}
      {shown?.version && (
        <div className="history-text">
          {shown.version.runs.map((run, i) => (
            <span key={i} className={run.author === userId ? 'author-self' : 'author-other'}>
              {run.text}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
