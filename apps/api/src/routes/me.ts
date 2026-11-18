import type { FastifyRequest } from 'fastify';
import type { ResponseOf } from '@between-pages/contracts';
import type { DisplayNameService } from '../display-name/display-name.ts';
import type { ContractRequest } from './contract.ts';

// Runs only after requireUser, so request.user is set. Returns the contract's UserSummary:
// no email, login method or last-seen time (authentication-and-sessions D9, invariant 9).
export function meHandler(request: FastifyRequest): ResponseOf<'me'> {
  const user = request.user!;
  return { user: { id: user.id, displayName: user.displayName } };
}

/** Renames only the session's user; the body has no field that names anyone (display-name D7). */
export function updateMeHandler(names: DisplayNameService) {
  return (request: ContractRequest<'updateMe'>) =>
    names.rename(request.user!.id, request.body.displayName);
}
