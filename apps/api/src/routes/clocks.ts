import type { FastifyReply } from 'fastify';
import type { ClockService } from '../clocks/clocks.ts';
import type { ContractRequest } from './contract.ts';

// Two-clocks routes (two-clocks ADR). Run after requireUser; every write is the caller's own
// settings, never anyone else's. Answers are no-store: they say where the partner is.
export function clockHandlers(clocks: ClockService) {
  return {
    clocks(request: ContractRequest<'clocks'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return clocks.view(request.user!.id);
    },
    reportTimezone(request: ContractRequest<'reportTimezone'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return clocks.reportTimezone(request.user!.id, request.body.timezone, new Date());
    },
    saveSleep(request: ContractRequest<'saveSleep'>, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      return clocks.saveSleep(request.user!.id, request.body.sleep);
    },
  };
}
