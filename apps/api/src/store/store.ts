import { createHash, randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import * as Y from 'yjs';
import { createDiaryDoc, type CharacterRange } from '@between-pages/collab';
import type { DateSelection } from '@between-pages/contracts';
import type { Db } from '../db/client.ts';
import { EpochQueries, LockedBoundaries } from './boundaries.ts';
import { coverage, coverageIn, type ClockRange } from './reading.ts';
import { VersionUnreadable } from '../errors.ts';
import {
  backupOutbox,
  bindingPeriods,
  diaries,
  documents,
  diaryCharacterRanges,
  diaryClientBindings,
  diaryCommits,
  diaryGenerations,
  diaryOperations,
  diarySnapshots,
  sharedPages,
  spaceActions,
  spaceReads,
  spaces,
  users,
} from '../db/schema.ts';

/** Kernel ADR D9: a commit waits at most this long for the diary lock, then fails as INTERNAL. */
export const COMMIT_LOCK_TIMEOUT = '5s';
/** A full state is kept every this many versions (kernel ADR D9, "未解决的问题"). */
export const SNAPSHOT_EVERY = 100;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
  /** The epoch live when it committed; null for a private commit. */
  epochId: string | null;
  authorId: string | null;
  committedAt: Date;
};

export type NewCommit = {
  batchId: string;
  authorId: string;
  generationId: string;
  /** The diary's live epoch at commit time, null when private (kernel D10). */
  epochId: string | null;
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
  generationId: documents.generationId,
  version: documents.version,
};
const ofDiary = eq(documents.id, diaries.id);

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

/** Reads inside one transaction: one snapshot when run by `read`, the lock holder's view in `withDocumentLock`. */
export class DiaryQueries {
  protected readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  /** Share epochs and sharing context, in this same transaction. */
  get epochs(): EpochQueries {
    return new EpochQueries(this.tx);
  }

  async findDiary(diaryId: string): Promise<DiaryRow | null> {
    const [row] = await this.tx
      .select(diaryColumns)
      .from(diaries)
      .innerJoin(documents, ofDiary)
      .where(eq(diaries.id, diaryId));
    return row ?? null;
  }

  /**
   * The owner's diaries dated before `before` (all when null), newest date first, at most
   * `limit`; `updatedAt` is the last written batch, or the creation time before any. An
   * opening's baseline commit writes no text, so it does not count.
   */
  ownedDiaries(
    ownerId: string,
    before: string | null,
    limit: number,
  ): Promise<(DiaryRow & { updatedAt: Date })[]> {
    return this.owned(
      ownerId,
      before === null ? undefined : lt(diaries.diaryDate, before),
      desc(diaries.diaryDate),
      limit,
    );
  }

  /** As `ownedDiaries`, dated after `after`, nearest date first. */
  ownedDiariesAfter(
    ownerId: string,
    after: string,
    limit: number,
  ): Promise<(DiaryRow & { updatedAt: Date })[]> {
    return this.owned(ownerId, gt(diaries.diaryDate, after), asc(diaries.diaryDate), limit);
  }

  private owned(ownerId: string, dated: SQL | undefined, order: SQL, limit: number) {
    const lastCommit = sql`(select ${diaryCommits.committedAt} from ${diaryCommits}
      where ${diaryCommits.diaryId} = ${diaries.id} and ${isNotNull(diaryCommits.batchId)}
      order by ${diaryCommits.version} desc limit 1)`;
    return this.tx
      .select({
        ...diaryColumns,
        updatedAt: sql<Date>`coalesce(${lastCommit}, ${diaries.createdAt})`.mapWith(
          diaries.createdAt,
        ),
      })
      .from(diaries)
      .innerJoin(documents, ofDiary)
      .where(and(eq(diaries.ownerId, ownerId), dated))
      .orderBy(order)
      .limit(limit);
  }

  /**
   * The owner's diaries someone else has an editor instance in: only these can hold text
   * that is unread for the owner (unread-and-day-page D2).
   */
  async diariesWithOtherWriters(ownerId: string): Promise<Set<string>> {
    const rows = await this.tx
      .selectDistinct({ diaryId: diaryClientBindings.diaryId })
      .from(diaryClientBindings)
      .innerJoin(diaries, eq(diaries.id, diaryClientBindings.diaryId))
      .where(and(eq(diaries.ownerId, ownerId), ne(diaryClientBindings.userId, ownerId)));
    return new Set(rows.map((row) => row.diaryId));
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

  /**
   * Committed deltas of one generation after `seq`, in seq order, each checked against its
   * sha256; only those of `epochId` when given (kernel D10 recipient rule).
   */
  async deltasAfter(diaryId: string, generationId: string, seq: number, epochId?: string) {
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
          epochId === undefined ? undefined : eq(diaryCommits.epochId, epochId),
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

  /** The two people of a shared page's space, deleted or not; null for any other document. */
  async pageParticipants(documentId: string): Promise<[string, string] | null> {
    const [row] = await this.tx
      .select({ low: spaces.userLow, high: spaces.userHigh })
      .from(sharedPages)
      .innerJoin(spaces, eq(spaces.id, sharedPages.spaceId))
      .where(eq(sharedPages.id, documentId));
    return row ? [row.low, row.high] : null;
  }

  /** The diaries of `ids` that exist, by ID. */
  async findDiaries(ids: readonly string[]): Promise<Map<string, DiaryRow>> {
    const rows = await this.tx
      .select(diaryColumns)
      .from(diaries)
      .innerJoin(documents, ofDiary)
      .where(inArray(diaries.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** As `timeline`, for many diaries in one query; a diary with no commit is absent. */
  async timelines(diaryIds: readonly string[]): Promise<Map<string, CommitPoint[]>> {
    const rows = await this.tx
      .select({
        diaryId: diaryCommits.diaryId,
        version: diaryCommits.version,
        publicId: diaryCommits.publicId,
        generationId: diaryCommits.generationId,
        epochId: diaryCommits.epochId,
        authorId: diaryCommits.authorId,
        committedAt: diaryCommits.committedAt,
      })
      .from(diaryCommits)
      .where(inArray(diaryCommits.diaryId, [...diaryIds]))
      .orderBy(asc(diaryCommits.diaryId), asc(diaryCommits.version));
    const out = new Map<string, CommitPoint[]>();
    for (const { diaryId, ...point } of rows) {
      const timeline = out.get(diaryId);
      if (timeline) timeline.push(point);
      else out.set(diaryId, [point]);
    }
    return out;
  }

  /** `userId`'s coverage of each of `diaryIds` in this snapshot, absent where none. */
  readRangesIn(userId: string, diaryIds: readonly string[]): Promise<Map<string, ClockRange[]>> {
    return coverageIn(this.tx, userId, diaryIds);
  }

  /** Every commit of the diary in version order, without content; history is computed from it. */
  async timeline(diaryId: string): Promise<CommitPoint[]> {
    return this.tx
      .select({
        version: diaryCommits.version,
        publicId: diaryCommits.publicId,
        generationId: diaryCommits.generationId,
        epochId: diaryCommits.epochId,
        authorId: diaryCommits.authorId,
        committedAt: diaryCommits.committedAt,
      })
      .from(diaryCommits)
      .where(eq(diaryCommits.diaryId, diaryId))
      .orderBy(asc(diaryCommits.version));
  }

  /** `userId`'s own read coverage of the diary in this snapshot (kernel D15). */
  readRanges(userId: string, diaryId: string): Promise<ClockRange[]> {
    return coverage(this.tx, userId, diaryId);
  }

  /**
   * The characters inserted by commits after `version`, as clock ranges, whatever became
   * of them since; what a history point does not yet hold (unread-and-day-page D2).
   */
  async insertedAfter(diaryId: string, version: number): Promise<ClockRange[]> {
    return this.tx
      .select({
        clientId: diaryCharacterRanges.clientId,
        from: diaryCharacterRanges.clockStart,
        to: diaryCharacterRanges.clockEnd,
      })
      .from(diaryCharacterRanges)
      .innerJoin(
        diaryClientBindings,
        and(
          eq(diaryClientBindings.diaryId, diaryCharacterRanges.diaryId),
          eq(diaryClientBindings.clientId, diaryCharacterRanges.clientId),
        ),
      )
      .innerJoin(
        diaryOperations,
        and(
          eq(diaryOperations.diaryId, diaryCharacterRanges.diaryId),
          eq(diaryOperations.authorId, diaryClientBindings.userId),
          eq(diaryOperations.operationId, diaryCharacterRanges.operationId),
        ),
      )
      .where(and(eq(diaryCharacterRanges.diaryId, diaryId), gt(diaryOperations.version, version)));
  }

  /**
   * The operation that inserted the character `(clientId, clock)`, with its author (the
   * clientID's binding) and both clocks (kernel D15); null when none did.
   */
  async characterOrigin(
    diaryId: string,
    clientId: number,
    clock: number,
  ): Promise<{ authorId: string; writtenAt: Date; receivedAt: Date } | null> {
    const [row] = await this.tx
      .select({
        authorId: diaryOperations.authorId,
        writtenAt: diaryOperations.writtenAt,
        receivedAt: diaryOperations.receivedAt,
      })
      .from(diaryCharacterRanges)
      .innerJoin(
        diaryClientBindings,
        and(
          eq(diaryClientBindings.diaryId, diaryCharacterRanges.diaryId),
          eq(diaryClientBindings.clientId, diaryCharacterRanges.clientId),
        ),
      )
      .innerJoin(
        diaryOperations,
        and(
          eq(diaryOperations.diaryId, diaryCharacterRanges.diaryId),
          eq(diaryOperations.authorId, diaryClientBindings.userId),
          eq(diaryOperations.operationId, diaryCharacterRanges.operationId),
        ),
      )
      .where(
        and(
          eq(diaryCharacterRanges.diaryId, diaryId),
          eq(diaryCharacterRanges.clientId, clientId),
          lte(diaryCharacterRanges.clockStart, clock),
          gt(diaryCharacterRanges.clockEnd, clock),
        ),
      );
    return row ?? null;
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

/** A shared page as its commit sees it, read under the locks (shared-pages D7). */
export type LockedPage = {
  spaceId: string;
  participants: [string, string];
  /** The space has an open period, held FOR SHARE until commit. */
  open: boolean;
  deleted: boolean;
};

/** The locked document; `ownerId` is null and `page` set for a shared page. */
export type DocumentRow = {
  id: string;
  ownerId: string | null;
  generationId: string;
  version: number;
  page: LockedPage | null;
};

/** Reads and writes while holding the document lock; the only way to change a document's commits. */
export class LockedDocument extends DiaryQueries {
  readonly document: DocumentRow;
  constructor(tx: Tx, document: DocumentRow) {
    super(tx);
    this.document = document;
  }

  /**
   * Writes one batch as the next version: the commit row with its re-encoded delta, one
   * row per operation, the inserted character ranges, the newly claimed clientIDs and a
   * snapshot when due. Everything lands or nothing does, with the caller's other writes in
   * this transaction (invariants 6, 8).
   */
  async insertCommit(commit: NewCommit): Promise<{ version: number; receipt: Receipt }> {
    const { id: diaryId } = this.document;
    const version = this.document.version + 1;
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
        epochId: commit.epochId,
      })
      .returning({ publicId: diaryCommits.publicId, committedAt: diaryCommits.committedAt });
    await this.tx.update(documents).set({ version }).where(eq(documents.id, diaryId));
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

  /**
   * After a commit of a shared page: raises the page's update time and, when the partner
   * has seen the writer's last "wrote" or there is none, appends a new one, so a page's
   * history grows by one row per round of unread however much is written (shared-pages D5).
   */
  async notePageWritten(page: LockedPage, writer: string, batchId: string, digest: Uint8Array) {
    const { id } = this.document;
    await this.tx.update(sharedPages).set({ updatedAt: new Date() }).where(eq(sharedPages.id, id));
    const partner = page.participants.find((p) => p !== writer)!;
    const [last] = await this.tx
      .select({ seq: spaceActions.seq })
      .from(spaceActions)
      .where(
        and(
          eq(spaceActions.recordType, 'shared_page'),
          eq(spaceActions.recordId, id),
          eq(spaceActions.actorId, writer),
          eq(spaceActions.kind, 'wrote'),
        ),
      )
      .orderBy(desc(spaceActions.seq))
      .limit(1);
    if (last) {
      const [seen] = await this.tx
        .select({ seq: spaceReads.seq })
        .from(spaceReads)
        .where(
          and(
            eq(spaceReads.userId, partner),
            eq(spaceReads.recordType, 'shared_page'),
            eq(spaceReads.recordId, id),
          ),
        );
      if (!seen || seen.seq < last.seq) return;
    }
    await this.tx.insert(spaceActions).values({
      spaceId: page.spaceId,
      recordType: 'shared_page',
      recordId: id,
      kind: 'wrote',
      actorId: writer,
      requestId: batchId,
      requestDigest: Buffer.from(digest).toString('base64url'),
    });
  }

  /** The owner's personal task, and the space task while an epoch is live (kernel D16). */
  async insertBackupTasks(version: number, live: { spaceId: string; epochId: string } | null) {
    await this.tx
      .insert(backupOutbox)
      .values([
        { diaryId: this.document.id, version, target: 'personal' as const },
        ...(live
          ? [{ diaryId: this.document.id, version, target: 'space' as const, ...live }]
          : []),
      ]);
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
     * Runs `work` holding the document's row `FOR UPDATE`. For a diary it is the only lock a
     * commit takes (kernel D9): it never waits on users, spaces or periods, so it cannot
     * deadlock with flows that lock those first. For a shared page the open period comes
     * first, FOR SHARE: the one lock order of shared-pages D7, also unbinding's, because a
     * waiting unbind queues a later FOR SHARE behind it and the reverse order could deadlock.
     * Waiting longer than COMMIT_LOCK_TIMEOUT throws. `null` when the document does not
     * exist. A throw rolls everything back.
     */
    withDocumentLock<T>(
      documentId: string,
      work: (locked: LockedDocument) => Promise<T>,
    ): Promise<T | null> {
      return db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${COMMIT_LOCK_TIMEOUT}'`));
        const [space] = await tx
          .select({ id: sharedPages.spaceId, low: spaces.userLow, high: spaces.userHigh })
          .from(sharedPages)
          .innerJoin(spaces, eq(spaces.id, sharedPages.spaceId))
          .where(eq(sharedPages.id, documentId));
        const [period] = space
          ? await tx
              .select({ id: bindingPeriods.id })
              .from(bindingPeriods)
              .where(and(eq(bindingPeriods.spaceId, space.id), isNull(bindingPeriods.endedAt)))
              .for('share')
          : [];
        const [document] = await tx
          .select({
            id: documents.id,
            ownerId: diaries.ownerId,
            generationId: documents.generationId,
            version: documents.version,
          })
          .from(documents)
          .leftJoin(diaries, ofDiary)
          .where(eq(documents.id, documentId))
          .for('update', { of: documents });
        if (!document) return null;
        // Its own statement, so it sees a deletion this lock waited for.
        const [state] = space
          ? await tx
              .select({ deletedAt: sharedPages.deletedAt })
              .from(sharedPages)
              .where(eq(sharedPages.id, documentId))
          : [];
        const page: LockedPage | null = space
          ? {
              spaceId: space.id,
              participants: [space.low, space.high],
              open: period !== undefined,
              deleted: state!.deletedAt !== null,
            }
          : null;
        return work(new LockedDocument(tx, { ...document, page }));
      });
    },

    /**
     * The owner's diary for `diaryDate`, created with its first generation if missing.
     * Locks the owner's users row FOR KEY SHARE before inserting (kernel D9), so a
     * concurrent sharing change that locks it FOR UPDATE sees this diary on one side of
     * its transaction; the (owner, date) unique key makes concurrent creators converge on
     * one row. A new diary whose date `sharedOn` the selection the owner confirmed for
     * their open binding opens to the partner in the same transaction (spaces-and-invitations
     * D3: a selected date shares diaries written later); without `sharedOn` it stays private.
     */
    async openPersonal(input: {
      ownerId: string;
      diaryDate: string;
      timezone: string;
      baseline: Uint8Array;
      sharedOn?: (selection: DateSelection, diaryDate: string) => boolean;
    }): Promise<{ created: boolean; diaryId: string }> {
      return db.transaction(async (tx) => {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.ownerId))
          .for('key share');
        const diaryId = randomUUID();
        const generationId = randomUUID();
        await tx.insert(documents).values({ id: diaryId, generationId });
        const inserted = await tx
          .insert(diaries)
          .values({
            id: diaryId,
            ownerId: input.ownerId,
            diaryDate: input.diaryDate,
            createdTimezone: input.timezone,
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
          const context =
            input.sharedOn && (await new EpochQueries(tx).sharingContext(input.ownerId));
          if (context && input.sharedOn!(context.selection, input.diaryDate))
            await new LockedBoundaries(tx).open(
              [
                {
                  diary: {
                    id: diaryId,
                    ownerId: input.ownerId,
                    diaryDate: input.diaryDate,
                    generationId,
                    version: 0,
                  },
                  baseline: input.baseline,
                },
              ],
              { ...context, newGeneration: false, at: new Date() },
            );
          return { created: true, diaryId };
        }
        await tx.delete(documents).where(eq(documents.id, diaryId));
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
