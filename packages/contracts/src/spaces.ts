import { z } from 'zod';
import { UserSummary } from './users.ts';
import { DateSelection } from './sharing.ts';

// Relationship wire shapes (spaces-and-invitations ADR D11). A person's sharing range
// appears only in that person's own responses; the partner and an invitation preview never
// see it (D7).

const Uuid = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });

/** 32 random bytes in base64url (D8). Never logged, cached or echoed in an error. */
export const InvitationToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Slot 1 is the participant whose ID sorts first; it decides author colors, never rights (D2). */
export const SpaceParticipant = z
  .object({ user: UserSummary, authorSlot: z.union([z.literal(1), z.literal(2)]) })
  .meta({ id: 'SpaceParticipant' });

/** `active` while a binding period is open; an active space does not mean any diary is shared. */
export const SpaceSummary = z
  .object({
    id: Uuid,
    createdAt: Timestamp,
    state: z.enum(['active', 'archived']),
    participants: z.array(SpaceParticipant).length(2),
  })
  .meta({ id: 'SpaceSummary' });

export const BindingSummary = z
  .object({ space: SpaceSummary, periodId: Uuid })
  .meta({ id: 'BindingSummary' });

export const PeriodSummary = z
  .object({ id: Uuid, startedAt: Timestamp, endedAt: Timestamp.nullable() })
  .meta({ id: 'PeriodSummary' });

export const InvitationSummary = z
  .object({
    id: Uuid,
    expiresAt: Timestamp,
    state: z.enum(['pending', 'expired', 'revoked', 'used']),
  })
  .meta({ id: 'InvitationSummary' });

export const BindingResponse = z
  .object({ binding: BindingSummary.nullable(), invitation: InvitationSummary.nullable() })
  .meta({ id: 'BindingResponse' });

export const SpacesResponse = z
  .object({ spaces: z.array(SpaceSummary) })
  .meta({ id: 'SpacesResponse' });

export const SpaceParams = z.strictObject({ spaceId: Uuid });

export const SpaceResponse = z
  .object({ space: SpaceSummary, periods: z.array(PeriodSummary) })
  .meta({ id: 'SpaceResponse' });

/** `sharingSelection: null` restores or starts the relationship without confirming a range (D5). */
export const CreateInvitationRequest = z
  .strictObject({ requestId: Uuid, sharingSelection: DateSelection.nullable() })
  .meta({ id: 'CreateInvitationRequest' });

/** `token` is null when the request ID was already used: the original link cannot be recovered. */
export const CreateInvitationResponse = z
  .object({ invitation: InvitationSummary, token: InvitationToken.nullable() })
  .meta({ id: 'CreateInvitationResponse' });

export const InvitationParams = z.strictObject({ inviteId: Uuid });

export const EmptyRequest = z.strictObject({});

export const RevokeInvitationResponse = z
  .object({ revoked: z.literal(true) })
  .meta({ id: 'RevokeInvitationResponse' });

export const PreviewInvitationRequest = z
  .strictObject({ token: InvitationToken })
  .meta({ id: 'PreviewInvitationRequest' });

/** What the token holder may learn before accepting; never the inviter's range (D7). */
export const PreviewInvitationResponse = z
  .object({ inviter: UserSummary, expiresAt: Timestamp, mode: z.enum(['new', 'restore']) })
  .meta({ id: 'PreviewInvitationResponse' });

export const AcceptInvitationRequest = z
  .strictObject({ token: InvitationToken, sharingSelection: DateSelection.nullable() })
  .meta({ id: 'AcceptInvitationRequest' });

export const AcceptInvitationResponse = z
  .object({ binding: BindingSummary, restored: z.boolean() })
  .meta({ id: 'AcceptInvitationResponse' });

export const UnbindRequest = z
  .strictObject({ expectedPeriodId: Uuid })
  .meta({ id: 'UnbindRequest' });

export const UnbindResponse = z
  .object({ spaceId: Uuid, closedPeriodId: Uuid })
  .meta({ id: 'UnbindResponse' });

/** The caller's own range in a space; `confirmedPeriodId` is the period it was last confirmed for. */
export const MySharingResponse = z
  .object({
    selection: DateSelection,
    revision: z.int().nonnegative(),
    confirmedPeriodId: Uuid.nullable(),
  })
  .meta({ id: 'MySharingResponse' });

export const SaveMySharingRequest = z
  .strictObject({
    requestId: Uuid,
    expectedPeriodId: Uuid,
    expectedRevision: z.int().nonnegative(),
    selection: DateSelection,
  })
  .meta({ id: 'SaveMySharingRequest' });

export const SaveMySharingResponse = z
  .object({ revision: z.int().positive(), changeId: Uuid })
  .meta({ id: 'SaveMySharingResponse' });
