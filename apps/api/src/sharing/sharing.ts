import type { DateSelection } from '@between-pages/contracts';
import type { ContextEvent, Events } from '../events/events.ts';
import type { LockedRelations, RelationStore, SpaceRow } from '../store/relations.ts';
import type { Store } from '../store/store.ts';
import {
  ShareOpenFailed,
  applyOpen,
  freezeSpace,
  prepareOpen,
  type Applied,
  type Prepared,
} from './open.ts';
import { normalizeSelection, sameSelection } from './selection.ts';

// The caller's own sharing range in a space (spaces-and-invitations D3, D5, D7) and what it
// shares (kernel D5): saving a range for the open period opens every covered diary to the
// partner and freezes every live one it no longer covers, in the transaction that stores
// the range. Only its owner ever reads the range.

export type MySharing = {
  selection: DateSelection;
  revision: number;
  confirmedPeriodId: string | null;
};

/** Some covered diaries could not get a clean baseline; nothing was stored or opened (kernel D5). */
export type OpenRefusal = { code: 'SHARE_OPEN_FAILED'; dates: string[] };

const UNSET: MySharing = {
  selection: { include: [], exclude: [] },
  revision: 0,
  confirmedPeriodId: null,
};

const isParticipant = (space: SpaceRow, userId: string) =>
  space.userLow === userId || space.userHigh === userId;
const partnerOf = (space: SpaceRow, userId: string) =>
  space.userLow === userId ? space.userHigh : space.userLow;

/** Runs `flow`; a ShareOpenFailed thrown inside its transaction has rolled it back and becomes the refusal. */
export async function refusingFailedOpen<T>(flow: () => Promise<T>): Promise<T | OpenRefusal> {
  try {
    return await flow();
  } catch (error) {
    if (error instanceof ShareOpenFailed) return { code: 'SHARE_OPEN_FAILED', dates: error.dates };
    throw error;
  }
}

export function createSharingService(relations: RelationStore, store: Store, events: Events) {
  return {
    /** Readable in current and archived spaces; NOT_FOUND unless the caller takes part (D7). */
    mine(caller: string, spaceId: string): Promise<MySharing | 'NOT_FOUND'> {
      return relations.read(async (queries) => {
        const space = await queries.space(spaceId);
        if (!space || !isParticipant(space, caller)) return 'NOT_FOUND';
        return (await queries.policy(spaceId, caller)) ?? UNSET;
      });
    },

    /** Phase 1 of opening the owner's diaries `selection` covers (kernel D5); see `prepareOpen`. */
    prepare(ownerId: string, selection: DateSelection) {
      return prepareOpen(store, ownerId, selection);
    },

    /**
     * Phase 2, inside a relationship transaction holding the owner's users row and the
     * space: the owner's live epochs in `space` then match `selection` (null shares
     * nothing). Throws ShareOpenFailed, rolling the transaction back.
     */
    apply(
      locked: LockedRelations,
      input: {
        ownerId: string;
        space: SpaceRow;
        periodId: string;
        selection: DateSelection | null;
        prepared: Prepared;
        at: Date;
      },
    ): Promise<Applied> {
      return applyOpen(locked, {
        ownerId: input.ownerId,
        spaceId: input.space.id,
        periodId: input.periodId,
        recipientId: partnerOf(input.space, input.ownerId),
        selection: input.selection,
        prepared: input.prepared,
        at: input.at,
      });
    },

    /** Freezes every live share of the space, inside the unbinding transaction (D5). */
    freezeSpace(locked: LockedRelations, spaceId: string, at: Date): Promise<ContextEvent[]> {
      return freezeSpace(locked, spaceId, at);
    },

    /** Tells open sockets what `apply` or `freezeSpace` changed; call only after their COMMIT. */
    announce(changes: readonly ContextEvent[]): void {
      for (const change of changes) events.publish(change);
    },

    /**
     * Confirms `selection` for the open period `expectedPeriodId` and shares accordingly:
     * covered diaries open from clean baselines, live ones no longer covered freeze, in
     * one transaction with the new revision (kernel D5). A repeated `requestId` returns
     * its original result and never applies again, even to a later period; the same ID
     * with another space, period, revision or selection is VALIDATION_FAILED. A closed or
     * different period is PERIOD_CLOSED; another revision is POLICY_CONFLICT (D5, D9, D11).
     * A diary without a clean baseline refuses the whole save with its date.
     */
    async save(
      caller: string,
      spaceId: string,
      input: {
        requestId: string;
        expectedPeriodId: string;
        expectedRevision: number;
        selection: DateSelection;
      },
      now: Date,
    ): Promise<
      | { revision: number; changeId: string }
      | 'NOT_FOUND'
      | 'VALIDATION_FAILED'
      | 'PERIOD_CLOSED'
      | 'POLICY_CONFLICT'
      | OpenRefusal
    > {
      const selection = normalizeSelection(input.selection);
      // Answers what needs no baseline before building any; rechecked under the locks.
      const settled = await relations.read(async (queries) => {
        const space = await queries.space(spaceId);
        if (!space || !isParticipant(space, caller)) return 'NOT_FOUND';
        if (await queries.changeByRequest(caller, input.requestId)) return 'REPEATED';
        const open = (await queries.openPeriods([spaceId])).get(spaceId);
        if (open !== input.expectedPeriodId) return 'PERIOD_CLOSED';
        const revision = (await queries.policy(spaceId, caller))?.revision ?? UNSET.revision;
        return revision === input.expectedRevision ? null : 'POLICY_CONFLICT';
      });
      if (settled && settled !== 'REPEATED') return settled;
      const { prepared, failed } = settled
        ? { prepared: new Map() as Prepared, failed: [] }
        : await prepareOpen(store, caller, selection);
      if (failed.length) return { code: 'SHARE_OPEN_FAILED', dates: failed };

      let changes: ContextEvent[] = [];
      const result = await refusingFailedOpen(() =>
        relations.withUsersLocked([caller], async (locked) => {
          const space = await locked.lockSpace(spaceId);
          if (!space || !isParticipant(space, caller)) return 'NOT_FOUND' as const;
          const earlier = await locked.changeByRequest(caller, input.requestId);
          if (earlier) {
            const same =
              earlier.spaceId === spaceId &&
              earlier.periodId === input.expectedPeriodId &&
              earlier.fromRevision === input.expectedRevision &&
              sameSelection(earlier.selection, selection);
            return same
              ? { revision: earlier.toRevision, changeId: earlier.id }
              : ('VALIDATION_FAILED' as const);
          }
          const open = (await locked.openPeriods([spaceId])).get(spaceId);
          if (open !== input.expectedPeriodId) return 'PERIOD_CLOSED' as const;
          const revision = (await locked.policy(spaceId, caller))?.revision ?? UNSET.revision;
          if (revision !== input.expectedRevision) return 'POLICY_CONFLICT' as const;
          const saved = await locked.confirmSelection({
            spaceId,
            ownerId: caller,
            periodId: open,
            requestId: input.requestId,
            selection,
            at: now,
          });
          ({ changes } = await applyOpen(locked, {
            ownerId: caller,
            spaceId,
            periodId: open,
            recipientId: partnerOf(space, caller),
            selection,
            prepared,
            at: now,
          }));
          return saved;
        }),
      );
      // Only now has PG committed; a rolled-back attempt left `changes` unannounced.
      if (typeof result === 'object' && 'changeId' in result)
        for (const c of changes) events.publish(c);
      return result;
    },
  };
}

export type SharingService = ReturnType<typeof createSharingService>;
