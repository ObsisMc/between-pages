import type { FastifyReply } from 'fastify';
import { sendError } from '../errors.ts';
import type { Refusal, SpaceRecords } from '../space-records/space-records.ts';
import type { WishService } from '../wishes/wishes.ts';
import type { ContractRequest } from './contract.ts';

const MESSAGES = {
  NOT_FOUND: 'No such record of yours in this space',
  SPACE_READ_ONLY: 'The space is unbound; its records are read-only',
  RECORD_STALE: 'The record changed since it was loaded',
  VALIDATION_FAILED: 'This request ID was already used with another request',
} as const satisfies Record<Refusal, string>;

// Space-record routes: the entry dots and seen reports (space-records D8), and wishes and
// gifts (wishes-and-gifts ADR). Run after requireUser; the author and actor are always the
// session's user. Answers are no-store: they hold the caller's private preparations.
export function wishHandlers(services: { records: SpaceRecords; wishes: WishService }) {
  const { records, wishes } = services;
  const answer = <T extends object>(reply: FastifyReply, result: T | Refusal) => {
    reply.header('cache-control', 'no-store');
    return typeof result === 'string' ? sendError(reply, result, MESSAGES[result]) : result;
  };
  const userOf = (request: { user: { id: string } | null }) => request.user!.id;

  return {
    async spaceUnread(request: ContractRequest<'spaceUnread'>, reply: FastifyReply) {
      const wishesUnread = await wishes.unread(userOf(request));
      return answer(
        reply,
        wishesUnread === 'NOT_FOUND' ? wishesUnread : { features: { wishes: wishesUnread } },
      );
    },
    async reportSeen(request: ContractRequest<'reportSeen'>, reply: FastifyReply) {
      const seen = await records.seen(userOf(request), request.body.records);
      return answer(reply, seen === true ? { recorded: true as const } : seen);
    },
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
      const gift = await wishes.setGift(
        userOf(request),
        request.params.giftId,
        { kind: 'set_occasion', occasion: request.body.occasion },
        request.body.requestId,
        new Date(),
      );
      return answer(reply, typeof gift === 'string' ? gift : { gift });
    },
  };
}
