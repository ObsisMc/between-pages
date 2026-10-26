import { z } from 'zod';

// One error shape for every /api/* route we own (authentication-and-sessions D9).
// `message` is an English note for developers; screens choose their text from `code`.
export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN_ORIGIN',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INTERNAL',
  'STALE_CONTEXT',
  'OPERATION_ALREADY_COMMITTED',
  'EDIT_REJECTED',
  'BATCH_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'PROTOCOL_UNSUPPORTED',
  'VERSION_UNREADABLE',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorBody = z
  .object({
    error: z.object({ code: ErrorCode, message: z.string() }),
  })
  .meta({ id: 'ApiErrorBody' });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const errorStatus = {
  UNAUTHENTICATED: 401,
  FORBIDDEN_ORIGIN: 403,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  INTERNAL: 500,
  STALE_CONTEXT: 409,
  OPERATION_ALREADY_COMMITTED: 409,
  EDIT_REJECTED: 422,
  BATCH_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  PROTOCOL_UNSUPPORTED: 400,
  VERSION_UNREADABLE: 500,
} as const satisfies Record<ErrorCode, number>;

/**
 * What a client does on each code (kernel ADR D10); clients branch on the category, never
 * on individual codes. retry: resend the same batch with backoff. reconcile: query the
 * receipt before deciding whether pending input becomes a recovery draft. stop: halt this
 * batch and every later one, keeping their text. reauth: pause sync until the same account
 * signs in again. upgrade: keep the local journal and ask for a reload. show: display it.
 */
export const ErrorCategory = z.enum(['retry', 'reconcile', 'stop', 'reauth', 'upgrade', 'show']);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

export const errorCategory = {
  UNAUTHENTICATED: 'reauth',
  FORBIDDEN_ORIGIN: 'show',
  VALIDATION_FAILED: 'stop',
  NOT_FOUND: 'show',
  INTERNAL: 'retry',
  STALE_CONTEXT: 'reconcile',
  OPERATION_ALREADY_COMMITTED: 'reconcile',
  EDIT_REJECTED: 'stop',
  BATCH_CONFLICT: 'stop',
  PAYLOAD_TOO_LARGE: 'stop',
  PROTOCOL_UNSUPPORTED: 'upgrade',
  VERSION_UNREADABLE: 'show',
} as const satisfies Record<ErrorCode, ErrorCategory>;
