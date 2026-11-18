import { createHash, randomBytes } from 'node:crypto';
import type { DateSelection } from '@between-pages/contracts';
import type {
  InvitationRow,
  PeriodRow,
  RelationQueries,
  RelationStore,
  SpaceRow,
} from '../store/relations.ts';
import { normalizeSelection, sameSelection } from '../sharing/selection.ts';
import type { ContextEvent } from '../events/events.ts';
import type { Prepared } from '../sharing/open.ts';
import { refusingFailedOpen, type OpenRefusal, type SharingService } from '../sharing/sharing.ts';

// Invitations, binding, unbinding and the caller's spaces (spaces-and-invitations D2, D5,
// D8, D9). The caller always comes from the session. Every flow that writes locks the users
// rows of everyone it touches first, then re-reads what it decides on.

/** Links stay valid this long; an invitation whose expiry equals now is expired (D8). */
export const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

export type Refusal =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'INVITE_INVALID'
  | 'INVITE_EXPIRED'
  | 'INVITE_REVOKED'
  | 'INVITE_USED'
  | 'SELF_INVITE'
  | 'ALREADY_BOUND'
  | 'PARTNER_FIXED';

export type Space = {
  id: string;
  createdAt: Date;
  state: 'active' | 'archived';
  /** Slot order: the participant whose ID sorts first is slot 1. */
  participants: { user: { id: string; displayName: string }; authorSlot: 1 | 2 }[];
};
export type Binding = { space: Space; periodId: string };
export type Invitation = {
  id: string;
  expiresAt: Date;
  state: 'pending' | 'expired' | 'revoked' | 'used';
};

const hashToken = (token: string) =>
  new Uint8Array(createHash('sha256').update(token, 'utf8').digest());

function invitationState(row: InvitationRow, now: Date): Invitation['state'] {
  if (row.acceptedAt) return 'used';
  // Rotation closes an expired link too; it still reads as expired, which it was first.
  if (row.revokedAt) return row.revokedAt >= row.expiresAt ? 'expired' : 'revoked';
  return row.expiresAt <= now ? 'expired' : 'pending';
}

const summary = (row: InvitationRow, now: Date): Invitation => ({
  id: row.id,
  expiresAt: row.expiresAt,
  state: invitationState(row, now),
});

/** Why `row` cannot be accepted by `caller` now, checking the invitation before the people (D11). */
function invitationRefusal(row: InvitationRow | null, caller: string, now: Date): Refusal | null {
  if (!row) return 'INVITE_INVALID';
  const state = invitationState(row, now);
  if (state === 'used') return 'INVITE_USED';
  if (state === 'revoked') return 'INVITE_REVOKED';
  if (state === 'expired') return 'INVITE_EXPIRED';
  if (row.createdBy === caller) return 'SELF_INVITE';
  return null;
}

/**
 * Why `inviter` and `acceptor` cannot bind: either is bound now, or either already has a
 * permanent space with someone else (D2, D8). Neither the other partner nor that space is
 * named.
 */
async function pairRefusal(
  queries: RelationQueries,
  inviter: string,
  acceptor: string,
): Promise<Refusal | null> {
  if ((await queries.activeBinding(inviter)) || (await queries.activeBinding(acceptor)))
    return 'ALREADY_BOUND';
  const own = [...(await queries.spacesOf(inviter)), ...(await queries.spacesOf(acceptor))];
  const pair = [inviter, acceptor].sort().join();
  if (own.some((s) => [s.userLow, s.userHigh].join() !== pair)) return 'PARTNER_FIXED';
  return null;
}

async function spaceSummary(queries: RelationQueries, row: SpaceRow): Promise<Space> {
  const names = await queries.names([row.userLow, row.userHigh]);
  const open = await queries.openPeriods([row.id]);
  return {
    id: row.id,
    createdAt: row.createdAt,
    state: open.has(row.id) ? 'active' : 'archived',
    participants: ([row.userLow, row.userHigh] as const).map((id, index) => ({
      user: { id, displayName: names.get(id)! },
      authorSlot: (index + 1) as 1 | 2,
    })),
  };
}

const isParticipant = (row: SpaceRow, userId: string) =>
  row.userLow === userId || row.userHigh === userId;

export function createBindingService(relations: RelationStore, sharing: SharingService) {
  return {
    /** The caller's current binding and their latest open invitation. */
    binding(
      caller: string,
      now: Date,
    ): Promise<{ binding: Binding | null; invitation: Invitation | null }> {
      return relations.read(async (queries) => {
        const active = await queries.activeBinding(caller);
        const space = active && (await queries.space(active.spaceId));
        const invitation = await queries.openInvitation(caller);
        return {
          binding: space
            ? { space: await spaceSummary(queries, space), periodId: active!.periodId }
            : null,
          invitation: invitation && summary(invitation, now),
        };
      });
    },

    /** Spaces the caller takes part in, current or archived; never anyone else's. */
    spaces(caller: string): Promise<Space[]> {
      return relations.read(async (queries) =>
        Promise.all((await queries.spacesOf(caller)).map((row) => spaceSummary(queries, row))),
      );
    },

    /** One space with its periods; NOT_FOUND unless the caller takes part (D7). */
    space(
      caller: string,
      spaceId: string,
    ): Promise<{ space: Space; periods: PeriodRow[] } | 'NOT_FOUND'> {
      return relations.read(async (queries) => {
        const row = await queries.space(spaceId);
        if (!row || !isParticipant(row, caller)) return 'NOT_FOUND';
        return { space: await spaceSummary(queries, row), periods: await queries.periods(row.id) };
      });
    },

    /**
     * Opens a new invitation, closing the caller's previous one. A repeated `requestId`
     * returns the stored invitation without its token, which cannot be recovered; the same
     * request ID with another selection is VALIDATION_FAILED (D8, D11).
     */
    createInvitation(
      caller: string,
      input: { requestId: string; sharingSelection: DateSelection | null },
      now: Date,
    ): Promise<{ invitation: Invitation; token: string | null } | Refusal> {
      const selection = input.sharingSelection && normalizeSelection(input.sharingSelection);
      return relations.withUsersLocked([caller], async (locked) => {
        const earlier = await locked.invitationByRequest(caller, input.requestId);
        if (earlier) {
          const same =
            earlier.confirmedSelection === null || selection === null
              ? earlier.confirmedSelection === selection
              : sameSelection(earlier.confirmedSelection, selection);
          return same ? { invitation: summary(earlier, now), token: null } : 'VALIDATION_FAILED';
        }
        if (await locked.activeBinding(caller)) return 'ALREADY_BOUND';
        await locked.closeOpenInvitations([caller], now);
        const token = randomBytes(32).toString('base64url');
        const row = await locked.insertInvitation({
          createdBy: caller,
          requestId: input.requestId,
          tokenHash: hashToken(token),
          confirmedSelection: selection,
          createdAt: now,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        });
        return { invitation: summary(row, now), token };
      });
    },

    /** Closes the caller's own invitation by ID; revoking it again changes nothing (D8). */
    revokeInvitation(caller: string, inviteId: string, now: Date): Promise<true | Refusal> {
      return relations.withUsersLocked([caller], async (locked) => {
        const row = await locked.invitation(inviteId);
        if (!row || row.createdBy !== caller) return 'NOT_FOUND';
        if (row.acceptedAt) return 'INVITE_USED';
        await locked.revokeInvitation(row.id, now);
        return true;
      });
    },

    /** What the holder of `token` may see before accepting; binds nothing and reserves nothing (D8). */
    preview(
      caller: string,
      token: string,
      now: Date,
    ): Promise<
      | { inviter: { id: string; displayName: string }; expiresAt: Date; mode: 'new' | 'restore' }
      | Refusal
    > {
      return relations.read(async (queries) => {
        const row = await queries.invitationByTokenHash(hashToken(token));
        const refusal =
          invitationRefusal(row, caller, now) ??
          (await pairRefusal(queries, row!.createdBy, caller));
        if (refusal) return refusal;
        const names = await queries.names([row!.createdBy]);
        return {
          inviter: { id: row!.createdBy, displayName: names.get(row!.createdBy)! },
          expiresAt: row!.expiresAt,
          mode: (await queries.spaceOfPair(row!.createdBy, caller)) ? 'restore' : 'new',
        };
      });
    },

    /**
     * Binds the caller to the inviter in one transaction (D9): space found or created, a
     * new period with both current bindings, the invitation consumed, both people's other
     * invitations closed, and each confirmed selection stored for the new period and
     * opened (kernel D5: the binding transaction is the opening's phase 2; phase 1 builds
     * both people's baselines before it). Any failure rolls all of it back, a diary
     * without a clean baseline as SHARE_OPEN_FAILED; success is returned only after COMMIT.
     */
    async accept(
      caller: string,
      input: { token: string; sharingSelection: DateSelection | null },
      now: Date,
    ): Promise<{ binding: Binding; restored: boolean } | Refusal | OpenRefusal> {
      const tokenHash = hashToken(input.token);
      const found = await relations.read((queries) => queries.invitationByTokenHash(tokenHash));
      if (!found) return 'INVITE_INVALID';
      const selection = input.sharingSelection && normalizeSelection(input.sharingSelection);
      const early =
        invitationRefusal(found, caller, now) ??
        (await relations.read((queries) => pairRefusal(queries, found.createdBy, caller)));
      if (early) return early;
      const prepared = new Map<string, Prepared>();
      for (const [ownerId, chosen] of [
        [found.createdBy, found.confirmedSelection],
        [caller, selection],
      ] as const) {
        if (!chosen) continue;
        const built = await sharing.prepare(ownerId, chosen);
        if (built.failed.length) return { code: 'SHARE_OPEN_FAILED', dates: built.failed };
        prepared.set(ownerId, built.prepared);
      }
      const changes: ContextEvent[] = [];
      const result = await refusingFailedOpen(() =>
        relations.withUsersLocked([found.createdBy, caller], async (locked) => {
          const row = await locked.invitation(found.id);
          const refusal =
            invitationRefusal(row, caller, now) ??
            (await pairRefusal(locked, row!.createdBy, caller));
          if (refusal) return refusal;
          const inviter = row!.createdBy;
          const existing = await locked.spaceOfPair(inviter, caller);
          const space = existing
            ? (await locked.lockSpace(existing.id))!
            : await locked.insertSpace(inviter, caller, now);
          const periodId = await locked.startPeriod(space, now);
          if (existing) await locked.copySpace(space.id);
          await locked.acceptInvitation(row!.id, caller, now);
          await locked.closeOpenInvitations([inviter, caller], now);
          const choices = [
            [inviter, row!.confirmedSelection, row!.requestId],
            [caller, selection, row!.id],
          ] as const;
          for (const [ownerId, chosen, requestId] of choices) {
            if (chosen)
              await locked.confirmSelection({
                spaceId: space.id,
                ownerId,
                periodId,
                requestId,
                selection: chosen,
                at: now,
              });
            else await locked.ensurePolicy(space.id, ownerId);
          }
          // Diary rows lock last, after both policies (kernel D9).
          for (const [ownerId, chosen] of choices)
            if (chosen) {
              const applied = await sharing.apply(locked, {
                ownerId,
                space,
                periodId,
                selection: chosen,
                prepared: prepared.get(ownerId)!,
                at: now,
              });
              changes.push(...applied.changes);
            }
          return {
            binding: { space: await spaceSummary(locked, space), periodId },
            restored: existing !== null,
          };
        }),
      );
      // Only now has PG committed; a refusal or rollback announces nothing.
      if (typeof result === 'object' && 'binding' in result) sharing.announce(changes);
      return result;
    },

    /**
     * Ends `expectedPeriodId` for both participants and freezes every live share of the
     * space in the same transaction (kernel D5). Repeating it for a period that already
     * ended returns that result again and never touches a later period (D9).
     */
    async unbind(
      caller: string,
      spaceId: string,
      expectedPeriodId: string,
      now: Date,
    ): Promise<{ spaceId: string; closedPeriodId: string } | 'NOT_FOUND'> {
      const space = await relations.read((queries) => queries.space(spaceId));
      if (!space || !isParticipant(space, caller)) return 'NOT_FOUND';
      let changes: ContextEvent[] = [];
      const ended = await relations.withUsersLocked(
        [space.userLow, space.userHigh],
        async (locked) => {
          await locked.lockSpace(space.id);
          const period = await locked.period(space.id, expectedPeriodId);
          if (!period) return 'NOT_FOUND';
          if (!period.endedAt) {
            await locked.endPeriod(period.id, caller, now);
            await locked.copySpace(space.id);
            await locked.closeOpenInvitations([space.userLow, space.userHigh], now);
            changes = await sharing.freezeSpace(locked, space.id, now);
          }
          return { spaceId: space.id, closedPeriodId: period.id };
        },
      );
      sharing.announce(changes);
      return ended;
    },
  };
}

export type BindingService = ReturnType<typeof createBindingService>;
