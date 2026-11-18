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

/**
 * The inviter's own invitation. `recipientEmail` is the address an addressed invitation was
 * made for, null for a link; it appears only in the inviter's answers. No state says whether
 * the address has an account or was seen (in-app-invitation-by-email D1, invariant 3).
 */
export const InvitationSummary = z
  .object({
    id: Uuid,
    expiresAt: Timestamp,
    state: z.enum(['pending', 'expired', 'revoked', 'used']),
    recipientEmail: z.string().nullable(),
  })
  .meta({ id: 'InvitationSummary' });

/**
 * An open invitation addressed to the caller's verified sign-in email, also when it cannot be
 * accepted now (D3). Never the inviter's email, range or the address itself.
 */
export const IncomingInvitation = z
  .object({
    id: Uuid,
    inviter: UserSummary,
    expiresAt: Timestamp,
    mode: z.enum(['new', 'restore']),
  })
  .meta({ id: 'IncomingInvitation' });

export const BindingResponse = z
  .object({
    binding: BindingSummary.nullable(),
    invitation: InvitationSummary.nullable(),
    /** Newest first. */
    invitationsForMe: z.array(IncomingInvitation),
  })
  .meta({ id: 'BindingResponse' });

export const SpacesResponse = z
  .object({ spaces: z.array(SpaceSummary) })
  .meta({ id: 'SpacesResponse' });

export const SpaceParams = z.strictObject({ spaceId: Uuid });

export const SpaceResponse = z
  .object({ space: SpaceSummary, periods: z.array(PeriodSummary) })
  .meta({ id: 'SpaceResponse' });

/**
 * The partner's Google sign-in address for an addressed invitation (in-app-invitation-by-email
 * D2). The server compares it trimmed and lower-cased; nothing else is folded.
 */
export const RecipientEmail = z.string().trim().pipe(z.email().max(254));

/**
 * `sharingSelection: null` restores or starts the relationship without confirming a range (D5).
 * With `recipientEmail` the invitation is addressed and has no token (in-app-invitation-by-email D1).
 */
export const CreateInvitationRequest = z
  .strictObject({
    requestId: Uuid,
    sharingSelection: DateSelection.nullable(),
    recipientEmail: RecipientEmail.optional(),
  })
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

/** A link's token, or an addressed invitation's ID, never both (in-app-invitation-by-email D4). */
export const PreviewInvitationRequest = z
  .union([z.strictObject({ token: InvitationToken }), z.strictObject({ inviteId: Uuid })])
  .meta({ id: 'PreviewInvitationRequest' });

/** What the token holder may learn before accepting; never the inviter's range (D7). */
export const PreviewInvitationResponse = z
  .object({ inviter: UserSummary, expiresAt: Timestamp, mode: z.enum(['new', 'restore']) })
  .meta({ id: 'PreviewInvitationResponse' });

export const AcceptInvitationRequest = z
  .union([
    z.strictObject({ token: InvitationToken, sharingSelection: DateSelection.nullable() }),
    z.strictObject({ inviteId: Uuid, sharingSelection: DateSelection.nullable() }),
  ])
  .meta({ id: 'AcceptInvitationRequest' });

export const DismissInvitationResponse = z
  .object({ dismissed: z.literal(true) })
  .meta({ id: 'DismissInvitationResponse' });

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
