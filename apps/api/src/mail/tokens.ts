import { createHmac, timingSafeEqual } from 'node:crypto';

// Unsubscribe tokens (email-reminders D8): base64url(userId ‖ "." ‖ category ‖ HMAC-SHA256(key,
// userId ‖ "." ‖ category)). Valid without a session, for that user and category only, and
// never expiring; what a token may do (only turn its category off) is the caller's rule.

export const CATEGORIES = ['new_content', 'anniversary', 'backup'] as const;
export type Category = (typeof CATEGORIES)[number];

const MAC_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const macOf = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest();

export function unsubscribeToken(key: Buffer, userId: string, category: Category): string {
  const payload = `${userId}.${category}`;
  return Buffer.concat([Buffer.from(payload), macOf(key, payload)]).toString('base64url');
}

/** The user and category a token was made for, or null for anything not signed with `key`. */
export function readToken(
  key: Buffer,
  token: string,
): { userId: string; category: Category } | null {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length <= MAC_BYTES || bytes.toString('base64url') !== token) return null;
  const payload = bytes.subarray(0, -MAC_BYTES).toString();
  if (!timingSafeEqual(bytes.subarray(-MAC_BYTES), macOf(key, payload))) return null;
  const [userId = '', category, ...rest] = payload.split('.');
  if (rest.length || !UUID.test(userId) || !CATEGORIES.includes(category as Category)) return null;
  return { userId, category: category as Category };
}
