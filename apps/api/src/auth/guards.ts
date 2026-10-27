import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../errors.ts';

export interface AuthenticatedUser {
  id: string;
  displayName: string;
}

/** Resolves the caller from request headers; `null` when there is no valid session. */
export type CurrentUser = (headers: IncomingHttpHeaders) => Promise<AuthenticatedUser | null>;

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Better Auth checks Origin only on /api/auth/*; every other state-changing /api/* request
// must come from the site itself, and a missing Origin is refused too
// (authentication-and-sessions D7, invariant 7). Runs for unknown routes as well.
export function registerOriginGuard(app: FastifyInstance, publicOrigin: string) {
  const check = requireOrigin(publicOrigin);
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (!request.url.startsWith('/api/') || request.url.startsWith('/api/auth/')) return;
    return check(request, reply);
  });
}

/**
 * 403 unless `Origin` is the site itself. The WebSocket handshake is a GET, which the
 * guard above lets through, so its route runs this explicitly (invariant 7).
 */
export function requireOrigin(publicOrigin: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.origin !== publicOrigin)
      return sendError(reply, 'FORBIDDEN_ORIGIN', 'Origin is not trusted');
  };
}

/** Hook for `access: 'user'` routes: 401 without a session, else sets request.user. */
export function requireUser(currentUser: CurrentUser) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    request.user = await currentUser(request.headers);
    if (!request.user) return sendError(reply, 'UNAUTHENTICATED', 'Sign in required');
  };
}
