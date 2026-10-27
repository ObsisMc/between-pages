import type { DateSelection } from '@between-pages/contracts';
import type { RelationStore } from '../store/relations.ts';
import { normalizeSelection, sameSelection } from './selection.ts';

// The caller's own sharing range in a space (spaces-and-invitations D3, D5, D7). Saving one
// records a confirmed configuration and a change row; it opens no diary to anyone. Only its
// owner ever reads it.

export type MySharing = {
  selection: DateSelection;
  revision: number;
  confirmedPeriodId: string | null;
};

const UNSET: MySharing = {
  selection: { include: [], exclude: [] },
  revision: 0,
  confirmedPeriodId: null,
};

export function createSharingService(relations: RelationStore) {
  return {
    /** Readable in current and archived spaces; NOT_FOUND unless the caller takes part (D7). */
    mine(caller: string, spaceId: string): Promise<MySharing | 'NOT_FOUND'> {
      return relations.read(async (queries) => {
        const space = await queries.space(spaceId);
        if (!space || (space.userLow !== caller && space.userHigh !== caller)) return 'NOT_FOUND';
        return (await queries.policy(spaceId, caller)) ?? UNSET;
      });
    },

    /**
     * Confirms `selection` for the open period `expectedPeriodId`. A repeated `requestId`
     * returns its original result and never applies again, even to a later period; the same
     * ID with another space, period, revision or selection is VALIDATION_FAILED. A closed or
     * different period is PERIOD_CLOSED; another revision is POLICY_CONFLICT (D5, D9, D11).
     */
    save(
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
    > {
      const selection = normalizeSelection(input.selection);
      return relations.withUsersLocked([caller], async (locked) => {
        const space = await locked.lockSpace(spaceId);
        if (!space || (space.userLow !== caller && space.userHigh !== caller)) return 'NOT_FOUND';
        const earlier = await locked.changeByRequest(caller, input.requestId);
        if (earlier) {
          const same =
            earlier.spaceId === spaceId &&
            earlier.periodId === input.expectedPeriodId &&
            earlier.fromRevision === input.expectedRevision &&
            sameSelection(earlier.selection, selection);
          return same
            ? { revision: earlier.toRevision, changeId: earlier.id }
            : 'VALIDATION_FAILED';
        }
        const open = (await locked.openPeriods([spaceId])).get(spaceId);
        if (open !== input.expectedPeriodId) return 'PERIOD_CLOSED';
        const revision = (await locked.policy(spaceId, caller))?.revision ?? UNSET.revision;
        if (revision !== input.expectedRevision) return 'POLICY_CONFLICT';
        return locked.confirmSelection({
          spaceId,
          ownerId: caller,
          periodId: open,
          requestId: input.requestId,
          selection,
          at: now,
        });
      });
    },
  };
}

export type SharingService = ReturnType<typeof createSharingService>;
