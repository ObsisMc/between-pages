import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Refresh tokens at rest (server-backup-and-google-docs D10): AES-256-GCM with a random
// 12-byte nonce, the 16-byte tag appended to the ciphertext. The key lives only in the
// environment (GOOGLE_TOKEN_KEY); `keyId` names it, so a changed key reads as "reconnect"
// rather than as a decryption error. Only the worker opens tokens (invariant 11).

export type SealedToken = { ciphertext: Uint8Array; nonce: Uint8Array; keyId: string };

/** Parses GOOGLE_TOKEN_KEY: 32 bytes, base64. */
export function tokenKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('GOOGLE_TOKEN_KEY must be 32 bytes, base64');
  return key;
}

export const keyIdOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);

export function sealToken(key: Buffer, token: string): SealedToken {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { ciphertext, nonce, keyId: keyIdOf(key) };
}

/** The token, or null when it was sealed under another key or fails its tag. */
export function openToken(key: Buffer, sealed: SealedToken): string | null {
  if (sealed.keyId !== keyIdOf(key)) return null;
  const bytes = Buffer.from(sealed.ciphertext);
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
