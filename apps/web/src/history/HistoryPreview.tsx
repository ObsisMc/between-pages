import { useEffect, useState } from 'react';
import type { ResponseOf } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';
import { Button } from '../ui/index.ts';
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
    <section className="mt-3" aria-label="历史版本预览">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent px-4 py-2">
        <p className="text-sm text-ink-soft">
          历史版本{shown?.version ? ` · ${fullLabel(shown.version.committedAt)}` : ''}，只读
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          返回当前正文
        </Button>
      </header>
      {currentChanged && (
        <p className="mt-3 rounded-xl bg-notice px-4 py-3 text-sm" role="status">
          当前正文有更新
        </p>
      )}
      {!shown && <p className="mt-3 text-sm text-ink-soft">正在读取…</p>}
      {shown?.failed && (
        <p className="mt-3 rounded-xl bg-notice px-4 py-3 text-sm" role="alert">
          {shown.failed}
        </p>
      )}
      {shown?.version && (
        <div className="history-text py-4 text-[1.0625rem] leading-[1.9] whitespace-pre-wrap text-ink">
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
