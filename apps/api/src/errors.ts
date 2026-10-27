import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { errorStatus, type ApiErrorBody, type ErrorCode } from '@between-pages/contracts';

/**
 * A stored delta, snapshot or baseline no longer matches its sha256, or is missing
 * (kernel D9). Reported as VERSION_UNREADABLE; nothing falls back to another version.
 */
export class VersionUnreadable extends Error {}

export function sendError(reply: FastifyReply, code: ErrorCode, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(errorStatus[code]).send(body);
}

/** Nothing was opened: these diaries could not get a clean baseline (kernel D5). */
export function sendShareOpenFailed(reply: FastifyReply, dates: string[]) {
  const body: ApiErrorBody = {
    error: {
      code: 'SHARE_OPEN_FAILED',
      message: 'A diary in the range could not be prepared for sharing',
      dates,
    },
  };
  return reply.status(errorStatus.SHARE_OPEN_FAILED).send(body);
}

// Every /api/* failure we own leaves in the contract's ApiErrorBody shape
// (authentication-and-sessions D9). Internal details go to the log, never the response.
export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, 'NOT_FOUND', `No route for ${request.method} ${request.url.split('?')[0]}`),
  );
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error) || error.validation) {
      return sendError(reply, 'VALIDATION_FAILED', 'Request does not match the contract');
    }
    if (error instanceof VersionUnreadable) {
      request.log.error({ err: error }, 'stored diary state failed its check');
      return sendError(reply, 'VERSION_UNREADABLE', 'Stored diary state failed its check');
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return sendError(reply, 'VALIDATION_FAILED', error.message);
    }
    request.log.error({ err: error }, 'unhandled error');
    return sendError(reply, 'INTERNAL', 'Internal error');
  });
}
