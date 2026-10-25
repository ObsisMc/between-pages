import { z } from 'zod';

// One error shape for every /api/* route we own (authentication-and-sessions D9).
// `message` is an English note for developers; screens choose their text from `code`.
export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN_ORIGIN',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INTERNAL',
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
} as const satisfies Record<ErrorCode, number>;
