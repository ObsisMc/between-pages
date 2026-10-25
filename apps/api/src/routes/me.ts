import type { FastifyRequest } from 'fastify';
import type { ResponseOf } from '@between-pages/contracts';

// Runs only after requireUser, so request.user is set. Returns the contract's UserSummary:
// no email, login method or last-seen time (authentication-and-sessions D9, invariant 9).
export function meHandler(request: FastifyRequest): ResponseOf<'me'> {
  const user = request.user!;
  return { user: { id: user.id, displayName: user.displayName } };
}
