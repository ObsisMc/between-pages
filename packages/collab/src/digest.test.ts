import { describe, expect, it } from 'vitest';
import { DIGEST_ALGORITHM, batchDigest, sha256, type BatchIdentity } from './digest.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const hash = (seed: number) => new Uint8Array(32).fill(seed);

const batch: BatchIdentity = {
  generationId: '7d3c2b1a-0000-4000-8000-000000000001',
  epochId: null,
  operations: [
    { operationId: 'op-1', updateSha256: hash(1) },
    { operationId: 'op-2', updateSha256: hash(2) },
  ],
};

const digest = async (changed: Partial<BatchIdentity>) =>
  hex(await batchDigest({ ...batch, ...changed }, DIGEST_ALGORITHM));

describe('batchDigest', () => {
  it('keeps algorithm 1 byte-for-byte stable, so stored digests still match on retry', async () => {
    expect(await digest({})).toBe(
      'a101a041fd6af1ce03a229f588194ddcfc1296bbad5cfd40c25d508bc26f7e20',
    );
  });

  it('changes with the context and with the members and their order', async () => {
    const base = await digest({});
    const [first, second] = batch.operations;

    const variants = await Promise.all([
      digest({ generationId: '7d3c2b1a-0000-4000-8000-000000000002' }),
      digest({ epochId: '' }),
      digest({ epochId: 'epoch-1' }),
      digest({ operations: [second!, first!] }),
      digest({ operations: [first!] }),
      digest({ operations: [first!, { ...second!, updateSha256: hash(3) }] }),
    ]);

    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('does not let a field boundary move without changing the digest', async () => {
    const split = (left: string, right: string) =>
      digest({
        operations: [
          { operationId: left, updateSha256: hash(1) },
          { operationId: right, updateSha256: hash(1) },
        ],
      });

    expect(await split('ab', 'c')).not.toBe(await split('a', 'bc'));
  });
});

describe('sha256', () => {
  it('hashes bytes with SHA-256', async () => {
    expect(hex(await sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
