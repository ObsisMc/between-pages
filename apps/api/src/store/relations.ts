import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DateSelection } from '@between-pages/contracts';
import type { Db } from '../db/client.ts';
import {
  activeBindings,
  bindingInvitations,
  bindingPeriods,
  diaries,
  documents,
  sharingPolicies,
  sharingPolicyChanges,
  spaces,
  users,
} from '../db/schema.ts';
import { EpochQueries, LockedBoundaries } from './boundaries.ts';
import { DiaryQueries, type DiaryRow } from './store.ts';
import { registerSpaceCopy } from './together.ts';

// SQL for the relationship and sharing range tables (spaces-and-invitations D9, D10).
// Every write runs under `withUsersLocked`: the users rows of everyone the flow touches,
// FOR UPDATE in UUID order, before any space or period row. Writes to one person's
// invitations, bindings and policies all hold that person's row, so reads made after the
// lock see no concurrent change to them.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type SpaceRow = { id: string; userLow: string; userHigh: string; createdAt: Date };
export type PeriodRow = { id: string; startedAt: Date; endedAt: Date | null };
export type InvitationRow = {
  id: string;
  createdBy: string;
  requestId: string;
  confirmedSelection: DateSelection | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  acceptedAt: Date | null;
};
export type PolicyRow = {
  selection: DateSelection;
  revision: number;
  confirmedPeriodId: string | null;
};
export type ChangeRow = {
  id: string;
  spaceId: string;
  fromRevision: number;
  toRevision: number;
  selection: DateSelection;
  periodId: string;
};

const spaceColumns = {
  id: spaces.id,
  userLow: spaces.userLow,
  userHigh: spaces.userHigh,
  createdAt: spaces.createdAt,
};
const periodColumns = {
  id: bindingPeriods.id,
  startedAt: bindingPeriods.startedAt,
  endedAt: bindingPeriods.endedAt,
};
const invitationColumns = {
  id: bindingInvitations.id,
  createdBy: bindingInvitations.createdBy,
  requestId: bindingInvitations.requestId,
  confirmedSelection: bindingInvitations.confirmedSelection,
  createdAt: bindingInvitations.createdAt,
  expiresAt: bindingInvitations.expiresAt,
  revokedAt: bindingInvitations.revokedAt,
  acceptedAt: bindingInvitations.acceptedAt,
};
const isOpen = and(isNull(bindingInvitations.revokedAt), isNull(bindingInvitations.acceptedAt));

/** Reads inside one transaction: a snapshot when run by `read`, the lock holder's view under `withUsersLocked`. */
export class RelationQueries {
  protected readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  /** Every space the user takes part in; at most one in the first release (D2). */
  spacesOf(userId: string): Promise<SpaceRow[]> {
    return this.tx
      .select(spaceColumns)
      .from(spaces)
      .where(or(eq(spaces.userLow, userId), eq(spaces.userHigh, userId)))
      .orderBy(asc(spaces.createdAt), asc(spaces.id));
  }

  async space(spaceId: string): Promise<SpaceRow | null> {
    const [row] = await this.tx.select(spaceColumns).from(spaces).where(eq(spaces.id, spaceId));
    return row ?? null;
  }

  async spaceOfPair(a: string, b: string): Promise<SpaceRow | null> {
    const [low, high] = [a, b].sort();
    const [row] = await this.tx
      .select(spaceColumns)
      .from(spaces)
      .where(and(eq(spaces.userLow, low!), eq(spaces.userHigh, high!)));
    return row ?? null;
  }

  /** Display names by user ID. */
  async names(userIds: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  /** Oldest first, ties by ID (D11). */
  periods(spaceId: string): Promise<PeriodRow[]> {
    return this.tx
      .select(periodColumns)
      .from(bindingPeriods)
      .where(eq(bindingPeriods.spaceId, spaceId))
      .orderBy(asc(bindingPeriods.startedAt), asc(bindingPeriods.id));
  }

  /** The open period of each given space. */
  async openPeriods(spaceIds: readonly string[]): Promise<Map<string, string>> {
    if (!spaceIds.length) return new Map();
    const rows = await this.tx
      .select({ id: bindingPeriods.id, spaceId: bindingPeriods.spaceId })
      .from(bindingPeriods)
      .where(and(inArray(bindingPeriods.spaceId, [...spaceIds]), isNull(bindingPeriods.endedAt)));
    return new Map(rows.map((row) => [row.spaceId, row.id]));
  }

  async period(spaceId: string, periodId: string): Promise<PeriodRow | null> {
    const [row] = await this.tx
      .select(periodColumns)
      .from(bindingPeriods)
      .where(and(eq(bindingPeriods.spaceId, spaceId), eq(bindingPeriods.id, periodId)));
    return row ?? null;
  }

  async activeBinding(userId: string): Promise<{ spaceId: string; periodId: string } | null> {
    const [row] = await this.tx
      .select({ spaceId: activeBindings.spaceId, periodId: activeBindings.periodId })
      .from(activeBindings)
      .where(eq(activeBindings.userId, userId));
    return row ?? null;
  }

  async openInvitation(createdBy: string): Promise<InvitationRow | null> {
    const [row] = await this.tx
      .select(invitationColumns)
      .from(bindingInvitations)
      .where(and(eq(bindingInvitations.createdBy, createdBy), isOpen));
    return row ?? null;
  }

  async invitationByRequest(createdBy: string, requestId: string): Promise<InvitationRow | null> {
    const [row] = await this.tx
      .select(invitationColumns)
      .from(bindingInvitations)
      .where(
        and(
          eq(bindingInvitations.createdBy, createdBy),
          eq(bindingInvitations.requestId, requestId),
        ),
      );
    return row ?? null;
  }

  async invitationByTokenHash(tokenHash: Uint8Array): Promise<InvitationRow | null> {
    const [row] = await this.tx
      .select(invitationColumns)
      .from(bindingInvitations)
      .where(eq(bindingInvitations.tokenHash, tokenHash));
    return row ?? null;
  }

  async invitation(id: string): Promise<InvitationRow | null> {
    const [row] = await this.tx
      .select(invitationColumns)
      .from(bindingInvitations)
      .where(eq(bindingInvitations.id, id));
    return row ?? null;
  }

  async policy(spaceId: string, ownerId: string): Promise<PolicyRow | null> {
    const [row] = await this.tx
      .select({
        selection: sharingPolicies.selection,
        revision: sharingPolicies.revision,
        confirmedPeriodId: sharingPolicies.confirmedPeriodId,
      })
      .from(sharingPolicies)
      .where(and(eq(sharingPolicies.spaceId, spaceId), eq(sharingPolicies.ownerId, ownerId)));
    return row ?? null;
  }

  async changeByRequest(ownerId: string, requestId: string): Promise<ChangeRow | null> {
    const [row] = await this.tx
      .select({
        id: sharingPolicyChanges.id,
        spaceId: sharingPolicyChanges.spaceId,
        fromRevision: sharingPolicyChanges.fromRevision,
        toRevision: sharingPolicyChanges.toRevision,
        selection: sharingPolicyChanges.selection,
        periodId: sharingPolicyChanges.periodId,
      })
      .from(sharingPolicyChanges)
      .where(
        and(
          eq(sharingPolicyChanges.ownerId, ownerId),
          eq(sharingPolicyChanges.requestId, requestId),
        ),
      );
    return row ?? null;
  }
}

/** Diary rows locked FOR UPDATE inside a relationship flow, with their reads and boundary writes. */
export type LockedDiaries = {
  /** Fresh under the lock, in ID order. */
  rows: DiaryRow[];
  queries: DiaryQueries;
  boundaries: LockedBoundaries;
};

/** Writes; only reachable while the users rows of the flow are locked. */
export class LockedRelations extends RelationQueries {
  /** Diaries and share epochs, read in this transaction after the users locks. */
  get epochs(): EpochQueries {
    return new EpochQueries(this.tx);
  }

  /**
   * Locks these diary rows FOR UPDATE in ID order, the last locks of every flow that
   * changes sharing (kernel D9): users, then space and period, then policy, then diaries.
   * A commit holds only its diary row, so it finishes before or after this flow, never
   * across it.
   */
  async lockDiaries(diaryIds: readonly string[]): Promise<LockedDiaries> {
    // LockRows sits above the sort, so PG takes the row locks in ID order.
    const rows = diaryIds.length
      ? await this.tx
          .select({
            id: diaries.id,
            ownerId: diaries.ownerId,
            diaryDate: diaries.diaryDate,
            generationId: documents.generationId,
            version: documents.version,
          })
          .from(diaries)
          .innerJoin(documents, eq(documents.id, diaries.id))
          .where(inArray(diaries.id, [...diaryIds]))
          .orderBy(asc(diaries.id))
          .for('update', { of: documents })
      : [];
    return { rows, queries: new DiaryQueries(this.tx), boundaries: new LockedBoundaries(this.tx) };
  }

  /** Locks the space row; the lock order is users, then space, then period (D9). */
  async lockSpace(spaceId: string): Promise<SpaceRow | null> {
    const [row] = await this.tx
      .select(spaceColumns)
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .for('update');
    return row ?? null;
  }

  async insertSpace(a: string, b: string, at: Date): Promise<SpaceRow> {
    const [low, high] = [a, b].sort();
    const [row] = await this.tx
      .insert(spaces)
      .values({ id: randomUUID(), userLow: low!, userHigh: high!, createdAt: at })
      .returning(spaceColumns);
    return row!;
  }

  /** Opens a period and binds both participants to it. */
  async startPeriod(space: SpaceRow, at: Date): Promise<string> {
    const periodId = randomUUID();
    await this.tx.insert(bindingPeriods).values({ id: periodId, spaceId: space.id, startedAt: at });
    await this.tx.insert(activeBindings).values([
      { userId: space.userLow, periodId, spaceId: space.id },
      { userId: space.userHigh, periodId, spaceId: space.id },
    ]);
    return periodId;
  }

  /**
   * Every `Together` Doc of the space is written again: after unbinding with the read-only
   * line, after the pair rebinds without it (google-copy-beyond-diaries D7, invariant 10).
   */
  async copySpace(spaceId: string): Promise<void> {
    await registerSpaceCopy(this.tx, {
      spaceId,
      recordType: null,
      recordId: null,
      privateTo: null,
    });
  }

  /** Ends the open period and removes both current bindings; the space and its history stay. */
  async endPeriod(periodId: string, by: string, at: Date): Promise<void> {
    await this.tx
      .update(bindingPeriods)
      .set({ endedAt: at, endedBy: by })
      .where(eq(bindingPeriods.id, periodId));
    await this.tx.delete(activeBindings).where(eq(activeBindings.periodId, periodId));
  }

  async insertInvitation(input: {
    createdBy: string;
    requestId: string;
    tokenHash: Uint8Array;
    confirmedSelection: DateSelection | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<InvitationRow> {
    const [row] = await this.tx
      .insert(bindingInvitations)
      .values({ id: randomUUID(), ...input })
      .returning(invitationColumns);
    return row!;
  }

  /** Closes every open invitation of these users, expired or not. */
  async closeOpenInvitations(createdBy: readonly string[], at: Date): Promise<void> {
    await this.tx
      .update(bindingInvitations)
      .set({ revokedAt: at })
      .where(and(inArray(bindingInvitations.createdBy, [...createdBy]), isOpen));
  }

  async revokeInvitation(id: string, at: Date): Promise<void> {
    await this.tx
      .update(bindingInvitations)
      .set({ revokedAt: at })
      .where(and(eq(bindingInvitations.id, id), isOpen));
  }

  async acceptInvitation(id: string, by: string, at: Date): Promise<void> {
    await this.tx
      .update(bindingInvitations)
      .set({ acceptedAt: at, acceptedBy: by })
      .where(and(eq(bindingInvitations.id, id), isOpen));
  }

  /** The owner's policy row, created empty and unconfirmed when missing (D10). */
  async ensurePolicy(spaceId: string, ownerId: string): Promise<PolicyRow> {
    await this.tx.insert(sharingPolicies).values({ spaceId, ownerId }).onConflictDoNothing();
    return (await this.policy(spaceId, ownerId))!;
  }

  /**
   * Stores `selection` as confirmed for `periodId`, one revision up, with its change row
   * under `requestId`. Configures a range only; publishes no diary text (D5, D10).
   */
  async confirmSelection(input: {
    spaceId: string;
    ownerId: string;
    periodId: string;
    requestId: string;
    selection: DateSelection;
    at: Date;
  }): Promise<{ revision: number; changeId: string }> {
    const { revision } = await this.ensurePolicy(input.spaceId, input.ownerId);
    const changeId = randomUUID();
    await this.tx
      .update(sharingPolicies)
      .set({
        selection: input.selection,
        revision: revision + 1,
        confirmedPeriodId: input.periodId,
      })
      .where(
        and(eq(sharingPolicies.spaceId, input.spaceId), eq(sharingPolicies.ownerId, input.ownerId)),
      );
    await this.tx.insert(sharingPolicyChanges).values({
      id: changeId,
      spaceId: input.spaceId,
      ownerId: input.ownerId,
      requestId: input.requestId,
      fromRevision: revision,
      toRevision: revision + 1,
      selection: input.selection,
      periodId: input.periodId,
      createdAt: input.at,
    });
    return { revision: revision + 1, changeId };
  }
}

export function createRelationStore(db: Db) {
  return {
    /** Runs `read` in one read-only snapshot without locks. */
    read<T>(read: (queries: RelationQueries) => Promise<T>): Promise<T> {
      return db.transaction((tx) => read(new RelationQueries(tx)), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    },

    /**
     * Runs `work` holding the users rows `FOR UPDATE` in UUID order, the first locks of
     * every relationship flow (D9), so two flows over the same people queue instead of
     * deadlocking. A throw rolls everything back.
     */
    withUsersLocked<T>(
      userIds: readonly string[],
      work: (locked: LockedRelations) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) => {
        for (const id of [...new Set(userIds)].sort())
          await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for('update');
        return work(new LockedRelations(tx));
      });
    },
  };
}

export type RelationStore = ReturnType<typeof createRelationStore>;
