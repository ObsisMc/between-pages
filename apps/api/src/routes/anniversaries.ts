import type { FastifyReply } from 'fastify';
import type { AnniversaryService } from '../anniversaries/anniversaries.ts';
import type { WishService } from '../wishes/wishes.ts';
import type { ContractRequest } from './contract.ts';
import { answer, userOf } from './space-records.ts';

// Anniversaries (anniversaries ADR). Run after requireUser; the author and actor are always
// the session's user, and `timezone` is only the caller's own browser zone. An
// anniversary's page lists the gifts given for it, which the wish service provides (D5).
export function anniversaryHandlers(services: {
  anniversaries: AnniversaryService;
  wishes: WishService;
}) {
  const { anniversaries, wishes } = services;

  return {
    async anniversaries(request: ContractRequest<'anniversaries'>, reply: FastifyReply) {
      return answer(
        reply,
        await anniversaries.view(userOf(request), request.query.timezone, new Date()),
      );
    },
    async anniversary(request: ContractRequest<'anniversary'>, reply: FastifyReply) {
      const caller = userOf(request);
      const { anniversaryId } = request.params;
      const gifts = await wishes.giftsFor(caller, anniversaryId);
      return answer(
        reply,
        gifts === 'NOT_FOUND'
          ? gifts
          : await anniversaries.detail(
              caller,
              anniversaryId,
              request.query.timezone,
              new Date(),
              gifts,
            ),
      );
    },
    async createAnniversary(request: ContractRequest<'createAnniversary'>, reply: FastifyReply) {
      const created = await anniversaries.create(
        userOf(request),
        request.body,
        request.query.timezone,
        new Date(),
      );
      return answer(reply, typeof created === 'string' ? created : { anniversary: created });
    },
    async editAnniversary(request: ContractRequest<'editAnniversary'>, reply: FastifyReply) {
      const edited = await anniversaries.edit(
        userOf(request),
        request.params.anniversaryId,
        request.body,
        request.query.timezone,
        new Date(),
      );
      return answer(reply, typeof edited === 'string' ? edited : { anniversary: edited });
    },
    async deleteAnniversary(request: ContractRequest<'deleteAnniversary'>, reply: FastifyReply) {
      const deleted = await anniversaries.remove(
        userOf(request),
        request.params.anniversaryId,
        request.body.requestId,
      );
      return answer(reply, deleted === true ? { deleted } : deleted);
    },
    async setAnniversaryDate(request: ContractRequest<'setAnniversaryDate'>, reply: FastifyReply) {
      const { requestId, ...date } = request.body;
      const set = await anniversaries.set(
        userOf(request),
        request.params.anniversaryId,
        { kind: 'set_date', ...date },
        requestId,
        request.query.timezone,
        new Date(),
      );
      return answer(reply, typeof set === 'string' ? set : { anniversary: set });
    },
    async setAnniversaryCount(
      request: ContractRequest<'setAnniversaryCount'>,
      reply: FastifyReply,
    ) {
      const set = await anniversaries.set(
        userOf(request),
        request.params.anniversaryId,
        { kind: 'set_count', showCount: request.body.showCount },
        request.body.requestId,
        request.query.timezone,
        new Date(),
      );
      return answer(reply, typeof set === 'string' ? set : { anniversary: set });
    },
    async saveAnniversaryReminder(
      request: ContractRequest<'saveAnniversaryReminder'>,
      reply: FastifyReply,
    ) {
      const saved = await anniversaries.saveReminder(
        userOf(request),
        request.params.anniversaryId,
        request.body.days,
        request.query.timezone,
        new Date(),
      );
      return answer(reply, typeof saved === 'string' ? saved : { anniversary: saved });
    },
  };
}
