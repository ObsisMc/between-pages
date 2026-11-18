import { and, count, desc, eq, gt, inArray, lte, max, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  backupEvents,
  googleConnections,
  googleDayDocs,
  googleDayWork,
  googleFolders,
  spaces,
  users,
} from '../db/schema.ts';
import type { ConnectionRow } from './backup.ts';
import type { Tx } from './store.ts';
import { anyFailing } from './together.ts';

// The day-Doc side of the Google copy (server-backup-and-google-docs D5–D9): the queue of
// days to write per person, the Docs and folders written into each Drive, and what the
// backup page and day page report. Every row names the Google account it belongs to; a
// different account starts new folders and Docs. Nothing here reads or decrypts a token.

export type WorkRow = typeof googleDayWork.$inferSelect;
/** Why a day is still waiting after an attempt; shown on the backup and day pages (D9). */
export type WorkFailure = 'unreachable' | 'failed' | 'storage_full';
export type DocRow = typeof googleDayDocs.$inferSelect;
export type Covers = DocRow['covers'];

/** How the worker leaves one day of work it held. */
export type WorkOutcome = {
  /** Written, or nothing to write: the day leaves the queue. */
  done(): Promise<void>;
  /** Look again at `at`; a failure counts toward the backoff and is shown on the pages. */
  later(at: Date, failure: WorkFailure | null): Promise<void>;
};

const BATCH = 200;

/** The user's days whose last attempt failed for a reason other than a full Drive. */
const failingDays = (tx: Db | Tx, userId: string) =>
  tx
    .select({ diaryDate: googleDayWork.diaryDate, failure: googleDayWork.lastError })
    .from(googleDayWork)
    .where(
      and(
        eq(googleDayWork.userId, userId),
        gt(googleDayWork.attempts, 0),
        inArray(googleDayWork.lastError, ['unreachable', 'failed']),
      ),
    )
    .orderBy(desc(googleDayWork.diaryDate)) as Promise<
    { diaryDate: string; failure: 'unreachable' | 'failed' }[]
  >;

export function createCopyStore(db: Db) {
  /** The app's folders in this Drive by path (`Between Pages`, `Between Pages/2026`, ...). */
  const folders = async (userId: string, googleUserId: string) =>
    new Map(
      (
        await db
          .select({ path: googleFolders.path, folderId: googleFolders.folderId })
          .from(googleFolders)
          .where(
            and(eq(googleFolders.userId, userId), eq(googleFolders.googleUserId, googleUserId)),
          )
      ).map((row) => [row.path, row.folderId]),
    );

  return {
    /**
     * Turns pending outbox tasks into days of work (D7, technical design step 1): a personal
     * task is the owner's day, a space task the epoch recipient's. Only people with a Drive
     * connection get work; connecting queues every visible day anyway. Marks the tasks done
     * in the same transaction. `onlyFor` limits it to tasks of these people ("现在备份" takes
     * only the caller's). Returns how many tasks it took.
     */
    async intake(onlyFor?: readonly string[]): Promise<number> {
      const target = sql`case o.target when 'personal' then d.owner_id else e.recipient_id end`;
      const only = onlyFor
        ? sql`and ${target} in (${sql.join(
            onlyFor.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``;
      const result = await db.execute(sql`
        with picked as (
          select o.id, d.diary_date, ${target} as user_id
          from backup_outbox o
          join diaries d on d.id = o.diary_id
          left join share_epochs e on e.id = o.epoch_id
          where o.status = 'pending' ${only}
          order by o.created_at
          limit ${BATCH}
          for update of o skip locked
        ), queued as (
          insert into google_day_work (user_id, diary_date)
          select distinct p.user_id, p.diary_date from picked p
          join google_connections c on c.user_id = p.user_id and c.status <> 'revoking'
          on conflict do nothing
        )
        update backup_outbox set status = 'done', processed_at = now()
        where id in (select id from picked)`);
      return result.rowCount ?? 0;
    },

    /** "现在备份": every waiting day of the user is due now, without waiting for its history point. */
    async runNow(userId: string, now: Date): Promise<void> {
      await db
        .update(googleDayWork)
        .set({ now: true, readyAt: now })
        .where(eq(googleDayWork.userId, userId));
    },

    /**
     * The next due day of an active connection whose token this key opens, locked for this
     * worker until `fn` returns. The work row stays locked while Google is called, so a new
     * commit's intake waits and then queues the day again.
     */
    withDueWork<T>(
      now: Date,
      keyId: string,
      fn: (work: WorkRow, connection: ConnectionRow, outcome: WorkOutcome) => Promise<T>,
    ): Promise<T | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ work: googleDayWork, connection: googleConnections })
          .from(googleDayWork)
          .innerJoin(googleConnections, eq(googleConnections.userId, googleDayWork.userId))
          .where(
            and(
              eq(googleConnections.status, 'active'),
              eq(googleConnections.keyId, keyId),
              lte(googleDayWork.readyAt, now),
            ),
          )
          .orderBy(googleDayWork.readyAt)
          .limit(1)
          .for('update', { of: googleDayWork, skipLocked: true });
        if (!row) return null;
        const { work, connection } = row;
        const key = and(
          eq(googleDayWork.userId, work.userId),
          eq(googleDayWork.diaryDate, work.diaryDate),
        );
        return fn(work, connection, {
          done: async () => {
            await tx.delete(googleDayWork).where(key);
          },
          later: async (at, failure) => {
            // The first failure of a run, days and `Together` items together, marks when the run
            // began: after a day of it the home page shows a banner (D9, Ray 2026-10-29).
            if (failure && failure !== 'storage_full' && !(await anyFailing(tx, work.userId)))
              await tx
                .insert(backupEvents)
                .values({ userId: work.userId, kind: 'copy_failing', diaryDate: work.diaryDate });
            await tx
              .update(googleDayWork)
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

    /** The grant stopped working: the page asks to reconnect; queued days wait for it (D9). */
    async needsReconnect(userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const changed = await tx
          .update(googleConnections)
          .set({ status: 'reconnect' })
          .where(and(eq(googleConnections.userId, userId), eq(googleConnections.status, 'active')))
          .returning({ userId: googleConnections.userId });
        if (changed.length)
          await tx.insert(backupEvents).values({ userId, kind: 'reconnect_needed' });
      });
    },

    /** Why this day is still waiting after an attempt, if it failed (D9). */
    dayFailure: async (userId: string, diaryDate: string): Promise<WorkFailure | null> => {
      const [row] = await db
        .select({ attempts: googleDayWork.attempts, failure: googleDayWork.lastError })
        .from(googleDayWork)
        .where(and(eq(googleDayWork.userId, userId), eq(googleDayWork.diaryDate, diaryDate)));
      return row && row.attempts > 0 ? (row.failure as WorkFailure | null) : null;
    },

    /** The daily check could not read this Drive; it tries again the next day (D8). */
    async checkFailed(userId: string): Promise<void> {
      await db.insert(backupEvents).values({ userId, kind: 'check_failed' });
    },

    /** Drive is full: one problem entry per episode; the home banner shows while it lasts (D9). */
    async storageFull(userId: string, diaryDate: string): Promise<void> {
      await db.insert(backupEvents).values({ userId, kind: 'storage_full', diaryDate });
    },

    /** The user's display name and their partner's, if they ever had one (the pair is fixed). */
    async people(userId: string) {
      const [own] = await db
        .select({ id: users.id, name: users.displayName })
        .from(users)
        .where(eq(users.id, userId));
      const [space] = await db
        .select({ low: spaces.userLow, high: spaces.userHigh })
        .from(spaces)
        .where(or(eq(spaces.userLow, userId), eq(spaces.userHigh, userId)))
        .limit(1);
      const partnerId = space && (space.low === userId ? space.high : space.low);
      const [partner] = partnerId
        ? await db
            .select({ id: users.id, name: users.displayName })
            .from(users)
            .where(eq(users.id, partnerId))
        : [];
      return { viewer: own!, partner: partner ?? null };
    },

    folders,

    async saveFolder(userId: string, googleUserId: string, path: string, folderId: string) {
      await db
        .insert(googleFolders)
        .values({ userId, googleUserId, path, folderId })
        .onConflictDoUpdate({
          target: [googleFolders.userId, googleFolders.googleUserId, googleFolders.path],
          set: { folderId },
        });
    },

    currentDoc: async (userId: string, googleUserId: string, diaryDate: string) =>
      (
        await db
          .select()
          .from(googleDayDocs)
          .where(
            and(
              eq(googleDayDocs.userId, userId),
              eq(googleDayDocs.googleUserId, googleUserId),
              eq(googleDayDocs.diaryDate, diaryDate),
              eq(googleDayDocs.state, 'current'),
            ),
          )
      )[0] ?? null,

    /**
     * Records a Doc the moment Google created it, before its first write, in its own
     * transaction: a retry after a crash finds it instead of creating a second one
     * (invariant 6). Its empty revision means "accept whatever revision Google reports".
     */
    async createdDoc(row: {
      docId: string;
      userId: string;
      googleUserId: string;
      diaryDate: string;
    }) {
      await db.insert(googleDayDocs).values({
        ...row,
        state: 'current',
        revisionId: '',
        contentSha256: new Uint8Array(),
        covers: {},
        coveredAt: new Date(0),
      });
    },

    async recordWrite(
      docId: string,
      write: { revisionId: string; contentSha256: Uint8Array; covers: Covers; coveredAt: Date },
    ) {
      await db
        .update(googleDayDocs)
        .set({ ...write, writtenAt: sql`now()` })
        .where(eq(googleDayDocs.docId, docId));
    },

    /** The Doc was changed in Google: it keeps its row and content, a new Doc carries on (D8). */
    async replaceDoc(docId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [doc] = await tx
          .update(googleDayDocs)
          .set({ state: 'replaced' })
          .where(eq(googleDayDocs.docId, docId))
          .returning();
        if (doc)
          await tx
            .insert(backupEvents)
            .values({ userId: doc.userId, kind: 'doc_replaced', diaryDate: doc.diaryDate });
      });
    },

    /** The Doc is gone or in the bin: forgotten, so the next write makes a new one (D8). */
    async dropDoc(docId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [doc] = await tx
          .delete(googleDayDocs)
          .where(eq(googleDayDocs.docId, docId))
          .returning();
        if (doc)
          await tx
            .insert(backupEvents)
            .values({ userId: doc.userId, kind: 'doc_recreated', diaryDate: doc.diaryDate });
      });
    },

    /** Queues one day of one person, e.g. after the daily check set its Doc aside. */
    async queueDay(userId: string, diaryDate: string): Promise<void> {
      await db.insert(googleDayWork).values({ userId, diaryDate }).onConflictDoNothing();
    },

    /** Every working connection whose token this key opens, for the daily check. */
    activeConnections: (keyId: string) =>
      db
        .select()
        .from(googleConnections)
        .where(and(eq(googleConnections.status, 'active'), eq(googleConnections.keyId, keyId))),

    /** The day Docs the app keeps writing in this Drive, already written at least once. */
    currentDocs: (userId: string, googleUserId: string) =>
      db
        .select()
        .from(googleDayDocs)
        .where(
          and(
            eq(googleDayDocs.userId, userId),
            eq(googleDayDocs.googleUserId, googleUserId),
            eq(googleDayDocs.state, 'current'),
            ne(googleDayDocs.revisionId, ''),
          ),
        ),

    /** The content is already in the Doc; only what it covers moved on (D7). */
    async recordCovers(docId: string, covers: Covers, coveredAt: Date) {
      await db
        .update(googleDayDocs)
        .set({ covers, coveredAt })
        .where(eq(googleDayDocs.docId, docId));
    },

    /** The backup page's progress for the connected account (D9). */
    async progress(userId: string, googleUserId: string) {
      const [work] = await db
        .select({
          waiting: count(),
          storageFull:
            sql<number>`count(*) filter (where ${googleDayWork.lastError} = 'storage_full')`.mapWith(
              Number,
            ),
        })
        .from(googleDayWork)
        .where(eq(googleDayWork.userId, userId));
      const [docs] = await db
        .select({ backedUpTo: max(googleDayDocs.coveredAt) })
        .from(googleDayDocs)
        .where(
          and(
            eq(googleDayDocs.userId, userId),
            eq(googleDayDocs.googleUserId, googleUserId),
            eq(googleDayDocs.state, 'current'),
            gt(googleDayDocs.coveredAt, new Date(0)),
          ),
        );
      const root = (await folders(userId, googleUserId)).get(ROOT_FOLDER) ?? null;
      const failing = await failingDays(db, userId);
      const [run] = (await anyFailing(db, userId))
        ? await db
            .select({ at: backupEvents.at })
            .from(backupEvents)
            .where(and(eq(backupEvents.userId, userId), eq(backupEvents.kind, 'copy_failing')))
            .orderBy(desc(backupEvents.at))
            .limit(1)
        : [];
      return {
        waitingDays: work!.waiting,
        failing,
        /** When the current run of failures began; null while nothing fails. */
        failingSince: run?.at ?? null,
        storageFull: work!.storageFull > 0,
        backedUpTo: docs?.backedUpTo ?? null,
        rootFolderId: root,
      };
    },
  };
}

export const ROOT_FOLDER = 'Between Pages';

export type CopyStore = ReturnType<typeof createCopyStore>;
