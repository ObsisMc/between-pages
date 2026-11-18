import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { authorRuns, createDiaryDoc } from '@between-pages/collab';
import type { BodyOf, ResponseOf } from '@between-pages/contracts';
import {
  Refused,
  keyOf,
  requestDigest,
  type RecordRef,
  type Refusal,
  type SpaceRecords,
  type UnreadItem,
  type Unseen,
  type WriteContext,
} from '../space-records/space-records.ts';
import { SharedPageQueries, SharedPageWrites, type SharedPageRow } from '../store/shared-pages.ts';
import { DiaryQueries, type CommitPoint, type Tx } from '../store/store.ts';

// Shared pages (shared-pages ADR), written only through space-records. Either of the two
// renames or deletes a page (D3), so nothing here calls `authorOnly`; the text is the commit
// chain's, whose author rules are the diary's (D2). Only the commit service writes text.

type Page = ResponseOf<'createSharedPage'>['page'];
type Present = {
  tx: Tx;
  unseen: (refs: readonly RecordRef[]) => Promise<Map<string, Unseen>>;
};

/** Binary state, turned to the wire's base64 by the route. */
export type PageView = {
  page: Page;
  readOnly: boolean;
  periodId: string | null;
  generationId: string;
  seq: number;
  state: Uint8Array;
  bindings: Map<number, string>;
};

/**
 * What one person's Google copy of a page is built from (google-copy-beyond-diaries D5, D7):
 * the page's title and commits, whether it is deleted, and whether the space is unbound.
 */
export type PageCopySource = {
  title: string;
  /** When the title was last set; null while it is the one the page was created with. */
  titleAt: Date | null;
  createdAt: Date;
  deleted: boolean;
  readOnly: boolean;
  timeline: CommitPoint[];
};

const ref = (id: string): RecordRef => ({ type: 'shared_page', id });
const EMPTY_BASELINE = Y.encodeStateAsUpdate(createDiaryDoc());
const NOTHING_NEW: Unseen = { unread: null, mark: 0 };

const asPage = (row: SharedPageRow, unseen: Unseen): Page => ({
  id: row.id,
  title: row.title,
  authorId: row.authorId,
  revision: row.revision,
  updatedAt: row.updatedAt.toISOString(),
  renamed: row.titleBy && row.titleAt ? { by: row.titleBy, at: row.titleAt.toISOString() } : null,
  unread: unseen.unread,
  mark: unseen.mark,
});

const newest = (a: SharedPageRow, b: SharedPageRow) =>
  b.updatedAt.getTime() - a.updatedAt.getTime();

export function createSharedPageService(records: SpaceRecords) {
  const writes = (ctx: WriteContext) => new SharedPageWrites(ctx.tx);
  const pageOut = async (ctx: Present, row: SharedPageRow) =>
    asPage(row, (await ctx.unseen([ref(row.id)])).get(keyOf(ref(row.id))) ?? NOTHING_NEW);

  return {
    async view(caller: string): Promise<ResponseOf<'sharedPages'> | 'NOT_FOUND'> {
      return records.read(caller, async (ctx) => {
        const q = new SharedPageQueries(ctx.tx);
        const [rows, people] = await Promise.all([
          q.list(ctx.spaceId),
          q.people([caller, ctx.partnerId]),
        ]);
        const unseen = await ctx.unseen(rows.map((r) => ref(r.id)));
        const notes = await ctx.deletionNotes(['shared_page']);
        const deleted = new Map(
          (
            await q.byIds(
              ctx.spaceId,
              notes.map((n) => n.ref.id),
            )
          ).map((r) => [r.id, r]),
        );
        const person = (id: string) => people.find((p) => p.id === id)!;
        return {
          me: person(caller),
          partner: person(ctx.partnerId),
          readOnly: ctx.readOnly,
          pages: [...rows]
            .sort(newest)
            .map((row) => asPage(row, unseen.get(keyOf(ref(row.id))) ?? NOTHING_NEW)),
          notes: notes
            .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
            .map((n) => ({
              id: n.ref.id,
              title: deleted.get(n.ref.id)!.title,
              deleted: { by: n.deletedBy, at: n.deletedAt.toISOString() },
              wrote: n.acted.has('wrote'),
              unread: n.unread,
              mark: n.mark,
            })),
        };
      });
    },

    /** Every page holding something the caller has not seen, and unread deletion notes (D3). */
    async unreadItems(caller: string): Promise<UnreadItem[] | 'NOT_FOUND'> {
      return records.read(caller, async (ctx) => {
        const rows = await new SharedPageQueries(ctx.tx).list(ctx.spaceId);
        const unseen = await ctx.unseen(rows.map((r) => ref(r.id)));
        const notes = await ctx.deletionNotes(['shared_page']);
        return [
          ...rows.flatMap((row) => {
            const u = unseen.get(keyOf(ref(row.id)));
            return u?.unread ? [{ ...ref(row.id), mark: u.mark, unread: u.unread }] : [];
          }),
          ...notes
            .filter((n) => n.unread)
            .map((n) => ({ ...n.ref, mark: n.mark, unread: 'deleted' as const })),
        ];
      });
    },

    /** How many records the entry dot counts: `unreadItems`. */
    async unread(caller: string): Promise<number | 'NOT_FOUND'> {
      const items = await this.unreadItems(caller);
      return items === 'NOT_FOUND' ? items : items.length;
    },

    /** The current titles of these pages of the caller's space; deleted ones are absent. */
    async titles(caller: string, ids: readonly string[]): Promise<Map<string, string>> {
      const found = await records.read(caller, async (ctx) =>
        (await new SharedPageQueries(ctx.tx).byIds(ctx.spaceId, ids)).filter((r) => !r.deletedAt),
      );
      return new Map(found === 'NOT_FOUND' ? [] : found.map((r) => [r.id, r.title]));
    },

    /**
     * The worker's entry for the caller's Google copy of a page (google-copy-beyond-diaries
     * D7, invariant 1): a live page as the caller opens it, and also one deleted, whose last
     * commit the copy still writes, but only for the two people of its space. No route
     * reaches it, so a deleted page stays gone for every answer (shared-pages invariant 5).
     */
    async copySource(caller: string, pageId: string): Promise<PageCopySource | null> {
      const found = await records.read(caller, async (ctx) => {
        const [row] = await new SharedPageQueries(ctx.tx).byIds(ctx.spaceId, [pageId]);
        if (!row) return null;
        return {
          title: row.title,
          titleAt: row.titleAt,
          createdAt: row.createdAt,
          deleted: row.deletedAt !== null,
          readOnly: ctx.readOnly,
          timeline: await new DiaryQueries(ctx.tx).timeline(row.id),
        };
      });
      return found === 'NOT_FOUND' ? null : found;
    },

    /** The text of a commit of `copySource`'s page as author runs, for the same two people. */
    async copyRuns(
      caller: string,
      pageId: string,
      commit: CommitPoint,
    ): Promise<{ author: string; text: string }[] | null> {
      const found = await records.read(caller, async (ctx) => {
        const [row] = await new SharedPageQueries(ctx.tx).byIds(ctx.spaceId, [pageId]);
        if (!row) return null;
        const queries = new DiaryQueries(ctx.tx);
        const doc = await queries.state(row.id, commit.generationId, commit.version);
        const runs: { author: string; text: string }[] = [];
        for (const run of authorRuns(doc, await queries.bindings(row.id))) {
          const last = runs.at(-1);
          if (last?.author === run.author) last.text += run.text;
          else runs.push({ author: run.author, text: run.text });
        }
        return runs;
      });
      return found === 'NOT_FOUND' ? null : found;
    },

    /** The page as it opens; a deleted page is gone for both (invariant 5). */
    async open(caller: string, pageId: string): Promise<PageView | 'NOT_FOUND'> {
      return records.read(caller, async (ctx) => {
        const row = await new SharedPageQueries(ctx.tx).one(ctx.spaceId, pageId);
        if (!row) return 'NOT_FOUND';
        const queries = new DiaryQueries(ctx.tx);
        const doc = await queries.state(row.id, row.generationId, row.version);
        return {
          page: await pageOut(ctx, row),
          readOnly: ctx.readOnly,
          periodId: ctx.periodId,
          generationId: row.generationId,
          seq: await queries.seq(row.id, row.generationId),
          state: Y.encodeStateAsUpdate(doc),
          bindings: await queries.bindings(row.id),
        };
      });
    },

    /** As the diary's catch-up (kernel D14), for the two people of the page's space. */
    async catchUp(viewer: string, pageId: string, generationId: string, knownSeq: number) {
      return records.read(viewer, async (ctx) => {
        const row = await new SharedPageQueries(ctx.tx).one(ctx.spaceId, pageId);
        if (!row) return 'NOT_FOUND' as const;
        if (row.generationId !== generationId) return 'STALE_CONTEXT' as const;
        const queries = new DiaryQueries(ctx.tx);
        const seq = await queries.seq(pageId, generationId);
        if (knownSeq > seq) return 'STALE_CONTEXT' as const;
        return {
          seq,
          commits: await queries.deltasAfter(pageId, generationId, knownSeq),
          bindings: await queries.bindings(pageId),
        };
      });
    },

    create(caller: string, body: BodyOf<'createSharedPage'>): Promise<Page | Refusal> {
      const { requestId, ...fields } = body;
      const request = {
        id: requestId,
        digest: requestDigest('createSharedPage', fields),
        source: 'change' as const,
      };
      return records.write(
        caller,
        request,
        async (ctx) => {
          const row = await writes(ctx).create({
            id: randomUUID(),
            generationId: randomUUID(),
            baseline: EMPTY_BASELINE,
            spaceId: ctx.spaceId,
            authorId: caller,
            createdPeriodId: ctx.periodId,
            title: body.title,
          });
          await ctx.changed(ref(row.id), 'create', null, request);
          return pageOut(ctx, row);
        },
        async (ctx, hit) => {
          const row = await writes(ctx).one(ctx.spaceId, hit.recordId);
          if (!row) throw new Refused('NOT_FOUND');
          return pageOut(ctx, row);
        },
      );
    },

    rename(
      caller: string,
      pageId: string,
      body: BodyOf<'renameSharedPage'>,
    ): Promise<Page | Refusal> {
      const { requestId, ...fields } = body;
      const request = {
        id: requestId,
        digest: requestDigest('renameSharedPage', { pageId, ...fields }),
        source: 'action' as const,
      };
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const page = await w.lock(ctx.spaceId, pageId);
          if (!page) throw new Refused('NOT_FOUND');
          if (page.revision !== body.expectedRevision) throw new Refused('RECORD_STALE');
          const now = new Date();
          const row = await w.update(page.id, {
            title: body.title,
            titleBy: caller,
            titleAt: now,
            updatedAt: now,
            revision: page.revision + 1,
          });
          await ctx.acted(ref(page.id), 'renamed', null, request);
          return pageOut(ctx, row);
        },
        async (ctx, hit) => {
          const row = await writes(ctx).one(ctx.spaceId, hit.recordId);
          if (!row) throw new Refused('NOT_FOUND');
          return pageOut(ctx, row);
        },
      );
    },

    remove(caller: string, pageId: string, requestId: string): Promise<true | Refusal> {
      const request = {
        id: requestId,
        digest: requestDigest('deleteSharedPage', { pageId }),
        source: 'change' as const,
      };
      return records.write(
        caller,
        request,
        async (ctx) => {
          const w = writes(ctx);
          const page = await w.lock(ctx.spaceId, pageId);
          if (!page) throw new Refused('NOT_FOUND');
          await w.update(page.id, { deletedAt: new Date(), deletedBy: caller });
          await ctx.changed(ref(page.id), 'delete', null, request);
          return true as const;
        },
        async () => true as const,
      );
    },
  };
}

export type SharedPageService = ReturnType<typeof createSharedPageService>;
