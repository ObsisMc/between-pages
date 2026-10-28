import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DateSelection } from '@between-pages/contracts';
import {
  activeBindings,
  backupOutbox,
  diaries,
  diaryCommits,
  diaryGenerations,
  shareEpochs,
  sharingPolicies,
  spaces,
} from '../db/schema.ts';
import type { DiaryRow, Tx } from './store.ts';

// SQL at sharing boundaries (kernel D4, D5, D9): share epochs, the generation and seq-0
// baseline commit an opening writes, freezing, and the space backup task of each. Writes
// run only while the caller holds the diary rows FOR UPDATE, so an epoch changes only
// under its diary's lock. Imports nothing from store.ts at run time, so store.ts can use
// it when a new diary opens on creation.

export type LiveEpoch = {
  id: string;
  spaceId: string;
  diaryId: string;
  periodId: string;
  recipientId: string;
  generationId: string;
};

/** One share of a diary, live (`closedAt` null) or frozen at `frozenVersion`. */
export type EpochRow = LiveEpoch & {
  openedAt: Date;
  closedAt: Date | null;
  frozenVersion: number | null;
};

/** Where an owner's diaries are shared now: their open binding and the policy confirmed for it. */
export type SharingContext = {
  spaceId: string;
  periodId: string;
  recipientId: string;
  selection: DateSelection;
};

const digest = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

const diaryColumns = {
  id: diaries.id,
  ownerId: diaries.ownerId,
  diaryDate: diaries.diaryDate,
  generationId: diaries.generationId,
  version: diaries.version,
};

const liveColumns = {
  id: shareEpochs.id,
  spaceId: shareEpochs.spaceId,
  diaryId: shareEpochs.diaryId,
  periodId: shareEpochs.periodId,
  recipientId: shareEpochs.recipientId,
  generationId: shareEpochs.generationId,
};
const epochColumns = {
  ...liveColumns,
  openedAt: shareEpochs.openedAt,
  closedAt: shareEpochs.closedAt,
  frozenVersion: shareEpochs.frozenVersion,
};

/** Reads; a snapshot under `read`, the lock holder's view inside a locked flow. */
export class EpochQueries {
  protected readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  /** Every diary of the owner, oldest date first. */
  ownerDiaries(ownerId: string): Promise<DiaryRow[]> {
    return this.tx
      .select(diaryColumns)
      .from(diaries)
      .where(eq(diaries.ownerId, ownerId))
      .orderBy(asc(diaries.diaryDate));
  }

  /** The live epoch of each given diary that has one. */
  async liveEpochs(diaryIds: readonly string[]): Promise<Map<string, LiveEpoch>> {
    if (!diaryIds.length) return new Map();
    const rows = await this.tx
      .select(liveColumns)
      .from(shareEpochs)
      .where(and(inArray(shareEpochs.diaryId, [...diaryIds]), isNull(shareEpochs.closedAt)));
    return new Map(rows.map((row) => [row.diaryId, row]));
  }

  async epoch(epochId: string): Promise<EpochRow | null> {
    const [row] = await this.tx
      .select(epochColumns)
      .from(shareEpochs)
      .where(eq(shareEpochs.id, epochId));
    return row ?? null;
  }

  /** Every share of the diary with this recipient, oldest first. */
  recipientEpochs(diaryId: string, recipientId: string): Promise<EpochRow[]> {
    return this.tx
      .select(epochColumns)
      .from(shareEpochs)
      .where(and(eq(shareEpochs.diaryId, diaryId), eq(shareEpochs.recipientId, recipientId)))
      .orderBy(asc(shareEpochs.openedAt), asc(shareEpochs.id));
  }

  /** Whether `userId` is one of the space's pair. */
  async isParticipant(spaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(eq(spaces.id, spaceId), or(eq(spaces.userLow, userId), eq(spaces.userHigh, userId))),
      );
    return row !== undefined;
  }

  /**
   * Each diary shared with `recipientId` in the space, or in any space when `spaceId` is
   * null, by its live epoch or else its last frozen one (spaces-and-invitations D4), with
   * the diary's date and owner.
   */
  async sharedWith(
    recipientId: string,
    spaceId: string | null,
  ): Promise<(EpochRow & { diaryDate: string; ownerId: string })[]> {
    const rows = await this.tx
      .select({ ...epochColumns, diaryDate: diaries.diaryDate, ownerId: diaries.ownerId })
      .from(shareEpochs)
      .innerJoin(diaries, eq(diaries.id, shareEpochs.diaryId))
      .where(
        and(
          eq(shareEpochs.recipientId, recipientId),
          spaceId === null ? undefined : eq(shareEpochs.spaceId, spaceId),
        ),
      )
      .orderBy(asc(shareEpochs.openedAt), asc(shareEpochs.id));
    const current = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const kept = current.get(row.diaryId);
      if (!kept || kept.closedAt !== null) current.set(row.diaryId, row);
    }
    return [...current.values()];
  }

  liveEpochsInSpace(spaceId: string): Promise<LiveEpoch[]> {
    return this.tx
      .select(liveColumns)
      .from(shareEpochs)
      .where(and(eq(shareEpochs.spaceId, spaceId), isNull(shareEpochs.closedAt)));
  }

  /**
   * The owner's open binding with the selection they confirmed for its period, or null
   * when unbound or not confirmed for this period (spaces-and-invitations D5: an earlier
   * period's confirmation never opens anything).
   */
  async sharingContext(ownerId: string): Promise<SharingContext | null> {
    const [row] = await this.tx
      .select({
        spaceId: activeBindings.spaceId,
        periodId: activeBindings.periodId,
        userLow: spaces.userLow,
        userHigh: spaces.userHigh,
        selection: sharingPolicies.selection,
      })
      .from(activeBindings)
      .innerJoin(spaces, eq(spaces.id, activeBindings.spaceId))
      .innerJoin(
        sharingPolicies,
        and(
          eq(sharingPolicies.spaceId, activeBindings.spaceId),
          eq(sharingPolicies.ownerId, ownerId),
          eq(sharingPolicies.confirmedPeriodId, activeBindings.periodId),
        ),
      )
      .where(eq(activeBindings.userId, ownerId));
    if (!row) return null;
    return {
      spaceId: row.spaceId,
      periodId: row.periodId,
      recipientId: row.userLow === ownerId ? row.userHigh : row.userLow,
      selection: row.selection,
    };
  }
}

/** Rows per multi-row statement, well under PG's 65535 bind parameters. */
const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Writes at a boundary; every diary passed in must be locked FOR UPDATE by the caller. */
export class LockedBoundaries extends EpochQueries {
  /**
   * Opens a share of each diary (D4, D5): a new generation from its baseline (or, for a
   * diary just created, its first one, whose baseline is already clean), the epoch, the
   * seq-0 commit carrying the baseline, and its personal and space backup tasks. No
   * snapshot: the generation's baseline already bounds the replay. Multi-row statements,
   * because this runs while the diary rows are locked (K18). Returns epoch IDs by diary.
   */
  async open(
    entries: readonly { diary: DiaryRow; baseline: Uint8Array }[],
    input: Omit<SharingContext, 'selection'> & { newGeneration: boolean; at: Date },
  ): Promise<Map<string, { epochId: string; generationId: string }>> {
    const opened = entries.map(({ diary, baseline }) => ({
      diary,
      baseline,
      sha256: digest(baseline),
      generationId: input.newGeneration ? randomUUID() : diary.generationId,
      epochId: randomUUID(),
      version: diary.version + 1,
    }));
    for (const part of chunks(opened)) {
      if (input.newGeneration)
        await this.tx.insert(diaryGenerations).values(
          part.map((o) => ({
            id: o.generationId,
            diaryId: o.diary.id,
            sourceVersion: o.diary.version,
            baseline: o.baseline,
            baselineSha256: o.sha256,
            createdAt: input.at,
          })),
        );
      await this.tx.insert(shareEpochs).values(
        part.map((o) => ({
          id: o.epochId,
          spaceId: input.spaceId,
          diaryId: o.diary.id,
          periodId: input.periodId,
          recipientId: input.recipientId,
          generationId: o.generationId,
          openedAt: input.at,
        })),
      );
      await this.tx.insert(diaryCommits).values(
        part.map((o) => ({
          diaryId: o.diary.id,
          version: o.version,
          publicId: randomUUID(),
          generationId: o.generationId,
          seq: 0,
          delta: o.baseline,
          deltaSha256: o.sha256,
          epochId: o.epochId,
        })),
      );
      await this.tx.execute(sql`update ${diaries}
        set version = ${diaries.version} + 1, generation_id = v.generation_id
        from (values ${sql.join(
          part.map((o) => sql`(${o.diary.id}::uuid, ${o.generationId}::uuid)`),
          sql`, `,
        )}) as v(id, generation_id)
        where ${diaries.id} = v.id`);
      await this.tx.insert(backupOutbox).values(
        part.flatMap((o) => [
          { diaryId: o.diary.id, version: o.version, target: 'personal' as const },
          {
            diaryId: o.diary.id,
            version: o.version,
            target: 'space' as const,
            spaceId: input.spaceId,
            epochId: o.epochId,
          },
        ]),
      );
    }
    return new Map(
      opened.map((o) => [o.diary.id, { epochId: o.epochId, generationId: o.generationId }]),
    );
  }

  /**
   * Freezes these live epochs, each at its diary's last committed version (D5); the
   * partner keeps reading that version. The diaries are locked, so the version read here
   * is the last commit of the epoch.
   */
  async freeze(epochIds: readonly string[], at: Date): Promise<void> {
    for (const part of chunks(epochIds))
      await this.tx.execute(sql`update ${shareEpochs}
        set closed_at = ${at}, frozen_version = ${diaries.version}
        from ${diaries}
        where ${diaries.id} = ${shareEpochs.diaryId}
          and ${inArray(shareEpochs.id, part)} and ${isNull(shareEpochs.closedAt)}`);
  }
}
