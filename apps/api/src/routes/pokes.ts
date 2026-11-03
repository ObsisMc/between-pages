import type { FastifyReply } from 'fastify';
import { sendError } from '../errors.ts';
import type { PokeService } from '../pokes/pokes.ts';
import type { ContractRequest } from './contract.ts';

// The home's pokes and pets (window-mascots D4). Run after requireUser; the sender is the
// caller and the recipient their current partner, never named by the request. Answers are
// no-store.
export function pokeHandlers(pokes: PokeService) {
  return {
    pokes(request: ContractRequest<'pokes'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return pokes.waiting(request.user!.id);
    },
    async sendPoke(request: ContractRequest<'sendPoke'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const answer = await pokes.send(request.user!.id, request.body.kind, new Date());
      return answer ?? sendError(reply, 'NOT_FOUND', 'No current partner to poke');
    },
    seenPokes(request: ContractRequest<'seenPokes'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return pokes.seen(request.user!.id, request.body);
    },
  };
}
