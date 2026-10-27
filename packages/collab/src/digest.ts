/**
 * Algorithms a stored batch digest may name. A retry is compared using the algorithm
 * stored on its commit row, so changing the current one never turns an old retry into a
 * `BATCH_CONFLICT` (kernel ADR D9). A new algorithm adds a member and an encoding.
 */
export type DigestAlgorithm = 1;
export const DIGEST_ALGORITHM: DigestAlgorithm = 1;

/** What a batch digest covers: its context and ordered members, not their bytes. */
export type BatchIdentity = {
  generationId: string;
  epochId: string | null;
  operations: readonly { operationId: string; updateSha256: Uint8Array }[];
};

/**
 * sha256 over the batch's canonical bytes. Web and API both call this, so the same batch
 * hashes equally on each side; JSON is never hashed because its key order and escaping
 * are not canonical.
 */
export async function batchDigest(
  batch: BatchIdentity,
  algorithm: DigestAlgorithm,
): Promise<Uint8Array> {
  return sha256(canonicalBytes(batch, algorithm));
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// Algorithm 1: the algorithm byte, then length-prefixed fields so no two batches share
// bytes — generation, an epoch flag (0 private, 1 shared) with the epoch, the member
// count, and each member's operation ID and update hash in batch order.
function canonicalBytes(batch: BatchIdentity, algorithm: DigestAlgorithm): Uint8Array<ArrayBuffer> {
  const utf8 = new TextEncoder();
  const epoch =
    batch.epochId === null
      ? [Uint8Array.of(0)]
      : [Uint8Array.of(1), field(utf8.encode(batch.epochId))];
  const parts = [
    Uint8Array.of(algorithm),
    field(utf8.encode(batch.generationId)),
    ...epoch,
    uint32(batch.operations.length),
    ...batch.operations.flatMap(({ operationId, updateSha256 }) => [
      field(utf8.encode(operationId)),
      field(updateSha256),
    ]),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function field(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  out.set(uint32(bytes.length));
  out.set(bytes, 4);
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}
