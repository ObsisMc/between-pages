import type { FastifyReply } from 'fastify';
import type { SharedPageService } from '../shared-pages/shared-pages.ts';
import type { ContractRequest } from './contract.ts';
import { answer, userOf } from './space-records.ts';

// Shared pages (shared-pages ADR). Run after requireUser; the actor is always the session's
// user. The text goes over the collaboration socket, not through these routes.
export function sharedPageHandlers(services: { sharedPages: SharedPageService }) {
  const { sharedPages } = services;

  return {
    async sharedPages(request: ContractRequest<'sharedPages'>, reply: FastifyReply) {
      return answer(reply, await sharedPages.view(userOf(request)));
    },
    async sharedPage(request: ContractRequest<'sharedPage'>, reply: FastifyReply) {
      const view = await sharedPages.open(userOf(request), request.params.pageId);
      if (typeof view === 'string') return answer(reply, view);
      return answer(reply, {
        ...view,
        state: Buffer.from(view.state).toString('base64'),
        bindings: [...view.bindings].map(([clientId, userId]) => ({ clientId, userId })),
      });
    },
    async createSharedPage(request: ContractRequest<'createSharedPage'>, reply: FastifyReply) {
      const page = await sharedPages.create(userOf(request), request.body);
      return answer(reply, typeof page === 'string' ? page : { page });
    },
    async renameSharedPage(request: ContractRequest<'renameSharedPage'>, reply: FastifyReply) {
      const page = await sharedPages.rename(userOf(request), request.params.pageId, request.body);
      return answer(reply, typeof page === 'string' ? page : { page });
    },
    async deleteSharedPage(request: ContractRequest<'deleteSharedPage'>, reply: FastifyReply) {
      const deleted = await sharedPages.remove(
        userOf(request),
        request.params.pageId,
        request.body.requestId,
      );
      return answer(reply, deleted === true ? { deleted: true as const } : deleted);
    },
  };
}
