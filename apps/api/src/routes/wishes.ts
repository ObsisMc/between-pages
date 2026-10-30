import type { FastifyReply } from 'fastify';
import type { AnniversaryService } from '../anniversaries/anniversaries.ts';
import type { WishService } from '../wishes/wishes.ts';
import type { ContractRequest } from './contract.ts';
import { answer, userOf } from './space-records.ts';

// Wishes and gifts (wishes-and-gifts ADR). Run after requireUser; the author and actor are
// always the session's user. A gift's occasion may be an anniversary, which the
// anniversaries service checks and names before the wish service stores it (D4).
export function wishHandlers(services: { wishes: WishService; anniversaries: AnniversaryService }) {
  const { wishes, anniversaries } = services;

  return {
    async wishes(request: ContractRequest<'wishes'>, reply: FastifyReply) {
      return answer(reply, await wishes.view(userOf(request)));
    },
    async createWish(request: ContractRequest<'createWish'>, reply: FastifyReply) {
      const wish = await wishes.createWish(userOf(request), request.body);
      return answer(reply, typeof wish === 'string' ? wish : { wish });
    },
    async editWish(request: ContractRequest<'editWish'>, reply: FastifyReply) {
      const wish = await wishes.editWish(userOf(request), request.params.wishId, request.body);
      return answer(reply, typeof wish === 'string' ? wish : { wish });
    },
    async deleteWish(request: ContractRequest<'deleteWish'>, reply: FastifyReply) {
      const deleted = await wishes.deleteWish(
        userOf(request),
        request.params.wishId,
        request.body.requestId,
      );
      return answer(reply, deleted === true ? { deleted } : deleted);
    },
    async receiveWish(request: ContractRequest<'receiveWish'>, reply: FastifyReply) {
      return answer(
        reply,
        await wishes.receiveWish(
          userOf(request),
          request.params.wishId,
          request.body.requestId,
          new Date(),
        ),
      );
    },
    async prepareGift(request: ContractRequest<'prepareGift'>, reply: FastifyReply) {
      const gift = await wishes.prepareGift(userOf(request), request.body);
      return answer(reply, typeof gift === 'string' ? gift : { gift });
    },
    async editGift(request: ContractRequest<'editGift'>, reply: FastifyReply) {
      const gift = await wishes.editGift(userOf(request), request.params.giftId, request.body);
      return answer(reply, typeof gift === 'string' ? gift : { gift });
    },
    async deleteGift(request: ContractRequest<'deleteGift'>, reply: FastifyReply) {
      const deleted = await wishes.deleteGift(
        userOf(request),
        request.params.giftId,
        request.body.requestId,
      );
      return answer(reply, deleted === true ? { deleted } : deleted);
    },
    async revealGift(request: ContractRequest<'revealGift'>, reply: FastifyReply) {
      const gift = await wishes.revealGift(
        userOf(request),
        request.params.giftId,
        request.body.requestId,
        new Date(),
      );
      return answer(reply, typeof gift === 'string' ? gift : { gift });
    },
    async saveGiftCard(request: ContractRequest<'saveGiftCard'>, reply: FastifyReply) {
      const gift = await wishes.saveCard(userOf(request), request.params.giftId, request.body);
      return answer(reply, typeof gift === 'string' ? gift : { gift });
    },
    async setGiftDate(request: ContractRequest<'setGiftDate'>, reply: FastifyReply) {
      const gift = await wishes.setGift(
        userOf(request),
        request.params.giftId,
        { kind: 'set_date', date: request.body.date },
        request.body.requestId,
        new Date(),
      );
      return answer(reply, typeof gift === 'string' ? gift : { gift });
    },
    async setGiftOccasion(request: ContractRequest<'setGiftOccasion'>, reply: FastifyReply) {
      const caller = userOf(request);
      const { occasion, anniversaryId, requestId } = request.body;
      const anniversary =
        anniversaryId === null ? null : await anniversaries.occasion(caller, anniversaryId);
      if (anniversary === 'NOT_FOUND') return answer(reply, anniversary);
      const gift = await wishes.setGift(
        caller,
        request.params.giftId,
        { kind: 'set_occasion', occasion, anniversary },
        requestId,
        new Date(),
      );
      return answer(reply, typeof gift === 'string' ? gift : { gift });
    },
  };
}
