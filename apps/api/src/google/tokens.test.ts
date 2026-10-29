import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openToken, sealToken, tokenKey } from './tokens.ts';

describe('refresh tokens at rest', () => {
  const key = randomBytes(32);

  it('[adr:server-backup-and-google-docs#11] seals with a fresh nonce and opens only with the same key', () => {
    const a = sealToken(key, 'refresh-token-value');
    const b = sealToken(key, 'refresh-token-value');
    expect(Buffer.from(a.ciphertext).includes('refresh-token-value')).toBe(false);
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(openToken(key, a)).toBe('refresh-token-value');
    expect(openToken(randomBytes(32), a)).toBeNull();
  });

  it('[adr:server-backup-and-google-docs#11] refuses ciphertext that was changed', () => {
    const sealed = sealToken(key, 'refresh-token-value');
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = tampered[0]! ^ 1;
    expect(openToken(key, { ...sealed, ciphertext: tampered })).toBeNull();
  });

  it('accepts only a 32-byte key', () => {
    expect(tokenKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => tokenKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
