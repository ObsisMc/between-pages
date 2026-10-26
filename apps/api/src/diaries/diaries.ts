import * as Y from 'yjs';
import { createDiaryDoc } from '@between-pages/collab';
import type { Store } from '../store/store.ts';

/** The owner's view of a diary's current generation (kernel D10 "打开个人日记"). */
export type DiaryView = {
  diaryId: string;
  diaryDate: string;
  ownerId: string;
  generationId: string;
  seq: number;
  state: Uint8Array;
  bindings: Map<number, string>;
};

export type CatchUp = {
  seq: number;
  commits: { seq: number; publicId: string; delta: Uint8Array }[];
  bindings: Map<number, string>;
};

// en-CA formats as YYYY-MM-DD, the diary date's own format.
const today = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** A new diary's first generation starts from the empty document. */
const EMPTY_BASELINE = Y.encodeStateAsUpdate(createDiaryDoc());

/**
 * The owner's personal entry to their diaries (spaces-and-invitations D1, kernel D1,
 * D10, D14): open or create by date, open by ID, and catch up by seq. Phase 2 has no
 * sharing, so the owner is the only viewer; anyone else gets NOT_FOUND, as for a diary
 * that does not exist (D10). Partner-facing reads belong to the phase-4 reader (D17).
 */
export function createDiaryService(store: Store) {
  async function view(viewer: string, diaryId: string): Promise<DiaryView | null> {
    return store.read(async (queries) => {
      const diary = await queries.findDiary(diaryId);
      if (diary?.ownerId !== viewer) return null;
      const doc = await queries.state(diary.id, diary.generationId, diary.version);
      return {
        diaryId: diary.id,
        diaryDate: diary.diaryDate,
        ownerId: diary.ownerId,
        generationId: diary.generationId,
        seq: await queries.seq(diary.id, diary.generationId),
        state: Y.encodeStateAsUpdate(doc),
        bindings: await queries.bindings(diary.id),
      };
    });
  }

  return {
    /**
     * Opens the owner's diary for `date`, or for today in `timezone` from the server's
     * UTC clock, never the device's (spec §4); creates it when missing. A future date is
     * refused: the first release does not create diaries ahead (spec §4.6).
     */
    async open(
      owner: string,
      request: { timezone: string; date?: string | undefined },
    ): Promise<{ created: boolean; diary: DiaryView } | 'FUTURE_DATE'> {
      const diaryDate = request.date ?? today(request.timezone);
      if (diaryDate > today(request.timezone)) return 'FUTURE_DATE';
      const { created, diaryId } = await store.openPersonal({
        ownerId: owner,
        diaryDate,
        timezone: request.timezone,
        baseline: EMPTY_BASELINE,
      });
      return { created, diary: (await view(owner, diaryId))! };
    },

    view,

    /**
     * Commits after `knownSeq` in the caller's generation, read in one snapshot (D14).
     * A different generation, or a seq the server never reached, is STALE_CONTEXT: the
     * client reconciles and reopens instead of merging across a boundary.
     */
    async catchUp(
      viewer: string,
      diaryId: string,
      generationId: string,
      knownSeq: number,
    ): Promise<CatchUp | 'NOT_FOUND' | 'STALE_CONTEXT'> {
      return store.read(async (queries) => {
        const diary = await queries.findDiary(diaryId);
        if (diary?.ownerId !== viewer) return 'NOT_FOUND';
        if (diary.generationId !== generationId) return 'STALE_CONTEXT';
        const seq = await queries.seq(diaryId, generationId);
        if (knownSeq > seq) return 'STALE_CONTEXT';
        return {
          seq,
          commits: await queries.deltasAfter(diaryId, generationId, knownSeq),
          bindings: await queries.bindings(diaryId),
        };
      });
    },
  };
}

export type DiaryService = ReturnType<typeof createDiaryService>;
