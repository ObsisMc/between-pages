import * as Y from 'yjs';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import { VersionUnreadable } from '../errors.ts';
import { covers } from '../sharing/selection.ts';
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

/** One home-page card; `excerpt` is null when the stored text fails verification. */
export type DiarySummary = {
  diaryId: string;
  diaryDate: string;
  excerpt: string | null;
  updatedAt: Date;
};

export const LIST_PAGE_SIZE = 30;
/** Characters, not UTF-16 units, so an emoji is never cut in half. */
export const EXCERPT_LENGTH = 80;

const excerptOf = (text: string) =>
  Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, EXCERPT_LENGTH).join('');

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
     * UTC clock, never the device's (spec §4); creates it when missing, opened to the
     * partner when the owner's confirmed range covers its date (kernel D5). A future date
     * is refused: the first release does not create diaries ahead (spec §4.6).
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
        sharedOn: covers,
      });
      return { created, diary: (await view(owner, diaryId))! };
    },

    view,

    /**
     * The owner's own diaries, newest date first, one page before `before`. The excerpt is
     * rendered here from the committed state, so no CRDT data leaves the server; a diary
     * whose stored text fails verification still gets its card, without an excerpt.
     */
    async list(
      owner: string,
      before: string | undefined,
    ): Promise<{ diaries: DiarySummary[]; nextBefore: string | null }> {
      return store.read(async (queries) => {
        const rows = await queries.ownedDiaries(owner, before ?? null, LIST_PAGE_SIZE + 1);
        const page = rows.slice(0, LIST_PAGE_SIZE);
        const diaries: DiarySummary[] = [];
        for (const row of page) {
          let excerpt: string | null;
          try {
            const doc = await queries.state(row.id, row.generationId, row.version);
            excerpt = excerptOf(doc.getText(BODY).toString());
          } catch (error) {
            if (!(error instanceof VersionUnreadable)) throw error;
            excerpt = null;
          }
          diaries.push({
            diaryId: row.id,
            diaryDate: row.diaryDate,
            excerpt,
            updatedAt: row.updatedAt,
          });
        }
        return {
          diaries,
          nextBefore: rows.length > LIST_PAGE_SIZE ? page.at(-1)!.diaryDate : null,
        };
      });
    },

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
