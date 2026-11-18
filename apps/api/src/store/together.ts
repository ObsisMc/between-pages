import { and, desc, eq, gt, inArray, like, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  backupEvents,
  googleConnections,
  googleItemDocs,
  googleItemWork,
  spaceCopyOutbox,
} from '../db/schema.ts';
import type { ConnectionRow } from './backup.ts';
import type { WorkFailure, WorkOutcome } from './copy.ts';
import type { Tx } from './store.ts';

// The `Together` side of the Google copy (google-copy-beyond-diaries): the space outbox the
// writers fill in their own transactions, the pages and summaries waiting per person, and
// the Docs written for them. Like the day side, every Doc names its Google account, and
// nothing here reads or decrypts a token.

/** `page:<id>`, `wishes`, `gifts` or `anniversaries` (D4). */
export type Item = string;
export type ItemWorkRow = typeof googleItemWork.$inferSelect;
export type ItemDocRow = typeof googleItemDocs.$inferSelect;
export type Category = 'shared_pages' | 'wishes' | 'gifts' | 'anniversaries';

export const SUMMARIES = ['wishes', 'gifts', 'anniversaries'] as const;
export const pageItem = (pageId: string): Item => `page:${pageId}`;
export const pageIdOf = (item: Item): string | null =>
  item.startsWith('page:') ? item.slice(5) : null;
export const categoryOf = (item: Item): Category =>
  pageIdOf(item) ? 'shared_pages' : (item as Category);

/** A summary waits this long after its latest change (D5)... */
export const SUMMARY_QUIET_MS = 2 * 60_000;
/** ...but no longer than this after the first change of its batch. */
export const SUMMARY_MAX_MS = 10 * 60_000;

const BATCH = 200;

/**
 * Registers that a record of the space changed, in the caller's transaction (技术设计).
 * `recordType` null means every `Together` Doc of the space. `privateTo` is the write's own:
 * a private change is queued only for that person (D3).
 */
export async function registerSpaceCopy(
  tx: Tx,
  row: {
    spaceId: string;
    recordType: string | null;
    recordId: string | null;
    privateTo: string | null;
  },
): Promise<void> {
  await tx.insert(spaceCopyOutbox).values(row);
}

/** The user's items whose last attempt failed for a reason other than a full Drive. */
export const failingItems = (tx: Db | Tx, userId: string) =>
  tx
    .select({ item: googleItemWork.item, failure: googleItemWork.lastError })
    .from(googleItemWork)
    .where(
      and(
        eq(googleItemWork.userId, userId),
        gt(googleItemWork.attempts, 0),
        inArray(googleItemWork.lastError, ['unreachable', 'failed']),
      ),
    )
    .orderBy(googleItemWork.item) as Promise<{ item: Item; failure: 'unreachable' | 'failed' }[]>;

export function createTogetherStore(db: Db) {
  const docWith = async (userId: string, googleUserId: string, item: Item, state: string) =>
    (
      await db
        .select()
        .from(googleItemDocs)
        .where(
          and(
            eq(googleItemDocs.userId, userId),
            eq(googleItemDocs.googleUserId, googleUserId),
            eq(googleItemDocs.item, item),
            eq(googleItemDocs.state, state as ItemDocRow['state']),
          ),
        )
        .orderBy(desc(googleItemDocs.writtenAt))
        .limit(1)
    )[0] ?? null;

  return {
    /**
     * Turns pending space outbox rows into items of work (技术设计 "worker 的转换步骤"): a
     * shared row for each member with a connection, a private one only for `private_to`.
     * A summary becomes due two minutes after its latest change, at the latest ten after the
     * first of its batch; a page at once (it then waits for its history point). `onlyFor`
     * takes only the rows of these people's spaces ("现在备份"). Returns how many it took.
     */
    async intake(now: Date, onlyFor?: readonly string[]): Promise<number> {
      const only = onlyFor
        ? sql`and exists (select 1 from spaces s where s.id = o.space_id and (${sql.join(
            onlyFor.map((id) => sql`${id}::uuid in (s.user_low, s.user_high)`),
            sql` or `,
          )}))`
        : sql``;
      const at = now.toISOString();
      const result = await db.execute(sql`
        with picked as (
          select o.id, o.space_id, o.record_type, o.record_id, o.private_to
          from space_copy_outbox o
          where o.status = 'pending' ${only}
          order by o.created_at
          limit ${BATCH}
          for update of o skip locked
        ), members as (
          select p.*, m.user_id from picked p
          join spaces s on s.id = p.space_id
          cross join lateral (values (s.user_low), (s.user_high)) m(user_id)
          where p.private_to is null or p.private_to = m.user_id
        ), items as (
          select m.user_id, i.item from members m
          cross join lateral unnest(case m.record_type
            when 'wish' then array['wishes', 'gifts']
            when 'gift' then array['gifts', 'wishes']
            when 'gift_card' then array['gifts']
            when 'anniversary' then array['anniversaries', 'gifts']
            when 'shared_page' then array['page:' || m.record_id]
            else array[]::text[] end) i(item)
          where m.record_type is not null
          union
          select m.user_id, i.item from members m
          cross join lateral (
            select unnest(array['wishes', 'gifts', 'anniversaries']) as item
            union all
            select 'page:' || sp.id from shared_pages sp
            where sp.space_id = m.space_id and sp.deleted_at is null
          ) i
          where m.record_type is null
        ), queued as (
          insert into google_item_work (user_id, item, ready_at, first_at)
          select distinct i.user_id, i.item,
            case when i.item like 'page:%' then ${at}::timestamptz
              else ${at}::timestamptz + ${`${SUMMARY_QUIET_MS} milliseconds`}::interval end,
            ${at}::timestamptz
          from items i
          join google_connections c on c.user_id = i.user_id and c.status <> 'revoking'
          on conflict (user_id, item) do update set ready_at =
            case when google_item_work.now or google_item_work.attempts > 0
                or google_item_work.item like 'page:%' then google_item_work.ready_at
              else least(excluded.ready_at,
                google_item_work.first_at + ${`${SUMMARY_MAX_MS} milliseconds`}::interval) end
        )
        update space_copy_outbox set status = 'done', processed_at = ${at}::timestamptz
        where id in (select id from picked)`);
      return result.rowCount ?? 0;
    },

    /** "现在备份": every waiting item of the user is due now, without waiting (D5). */
    async runNow(userId: string, now: Date): Promise<void> {
      await db
        .update(googleItemWork)
        .set({ now: true, readyAt: now })
        .where(eq(googleItemWork.userId, userId));
    },

    /**
     * The next due item of an active connection whose token this key opens, locked until
     * `fn` returns, as for days: an intake meanwhile waits, then queues it again.
     */
    withDueItem<T>(
      now: Date,
      keyId: string,
      fn: (work: ItemWorkRow, connection: ConnectionRow, outcome: WorkOutcome) => Promise<T>,
    ): Promise<T | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ work: googleItemWork, connection: googleConnections })
          .from(googleItemWork)
          .innerJoin(googleConnections, eq(googleConnections.userId, googleItemWork.userId))
          .where(
            and(
              eq(googleConnections.status, 'active'),
              eq(googleConnections.keyId, keyId),
              lte(googleItemWork.readyAt, now),
            ),
          )
          .orderBy(googleItemWork.readyAt)
          .limit(1)
          .for('update', { of: googleItemWork, skipLocked: true });
        if (!row) return null;
        const { work, connection } = row;
        const key = and(eq(googleItemWork.userId, work.userId), eq(googleItemWork.item, work.item));
        return fn(work, connection, {
          done: async () => {
            await tx.delete(googleItemWork).where(key);
          },
          later: async (at, failure) => {
            // A run of failures, days and items together, begins with one entry (D8).
            if (failure && failure !== 'storage_full' && !(await anyFailing(tx, work.userId)))
              await tx
                .insert(backupEvents)
                .values({ userId: work.userId, kind: 'copy_failing', item: work.item });
            await tx
              .update(googleItemWork)
              .set({
                readyAt: at,
                now: false,
                attempts: failure ? work.attempts + 1 : 0,
                lastError: failure,
              })
              .where(key);
          },
        });
      });
    },

    /** Why this item is still waiting after an attempt, if it failed. */
    itemFailure: async (userId: string, item: Item): Promise<WorkFailure | null> => {
      const [row] = await db
        .select({ attempts: googleItemWork.attempts, failure: googleItemWork.lastError })
        .from(googleItemWork)
        .where(and(eq(googleItemWork.userId, userId), eq(googleItemWork.item, item)));
      return row && row.attempts > 0 ? (row.failure as WorkFailure | null) : null;
    },

    async storageFull(userId: string, item: Item): Promise<void> {
      await db.insert(backupEvents).values({ userId, kind: 'storage_full', item });
    },

    currentDoc: (userId: string, googleUserId: string, item: Item) =>
      docWith(userId, googleUserId, item, 'current'),

    /** A page deleted in the app whose Doc was written for the last time (D7). */
    deletedDoc: (userId: string, googleUserId: string, item: Item) =>
      docWith(userId, googleUserId, item, 'deleted'),

    /** Recorded before the first write, so a retry never makes a second Doc (invariant 3). */
    async createdDoc(row: {
      docId: string;
      userId: string;
      googleUserId: string;
      item: Item;
      title: string;
    }) {
      await db.insert(googleItemDocs).values({
        ...row,
        state: 'current',
        revisionId: '',
        contentSha256: new Uint8Array(),
        coveredAt: new Date(0),
      });
    },

    async recordWrite(
      docId: string,
      write: { revisionId: string; contentSha256: Uint8Array; coveredAt: Date },
    ) {
      await db
        .update(googleItemDocs)
        .set({ ...write, writtenAt: sql`now()` })
        .where(eq(googleItemDocs.docId, docId));
    },

    async recordCovers(docId: string, coveredAt: Date) {
      await db.update(googleItemDocs).set({ coveredAt }).where(eq(googleItemDocs.docId, docId));
    },

    /** Before a Drive rename: what it is to become and the revision it starts from. */
    async intendRename(docId: string, intent: NonNullable<ItemDocRow['renameIntent']>) {
      await db
        .update(googleItemDocs)
        .set({ renameIntent: intent })
        .where(eq(googleItemDocs.docId, docId));
    },

    /** After a Drive rename: the name it took and the revision Google now reports. */
    async renamed(docId: string, title: string, revisionId: string) {
      await db
        .update(googleItemDocs)
        .set({ renameIntent: null, title, revisionId, writtenAt: sql`now()` })
        .where(eq(googleItemDocs.docId, docId));
    },

    /**
     * The page was deleted in the app and its last content is written: never again (D7).
     * Its rename is recorded in the same statement, so a retry owes only that.
     */
    async markDeleted(
      docId: string,
      title: string,
      intent: NonNullable<ItemDocRow['renameIntent']>,
    ) {
      await db
        .update(googleItemDocs)
        .set({ state: 'deleted', title, renameIntent: intent })
        .where(eq(googleItemDocs.docId, docId));
    },

    /** Changed in Google: keeps its row and content, a new Doc carries on (D6). */
    async replaceDoc(docId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [doc] = await tx
          .update(googleItemDocs)
          .set({ state: 'replaced', renameIntent: null })
          .where(eq(googleItemDocs.docId, docId))
          .returning();
        if (doc)
          await tx
            .insert(backupEvents)
            .values({ userId: doc.userId, kind: 'doc_replaced', item: doc.item });
      });
    },

    /** Gone or in the bin: forgotten, so the next write makes a new one. */
    async dropDoc(docId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [doc] = await tx
          .delete(googleItemDocs)
          .where(eq(googleItemDocs.docId, docId))
          .returning();
        if (doc)
          await tx
            .insert(backupEvents)
            .values({ userId: doc.userId, kind: 'doc_recreated', item: doc.item });
      });
    },

    async queueItem(userId: string, item: Item): Promise<void> {
      await db.insert(googleItemWork).values({ userId, item }).onConflictDoNothing();
    },

    /** The Docs the app keeps writing in this Drive, already written at least once. */
    currentDocs: (userId: string, googleUserId: string) =>
      db
        .select()
        .from(googleItemDocs)
        .where(
          and(
            eq(googleItemDocs.userId, userId),
            eq(googleItemDocs.googleUserId, googleUserId),
            eq(googleItemDocs.state, 'current'),
            ne(googleItemDocs.revisionId, ''),
          ),
        ),

    /** The titles the user's page Docs last got, for pages the app no longer shows (D8). */
    async writtenTitles(userId: string): Promise<Map<string, string>> {
      const rows = await db
        .select({ item: googleItemDocs.item, title: googleItemDocs.title })
        .from(googleItemDocs)
        .where(and(eq(googleItemDocs.userId, userId), like(googleItemDocs.item, 'page:%')))
        .orderBy(googleItemDocs.writtenAt);
      return new Map(rows.flatMap((r) => (r.title === null ? [] : [[r.item, r.title]])));
    },

    /** Per category: how many items wait, and the newest state a Doc of it holds (D8). */
    async progress(userId: string, googleUserId: string) {
      const waiting = await db
        .select({ item: googleItemWork.item, lastError: googleItemWork.lastError })
        .from(googleItemWork)
        .where(eq(googleItemWork.userId, userId));
      const docs = await db
        .select({ item: googleItemDocs.item, coveredAt: googleItemDocs.coveredAt })
        .from(googleItemDocs)
        .where(
          and(
            eq(googleItemDocs.userId, userId),
            eq(googleItemDocs.googleUserId, googleUserId),
            ne(googleItemDocs.state, 'replaced'),
            gt(googleItemDocs.coveredAt, new Date(0)),
          ),
        );
      const categories = (['shared_pages', ...SUMMARIES] as const).map((category) => {
        const covered = docs
          .filter((d) => categoryOf(d.item) === category)
          .map((d) => d.coveredAt.getTime());
        return {
          category,
          waiting: waiting.filter((w) => categoryOf(w.item) === category).length,
          backedUpTo: covered.length ? new Date(Math.max(...covered)) : null,
        };
      });
      return {
        categories,
        failing: await failingItems(db, userId),
        storageFull: waiting.some((w) => w.lastError === 'storage_full'),
      };
    },
  };
}

/** Whether a day or an item of the user is failing now, so a run of failures starts once. */
export async function anyFailing(tx: Db | Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .execute<{ failing: boolean }>(
      sql`
    select exists (
      select 1 from google_day_work where user_id = ${userId} and attempts > 0
        and last_error in ('unreachable', 'failed')
      union all
      select 1 from google_item_work where user_id = ${userId} and attempts > 0
        and last_error in ('unreachable', 'failed')
    ) as failing`,
    )
    .then((r) => r.rows);
  return row!.failing;
}

export type TogetherStore = ReturnType<typeof createTogetherStore>;
