import type { FastifyReply } from 'fastify';
import type { AnniversaryService } from '../anniversaries/anniversaries.ts';
import { sendError } from '../errors.ts';
import type { Refusal, SpaceRecords } from '../space-records/space-records.ts';
import type { WishService } from '../wishes/wishes.ts';
import type { ContractRequest } from './contract.ts';

const MESSAGES = {
  NOT_FOUND: 'No such record of yours in this space',
  SPACE_READ_ONLY: 'The space is unbound; its records are read-only',
  RECORD_STALE: 'The record changed since it was loaded',
  RECORD_EXISTS: 'The space already has one',
  VALIDATION_FAILED: 'The request does not fit this record, or its ID was used for another',
} as const satisfies Record<Refusal, string>;

/**
 * Every space-record answer is no-store: it holds the caller's private preparations or
 * reminders. A refusal goes out as its error.
 */
export const answer = <T extends object>(reply: FastifyReply, result: T | Refusal) => {
  reply.header('cache-control', 'no-store');
  return typeof result === 'string' ? sendError(reply, result, MESSAGES[result]) : result;
};

export const userOf = (request: { user: { id: string } | null }) => request.user!.id;

// What every space feature shares (space-records D8): the entry dots and seen reports. Run
// after requireUser; the reader is always the session's user.
export function spaceRecordHandlers(services: {
  records: SpaceRecords;
  wishes: WishService;
  anniversaries: AnniversaryService;
}) {
  const { records, wishes, anniversaries } = services;
  return {
    async spaceUnread(request: ContractRequest<'spaceUnread'>, reply: FastifyReply) {
      const caller = userOf(request);
      const [wishesUnread, anniversariesUnread] = await Promise.all([
        wishes.unread(caller),
        anniversaries.unread(caller),
      ]);
      return answer(
        reply,
        wishesUnread === 'NOT_FOUND' || anniversariesUnread === 'NOT_FOUND'
          ? ('NOT_FOUND' as const)
          : { features: { wishes: wishesUnread, anniversaries: anniversariesUnread } },
      );
    },
    async reportSeen(request: ContractRequest<'reportSeen'>, reply: FastifyReply) {
      const seen = await records.seen(userOf(request), request.body.records);
      return answer(reply, seen === true ? { recorded: true as const } : seen);
    },
  };
}
