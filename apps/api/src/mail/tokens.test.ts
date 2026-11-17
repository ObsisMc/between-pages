import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readToken, unsubscribeToken } from './tokens.ts';

// Unsubscribe tokens (email-reminders D8, invariant 9).

const key = randomBytes(32);
const user = randomUUID();

describe('unsubscribe tokens', () => {
  it('[adr:email-reminders#9] give back their own user and category only', () => {
    const token = unsubscribeToken(key, user, 'backup');
    expect(readToken(key, token)).toEqual({ userId: user, category: 'backup' });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('[adr:email-reminders#9] reject another key, any changed byte, and malformed input', () => {
    const token = unsubscribeToken(key, user, 'new_content');
    expect(readToken(randomBytes(32), token)).toBeNull();
    const bytes = Buffer.from(token, 'base64url');
    // Rewriting the category in place breaks the signature.
    const swapped = Buffer.from(
      bytes.toString('latin1').replace('new_content', 'anniversary'),
      'latin1',
    );
    expect(readToken(key, swapped.toString('base64url'))).toBeNull();
    bytes[bytes.length - 1]! ^= 1;
    expect(readToken(key, bytes.toString('base64url'))).toBeNull();
    for (const bad of ['', 'abc', `${token}=`, `${token}x`]) expect(readToken(key, bad)).toBeNull();
  });
});
