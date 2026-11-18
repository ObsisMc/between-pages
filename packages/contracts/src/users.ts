import { z } from 'zod';

// What one member may learn about a user. Never add last-seen time or login data here
// (authentication-and-sessions invariant 9). `displayName` stays a plain string: names
// stored before the display-name rules, or taken from Google at first sign-in, still read.
export const UserSummary = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
  })
  .meta({ id: 'UserSummary' });

/** Why a name was refused, in each issue's `params.reason`, so screens can say it in words. */
export type DisplayNameRefusal = 'empty' | 'control' | 'invisible' | 'long';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (value: string) => [...segmenter.segment(value)].length;
const refused = (reason: DisplayNameRefusal, message: string) => ({ message, params: { reason } });

/**
 * A name someone gives themself (display-name D2, invariant 2): trimmed, 1–20 graphemes, no
 * control character or line separator, and something visible once whitespace and format
 * characters (zero-width joiners, direction marks) are gone. The parsed value is the trimmed
 * name, which is what gets stored.
 */
export const DisplayName = z
  .string()
  .trim()
  .refine((name) => name.length > 0, refused('empty', 'must not be empty'))
  .refine(
    (name) => !/[\p{Cc}\u2028\u2029]/u.test(name),
    refused('control', 'must not contain control characters'),
  )
  .refine(
    (name) => name.length === 0 || /[^\s\p{Cf}]/u.test(name),
    refused('invisible', 'must contain a visible character'),
  )
  .refine((name) => graphemes(name) <= 20, refused('long', 'at most 20 graphemes'))
  .meta({ id: 'DisplayName' });

/** `PATCH /api/me`: only the caller's own name; nothing names a user (D7, invariant 1). */
export const UpdateMeRequest = z
  .strictObject({ displayName: DisplayName })
  .meta({ id: 'UpdateMeRequest' });
