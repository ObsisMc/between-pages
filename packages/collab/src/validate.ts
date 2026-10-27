import * as Y from 'yjs';
import { BODY, type ClientBindings } from './doc.ts';

/** Diagnostic detail for `EDIT_REJECTED` (kernel ADR D10); never shown as user text. */
export type RejectReason =
  | 'MALFORMED_UPDATE'
  | 'FOREIGN_CLIENT_ID'
  | 'FOREIGN_DELETE'
  | 'CONTENT_NOT_ALLOWED'
  | 'CONTROL_CHARACTER'
  | 'FOREIGN_TYPE'
  | 'MISSING_DEPENDENCY';

export type BatchResult =
  | { ok: true; delta: Uint8Array; claimedClientIds: number[] }
  | { ok: false; index: number; reason: RejectReason };

// Plain text and ordinary line breaks only: `\r` and the other C0 controls would let two
// clients store the same visible text differently (spec: line breaks are normalized).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

/**
 * Checks each update of one send batch against `candidate` and applies it, so a later
 * update may depend on an earlier one in the same batch (kernel ADR D13). Each update is
 * one Yjs transaction as emitted by the `update` event; a state diff carries the whole
 * delete set, including the other author's deletions, and is rejected.
 *
 * Mutates `candidate`. On rejection it holds a prefix of the batch and must be discarded:
 * no prefix of a rejected batch may be committed (invariant 8).
 *
 * `delta` is re-encoded by Yjs from the accepted state, never the uploaded bytes, which
 * can repeat already-known items that still carry deleted private text (D3).
 * `claimedClientIds` are the unbound clientIDs this batch binds to `actor`; the caller
 * registers them in the commit transaction.
 */
export function acceptBatch(
  candidate: Y.Doc,
  updates: readonly Uint8Array[],
  actor: string,
  bindings: ClientBindings,
): BatchResult {
  const owners = new Map(bindings);
  const claimedClientIds: number[] = [];
  const deltas: Uint8Array[] = [];
  const collect = (update: Uint8Array) => deltas.push(update);
  candidate.on('update', collect);
  try {
    for (const [index, update] of updates.entries()) {
      const reason =
        checkUpdate(candidate, update, actor, owners, claimedClientIds) ??
        applyChecked(candidate, update);
      if (reason) return { ok: false, index, reason };
    }
  } finally {
    candidate.off('update', collect);
  }
  return { ok: true, delta: Y.mergeUpdates(deltas), claimedClientIds };
}

function checkUpdate(
  doc: Y.Doc,
  update: Uint8Array,
  actor: string,
  owners: Map<number, string>,
  claimed: number[],
): RejectReason | null {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    // Any decoder error means bytes no honest client produces; the reason says so.
    return 'MALFORMED_UPDATE';
  }
  const { structs, ds } = decoded;
  const known = Y.decodeStateVector(Y.encodeStateVector(doc));
  const next = new Map(known);

  for (const struct of structs) {
    const { client, clock } = struct.id;
    const end = next.get(client) ?? 0;
    // Yjs skips items it already has, and the delta never repeats them.
    if (clock + struct.length <= end) continue;
    if (clock > end) return 'MISSING_DEPENDENCY';
    const owner = owners.get(client);
    if (owner === undefined) {
      owners.set(client, actor);
      claimed.push(client);
    } else if (owner !== actor) return 'FOREIGN_CLIENT_ID';
    const reason = checkItem(struct);
    if (reason) return reason;
    next.set(client, clock + struct.length);
  }

  // References may point anywhere in this update, so they are checked once every new
  // item is known; Yjs would otherwise park the update in its pending queue.
  const exists = (id: Y.ID | null) => id === null || id.clock < (next.get(id.client) ?? 0);
  for (const struct of structs)
    if (struct instanceof Y.Item && (!exists(struct.origin) || !exists(struct.rightOrigin)))
      return 'MISSING_DEPENDENCY';

  for (const [client, ranges] of ds.clients) {
    if (owners.get(client) !== actor) return 'FOREIGN_DELETE';
    for (const { clock, len } of ranges)
      if (clock + len > (next.get(client) ?? 0)) return 'MISSING_DEPENDENCY';
  }
  return null;
}

function checkItem(struct: Y.Item | Y.GC | Y.Skip): RejectReason | null {
  if (!(struct instanceof Y.Item)) return 'CONTENT_NOT_ALLOWED';
  const { content, parentSub } = struct;
  // Decoded updates keep a root type's key as a string; the typings omit that case.
  const parent: unknown = struct.parent;
  if (content instanceof Y.ContentString) {
    if (CONTROL.test(content.str)) return 'CONTROL_CHARACTER';
  } else if (!(content instanceof Y.ContentDeleted)) return 'CONTENT_NOT_ALLOWED';
  if (parentSub !== null) return 'CONTENT_NOT_ALLOWED';
  // A null parent is inherited from an origin, which the reference check proves is in
  // the body; an explicit parent must name it, since a nested type ID or another root
  // key would add a type the diary does not have.
  if (parent !== null && parent !== BODY) return 'FOREIGN_TYPE';
  return null;
}

function applyChecked(doc: Y.Doc, update: Uint8Array): RejectReason | null {
  try {
    Y.applyUpdate(doc, update);
  } catch {
    // Bytes that decode but fail to integrate are malformed; the candidate is discarded.
    return 'MALFORMED_UPDATE';
  }
  // Last guard: nothing unverified may wait in Yjs's queue for a later update (D3).
  if (doc.store.pendingStructs || doc.store.pendingDs) return 'MISSING_DEPENDENCY';
  return null;
}
