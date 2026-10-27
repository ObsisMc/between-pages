import type { FastifyReply } from 'fastify';
import type { ResponseOf } from '@between-pages/contracts';
import type { Binding, BindingService, Invitation, Space } from '../bindings/bindings.ts';
import { sendError } from '../errors.ts';
import type { SharingService } from '../sharing/sharing.ts';
import type { ContractRequest } from './contract.ts';

const spaceBody = (space: Space): ResponseOf<'spaces'>['spaces'][number] => ({
  ...space,
  createdAt: space.createdAt.toISOString(),
});
const bindingBody = (binding: Binding) => ({
  space: spaceBody(binding.space),
  periodId: binding.periodId,
});
const invitationBody = (invitation: Invitation) => ({
  ...invitation,
  expiresAt: invitation.expiresAt.toISOString(),
});

const MESSAGES = {
  NOT_FOUND: 'No such space or invitation',
  VALIDATION_FAILED: 'This request ID was already used with another request',
  INVITE_INVALID: 'No such invitation',
  INVITE_EXPIRED: 'The invitation has expired',
  INVITE_REVOKED: 'The invitation was revoked',
  INVITE_USED: 'The invitation was already used',
  SELF_INVITE: 'An invitation cannot be accepted by its inviter',
  ALREADY_BOUND: 'One of you is already bound',
  PARTNER_FIXED: 'The partner is fixed after the first binding',
  PERIOD_CLOSED: 'This binding period is no longer open',
  POLICY_CONFLICT: 'The sharing range changed since it was loaded',
} as const;

// Relationship and sharing range routes (spaces-and-invitations D11). Run after requireUser,
// so request.user is set; the caller comes from the session, never from the request. Every
// answer is no-store: invitation metadata and ranges are private to the caller, and a token
// must not sit in any cache (D8).
export function spaceHandlers(services: { bindings: BindingService; sharing: SharingService }) {
  const refuse = (reply: FastifyReply, code: keyof typeof MESSAGES) =>
    sendError(reply, code, MESSAGES[code]);

  return {
    async binding(request: ContractRequest<'binding'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const { binding, invitation } = await services.bindings.binding(request.user!.id, new Date());
      return {
        binding: binding && bindingBody(binding),
        invitation: invitation && invitationBody(invitation),
      };
    },

    async spaces(request: ContractRequest<'spaces'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return { spaces: (await services.bindings.spaces(request.user!.id)).map(spaceBody) };
    },

    async space(request: ContractRequest<'space'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const found = await services.bindings.space(request.user!.id, request.params.spaceId);
      if (found === 'NOT_FOUND') return refuse(reply, found);
      return {
        space: spaceBody(found.space),
        periods: found.periods.map((p) => ({
          id: p.id,
          startedAt: p.startedAt.toISOString(),
          endedAt: p.endedAt?.toISOString() ?? null,
        })),
      };
    },

    async createInvitation(request: ContractRequest<'createInvitation'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const created = await services.bindings.createInvitation(
        request.user!.id,
        request.body,
        new Date(),
      );
      if (typeof created === 'string') return refuse(reply, created);
      return { invitation: invitationBody(created.invitation), token: created.token };
    },

    async revokeInvitation(request: ContractRequest<'revokeInvitation'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const revoked = await services.bindings.revokeInvitation(
        request.user!.id,
        request.params.inviteId,
        new Date(),
      );
      if (revoked !== true) return refuse(reply, revoked);
      return { revoked: true as const };
    },

    async previewInvitation(request: ContractRequest<'previewInvitation'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const preview = await services.bindings.preview(
        request.user!.id,
        request.body.token,
        new Date(),
      );
      if (typeof preview === 'string') return refuse(reply, preview);
      return { ...preview, expiresAt: preview.expiresAt.toISOString() };
    },

    async acceptInvitation(request: ContractRequest<'acceptInvitation'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const accepted = await services.bindings.accept(request.user!.id, request.body, new Date());
      if (typeof accepted === 'string') return refuse(reply, accepted);
      return { binding: bindingBody(accepted.binding), restored: accepted.restored };
    },

    async unbind(request: ContractRequest<'unbind'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const ended = await services.bindings.unbind(
        request.user!.id,
        request.params.spaceId,
        request.body.expectedPeriodId,
        new Date(),
      );
      if (ended === 'NOT_FOUND') return refuse(reply, ended);
      return ended;
    },

    async mySharing(request: ContractRequest<'mySharing'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const mine = await services.sharing.mine(request.user!.id, request.params.spaceId);
      if (mine === 'NOT_FOUND') return refuse(reply, mine);
      return mine;
    },

    async saveMySharing(request: ContractRequest<'saveMySharing'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const saved = await services.sharing.save(
        request.user!.id,
        request.params.spaceId,
        request.body,
        new Date(),
      );
      if (typeof saved === 'string') return refuse(reply, saved);
      return saved;
    },
  };
}
