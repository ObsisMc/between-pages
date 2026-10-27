import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { createDiaryDoc, type CharacterRange } from '@between-pages/collab';
import type { Db } from '../db/client.ts';
import { VersionUnreadable } from '../errors.ts';
import {
  backupOutbox,
  diaries,
  diaryCharacterRanges,
  diaryClientBindings,
  diaryCommits,
  diaryGenerations,
  diaryOperations,
  diarySnapshots,
  users,
} from '../db/schema.ts';

/** Kernel ADR D9: a commit waits at most this long for the diary lock, then fails as INTERNAL. */
export const COMMIT_LOCK_TIMEOUT = '5s';
/** A full state is kept every this many versions (kernel ADR D9, "未解决的问题"). */
export const SNAPSHOT_EVERY = 100;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type DiaryRow = {
  id: string;
  ownerId: string;
  diaryDate: string;
  generationId: string;
  /** Internal; never leaves the server (kernel D2). */
  version: number;
};

export type Receipt = {
  batchId: string;
  operationIds: string[];
  generationId: string;
  seq: number;
  publicId: string;
  committedAt: Date;
};

export type CommittedBatch = {
  authorId: string;
  batchDigest: Uint8Array;
  digestAlgorithm: number;
  receipt: Receipt;
};

export type CommitPoint = {
  version: number;
  publicId: string;
  generationId: string;
  authorId: string | null;
  committedAt: Date;
};

export type NewCommit = {
  batchId: string;
  authorId: string;
  generationId: string;
  batchDigest: Uint8Array;
  digestAlgorithm: number;
  delta: Uint8Array;
  operations: { operationId: string; updateSha256: Uint8Array; writtenAt: Date }[];
  /** Characters each operation inserted, aligned with `operations`. */
  ranges: CharacterRange[][];
  claimedClientIds: number[];
  /** The state after this commit; called only when a snapshot is due. */
  state: () => Uint8Array;
};

const digest = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

function verified(bytes: Uint8Array, sha256: Uint8Array, what: string): Uint8Array {
  if (!Buffer.from(digest(bytes)).equals(sha256)) throw new VersionUnreadable(`${what} sha256`);
  return bytes;
}

const diaryColumns = {
  id: diaries.id,
  ownerId: diaries.ownerId,
  diaryDate: diaries.diaryDate,
  generationId: diaries.generationId,
  version: diaries.version,
};

const receiptColumns = {
  version: diaryCommits.version,
  batchId: diaryCommits.batchId,
  authorId: diaryCommits.authorId,
  batchDigest: diaryCommits.batchDigest,
  digestAlgorithm: diaryCommits.digestAlgorithm,
  generationId: diaryCommits.generationId,
  seq: diaryCommits.seq,
  publicId: diaryCommits.publicId,
  committedAt: diaryCommits.committedAt,
};

/** Reads inside one transaction: one snapshot when run by `read`, the lock holder's view in `withDiaryLock`. */
export class DiaryQueries {
  protected readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  async findDiary(diaryId: string): Promise<DiaryRow | null> {
    const [row] = await this.tx.select(diaryColumns).from(diaries).where(eq(diaries.id, diaryId));
    return row ?? null;
  }

  async bindings(diaryId: string): Promise<Map<number, string>> {
    const rows = await this.tx
      .select({ clientId: diaryClientBindings.clientId, userId: diaryClientBindings.userId })
      .from(diaryClientBindings)
      .where(eq(diaryClientBindings.diaryId, diaryId));
    return new Map(rows.map((row) => [row.clientId, row.userId]));
  }

  /**
   * The generation's state at `version`: the latest snapshot not after it (or the
   * generation baseline), then the deltas after that. Throws VersionUnreadable when any
   * stored part fails its sha256; never falls back to another version.
   */
  async state(diaryId: string, generationId: string, version: number): Promise<Y.Doc> {
    const [snapshot] = await this.tx
      .select({
        version: diarySnapshots.version,
        state: diarySnapshots.state,
        sha256: diarySnapshots.stateSha256,
      })
      .from(diarySnapshots)
      .innerJoin(
        diaryCommits,
        and(
          eq(diaryCommits.diaryId, diarySnapshots.diaryId),
          eq(diaryCommits.version, diarySnapshots.version),
        ),
      )
      .where(
        and(
          eq(diarySnapshots.diaryId, diaryId),
          eq(diaryCommits.generationId, generationId),
          lte(diarySnapshots.version, version),
        ),
      )
      .orderBy(desc(diarySnapshots.version))
      .limit(1);
    const doc = createDiaryDoc();
    let from = -1;
    if (snapshot) {
      Y.applyUpdate(doc, verified(snapshot.state, snapshot.sha256, `snapshot ${snapshot.version}`));
      from = snapshot.version;
    } else {
      const [generation] = await this.tx
        .select({ baseline: diaryGenerations.baseline, sha256: diaryGenerations.baselineSha256 })
        .from(diaryGenerations)
        .where(and(eq(diaryGenerations.diaryId, diaryId), eq(diaryGenerations.id, generationId)));
      if (!generation) throw new VersionUnreadable(`generation ${generationId} missing`);
      Y.applyUpdate(doc, verified(generation.baseline, generation.sha256, 'baseline'));
    }
    const deltas = await this.tx
      .select({
        version: diaryCommits.version,
        delta: diaryCommits.delta,
        sha256: diaryCommits.deltaSha256,
      })
      .from(diaryCommits)
      .where(
        and(
          eq(diaryCommits.diaryId, diaryId),
          eq(diaryCommits.generationId, generationId),
          gt(diaryCommits.version, from),
          lte(diaryCommits.version, version),
        ),
      )
      .orderBy(asc(diaryCommits.version));
    for (const row of deltas)
      Y.applyUpdate(doc, verified(row.delta, row.sha256, `delta ${row.version}`));
    return doc;
  }

  /** Committed deltas of one generation after `seq`, in seq order, each checked against its sha256. */
  async deltasAfter(diaryId: string, generationId: string, seq: number) {
    const rows = await this.tx
      .select({
        seq: diaryCommits.seq,
        publicId: diaryCommits.publicId,
        delta: diaryCommits.delta,
        sha256: diaryCommits.deltaSha256,
      })
      .from(diaryCommits)
      .where(
        and(
          eq(diaryCommits.diaryId, diaryId),
          eq(diaryCommits.generationId, generationId),
          gt(diaryCommits.seq, seq),
        ),
      )
      .orderBy(asc(diaryCommits.seq));
    return rows.map(({ sha256, ...row }) => ({
      ...row,
      delta: verified(row.delta, sha256, `delta seq ${row.seq}`),
    }));
  }

  /** The current seq of a generation; 0 while it holds only its baseline. */
  async seq(diaryId: string, generationId: string): Promise<number> {
    const [row] = await this.tx
      .select({ seq: sql<number>`coalesce(max(${diaryCommits.seq}), 0)::int` })
      .from(diaryCommits)
      .where(and(eq(diaryCommits.diaryId, diaryId), eq(diaryCommits.generationId, generationId)));
    return row!.seq;
  }

  async batch(diaryId: string, batchId: string): Promise<CommittedBatch | null> {
    const [row] = await this.tx
      .select(receiptColumns)
      .from(diaryCommits)
      .where(and(eq(diaryCommits.diaryId, diaryId), eq(diaryCommits.batchId, batchId)));
    if (!row) return null;
    return {
      authorId: row.authorId!,
      batchDigest: row.batchDigest!,
      digestAlgorithm: row.digestAlgorithm!,
      receipt: await this.receiptOf(diaryId, row),
    };
  }

  /** The receipt of the batch `authorId` committed with this operation, if any. */
  async receiptByOperation(
    diaryId: string,
    authorId: string,
    operationId: string,
  ): Promise<Receipt | null> {
    const [row] = await this.tx
      .select(receiptColumns)
      .from(diaryOperations)
      .innerJoin(
        diaryCommits,
        and(
          eq(diaryCommits.diaryId, diaryOperations.diaryId),
          eq(diaryCommits.version, diaryOperations.version),
        ),
      )
      .where(
        and(
          eq(diaryOperations.authorId, authorId),
          eq(diaryOperations.diaryId, diaryId),
          eq(diaryOperations.operationId, operationId),
        ),
      );
    return row ? this.receiptOf(diaryId, row) : null;
  }

  /** Which of these operation IDs `authorId` already committed in this diary. */
  async committedOperations(
    diaryId: string,
    authorId: string,
    operationIds: string[],
  ): Promise<string[]> {
    const rows = await this.tx
      .select({ operationId: diaryOperations.operationId })
      .from(diaryOperations)
      .where(
        and(
          eq(diaryOperations.authorId, authorId),
          eq(diaryOperations.diaryId, diaryId),
          inArray(diaryOperations.operationId, operationIds),
        ),
      );
    return rows.map((row) => row.operationId);
  }

  /** Every commit of the diary in version order, without content; history is computed from it. */
  async timeline(diaryId: string): Promise<CommitPoint[]> {
    return this.tx
      .select({
        version: diaryCommits.version,
        publicId: diaryCommits.publicId,
        generationId: diaryCommits.generationId,
        authorId: diaryCommits.authorId,
        committedAt: diaryCommits.committedAt,
      })
      .from(diaryCommits)
      .where(eq(diaryCommits.diaryId, diaryId))
      .orderBy(asc(diaryCommits.version));
  }

  private async receiptOf(
    diaryId: string,
    row: {
      version: number;
      batchId: string | null;
      generationId: string;
      seq: number;
      publicId: string;
      committedAt: Date;
    },
  ): Promise<Receipt> {
    const operations = await this.tx
      .select({ operationId: diaryOperations.operationId })
      .from(diaryOperations)
      .where(and(eq(diaryOperations.diaryId, diaryId), eq(diaryOperations.version, row.version)))
      .orderBy(asc(diaryOperations.batchIndex));
    return {
      batchId: row.batchId!,
      operationIds: operations.map((op) => op.operationId),
      generationId: row.generationId,
      seq: row.seq,
      publicId: row.publicId,
      committedAt: row.committedAt,
    };
  }
}

/** Reads and writes while holding the diary row lock; the only way to change a diary's commits. */
export class LockedDiary extends DiaryQueries {
  readonly diary: DiaryRow;
  constructor(tx: Tx, diary: DiaryRow) {
    super(tx);
    this.diary = diary;
  }

  /**
   * Writes one batch as the next version: the commit row with its re-encoded delta, one
   * row per operation, the inserted character ranges, the newly claimed clientIDs and a
   * snapshot when due. Everything lands or nothing does, with the caller's other writes in
   * this transaction (invariants 6, 8).
   */
  async insertCommit(commit: NewCommit): Promise<{ version: number; receipt: Receipt }> {
    const { id: diaryId } = this.diary;
    const version = this.diary.version + 1;
    const seq = (await this.seq(diaryId, commit.generationId)) + 1;
    const [row] = await this.tx
      .insert(diaryCommits)
      .values({
        diaryId,
        version,
        publicId: randomUUID(),
        generationId: commit.generationId,
        seq,
        batchId: commit.batchId,
        authorId: commit.authorId,
        batchDigest: commit.batchDigest,
        digestAlgorithm: commit.digestAlgorithm,
        delta: commit.delta,
        deltaSha256: digest(commit.delta),
      })
      .returning({ publicId: diaryCommits.publicId, committedAt: diaryCommits.committedAt });
    await this.tx.update(diaries).set({ version }).where(eq(diaries.id, diaryId));
    await this.tx.insert(diaryOperations).values(
      commit.operations.map((op, batchIndex) => ({
        authorId: commit.authorId,
        diaryId,
        operationId: op.operationId,
        version,
        batchIndex,
        updateSha256: op.updateSha256,
        writtenAt: op.writtenAt,
      })),
    );
    if (commit.claimedClientIds.length)
      await this.tx.insert(diaryClientBindings).values(
        commit.claimedClientIds.map((clientId) => ({
          diaryId,
          clientId,
          userId: commit.authorId,
        })),
      );
    const ranges = commit.ranges.flatMap((perOperation, index) =>
      perOperation.map((range) => ({
        diaryId,
        clientId: range.client,
        clockStart: range.clock,
        clockEnd: range.clock + range.length,
        operationId: commit.operations[index]!.operationId,
      })),
    );
    if (ranges.length) await this.tx.insert(diaryCharacterRanges).values(ranges);
    if (version % SNAPSHOT_EVERY === 0) {
      const state = commit.state();
      await this.tx
        .insert(diarySnapshots)
        .values({ diaryId, version, state, stateSha256: digest(state) });
    }
    return {
      version,
      receipt: {
        batchId: commit.batchId,
        operationIds: commit.operations.map((op) => op.operationId),
        generationId: commit.generationId,
        seq,
        publicId: row!.publicId,
        committedAt: row!.committedAt,
      },
    };
  }

  async insertBackupTasks(version: number, targets: readonly 'personal'[]): Promise<void> {
    await this.tx
      .insert(backupOutbox)
      .values(targets.map((target) => ({ diaryId: this.diary.id, version, target })));
  }
}

export function createStore(db: Db) {
  return {
    /** Runs `read` in one read-only snapshot without locks (kernel D9 lock table). */
    read<T>(read: (queries: DiaryQueries) => Promise<T>): Promise<T> {
      return db.transaction((tx) => read(new DiaryQueries(tx)), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    },

    /**
     * Runs `work` holding the diary row `FOR UPDATE`, the only lock a commit takes (kernel
     * D9): it never waits on users, spaces or periods, so it cannot deadlock with flows
     * that lock those first. Waiting longer than COMMIT_LOCK_TIMEOUT throws. `null` when
     * the diary does not exist. A throw rolls everything back.
     */
    withDiaryLock<T>(
      diaryId: string,
      work: (locked: LockedDiary) => Promise<T>,
    ): Promise<T | null> {
      return db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${COMMIT_LOCK_TIMEOUT}'`));
        const [diary] = await tx
          .select(diaryColumns)
          .from(diaries)
          .where(eq(diaries.id, diaryId))
          .for('update');
        return diary ? work(new LockedDiary(tx, diary)) : null;
      });
    },

    /**
     * The owner's diary for `diaryDate`, created with its first generation if missing.
     * Locks the owner's users row FOR KEY SHARE before inserting (kernel D9), so a
     * concurrent sharing change that locks it FOR UPDATE sees this diary on one side of
     * its transaction; the (owner, date) unique key makes concurrent creators converge on
     * one row.
     */
    async openPersonal(input: {
      ownerId: string;
      diaryDate: string;
      timezone: string;
      baseline: Uint8Array;
    }): Promise<{ created: boolean; diaryId: string }> {
      return db.transaction(async (tx) => {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.ownerId))
          .for('key share');
        const diaryId = randomUUID();
        const generationId = randomUUID();
        const inserted = await tx
          .insert(diaries)
          .values({
            id: diaryId,
            ownerId: input.ownerId,
            diaryDate: input.diaryDate,
            createdTimezone: input.timezone,
            generationId,
          })
          .onConflictDoNothing({ target: [diaries.ownerId, diaries.diaryDate] })
          .returning({ id: diaries.id });
        if (inserted.length) {
          await tx.insert(diaryGenerations).values({
            id: generationId,
            diaryId,
            sourceVersion: 0,
            baseline: input.baseline,
            baselineSha256: digest(input.baseline),
          });
          return { created: true, diaryId };
        }
        const [existing] = await tx
          .select({ id: diaries.id })
          .from(diaries)
          .where(and(eq(diaries.ownerId, input.ownerId), eq(diaries.diaryDate, input.diaryDate)));
        return { created: false, diaryId: existing!.id };
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
