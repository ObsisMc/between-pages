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
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_REVOKED',
  'INVITE_USED',
  'SELF_INVITE',
  'ALREADY_BOUND',
  'PARTNER_FIXED',
  'PERIOD_CLOSED',
  'POLICY_CONFLICT',
  'SHARE_OPEN_FAILED',
  'GOOGLE_UNAVAILABLE',
  'GOOGLE_STATE_INVALID',
  'GOOGLE_EXCHANGE_FAILED',
  'GOOGLE_DISCONNECTING',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorBody = z
  .object({
    error: z.object({
      code: ErrorCode,
      message: z.string(),
      /** SHARE_OPEN_FAILED only: the diary dates whose clean baseline could not be built. */
      dates: z.array(z.iso.date()).optional(),
    }),
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
  INVITE_INVALID: 404,
  INVITE_EXPIRED: 409,
  INVITE_REVOKED: 409,
  INVITE_USED: 409,
  SELF_INVITE: 409,
  ALREADY_BOUND: 409,
  PARTNER_FIXED: 409,
  PERIOD_CLOSED: 409,
  POLICY_CONFLICT: 409,
  SHARE_OPEN_FAILED: 409,
  GOOGLE_UNAVAILABLE: 503,
  GOOGLE_STATE_INVALID: 400,
  GOOGLE_EXCHANGE_FAILED: 502,
  GOOGLE_DISCONNECTING: 409,
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
  // Relationship refusals (spaces-and-invitations D11): the screen explains and reloads.
  INVITE_INVALID: 'show',
  INVITE_EXPIRED: 'show',
  INVITE_REVOKED: 'show',
  INVITE_USED: 'show',
  SELF_INVITE: 'show',
  ALREADY_BOUND: 'show',
  PARTNER_FIXED: 'show',
  PERIOD_CLOSED: 'show',
  POLICY_CONFLICT: 'show',
  // Kernel D5: nothing opened; the screen names the failing dates.
  SHARE_OPEN_FAILED: 'show',
  // Google connection (server-backup-and-google-docs D10): the backup page explains and
  // offers to connect again.
  GOOGLE_UNAVAILABLE: 'show',
  GOOGLE_STATE_INVALID: 'show',
  GOOGLE_EXCHANGE_FAILED: 'show',
  GOOGLE_DISCONNECTING: 'show',
} as const satisfies Record<ErrorCode, ErrorCategory>;
