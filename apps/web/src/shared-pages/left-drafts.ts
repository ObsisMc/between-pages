import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { DiaryDraft } from '../diary/index.ts';
import { openJournal, type Journal } from '../journal/index.ts';

type Editing = DiaryDraft['intent'];

/**
 * Input left on this device for pages the server no longer lists (shared-pages 失败与恢复):
 * deleted while this device was offline, they can no longer be opened, so their text is
 * shown here, and stays until the user deletes it. `listed` is undefined until the server
 * has answered, since being offline says nothing about a page.
 */
export function useLeftDrafts(userId: string | undefined, listed: readonly string[] | undefined) {
  const [drafts, setDrafts] = useState<DiaryDraft[]>([]);
  const known = listed?.join();

  const collect = useCallback(
    async (journal: Journal<Editing>) => {
      const kept = new Set(known?.split(','));
      const gone = (await journal.pages()).filter((id) => !kept.has(id));
      const left: DiaryDraft[] = [];
      for (const pageId of gone) {
        await journal.retire(pageId, async (batchId) => {
          const query = { batchId };
          return (await callApi('receipt', { params: { diaryId: pageId }, query })).receipt;
        });
        left.push(...(await journal.drafts(pageId)));
      }
      return left;
    },
    [known],
  );

  useEffect(() => {
    if (!userId || known === undefined) return;
    let stopped = false;
    void (async () => {
      const journal = await openJournal<Editing>(userId);
      try {
        const left = await collect(journal);
        if (!stopped) setDrafts(left);
      } finally {
        journal.close();
      }
      // A journal or receipt that fails leaves the input where it is, for the next visit.
    })().catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [userId, known, collect]);

  const remove = async (draftIds: string[]) => {
    if (!userId) return;
    const journal = await openJournal<Editing>(userId);
    try {
      for (const draftId of draftIds) await journal.deleteDraft(draftId);
      setDrafts(await collect(journal));
    } finally {
      journal.close();
    }
  };

  return { drafts, remove };
}
