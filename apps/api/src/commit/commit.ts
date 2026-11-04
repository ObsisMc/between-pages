import * as Y from 'yjs';
import {
  DIGEST_ALGORITHM,
  acceptBatch,
  batchDigest,
  insertedRanges,
  sha256,
  type RejectReason,
} from '@between-pages/collab';
import type { ErrorCode } from '@between-pages/contracts';
import type { CommittedEvent } from '../events/events.ts';
import { registerBackups } from '../outbox/outbox.ts';
import type { LockedDocument, Receipt, Store } from '../store/store.ts';

export type SubmitBatch = {
  diaryId: string;
  batchId: string;
  generationId: string;
  /** The live epoch a partner writes in; absent on the owner's personal entry (kernel D7). */
  epochId?: string | undefined;
  operations: { operationId: string; update: Uint8Array<ArrayBuffer>; writtenAt: Date }[];
};

export type CommitOutcome =
  | {
      ok: true;
      receipt: Receipt;
      /** The batch had been committed before; nothing was written this time. */
      replayed: boolean;
      /** What to publish once the ACK is sent; null for a replay. */
      event: CommittedEvent | null;
    }
  | {
      ok: false;
      code: Extract<
        ErrorCode,
        | 'NOT_FOUND'
        | 'BATCH_CONFLICT'
        | 'OPERATION_ALREADY_COMMITTED'
        | 'STALE_CONTEXT'
        | 'EDIT_REJECTED'
        | 'SPACE_READ_ONLY'
      >;
      reason?: RejectReason;
      index?: number;
    };

export type ReceiptLookup = { batchId: string } | { operationId: string };

type ActiveState = { version: number; doc: Y.Doc; bindings: Map<number, string> };

/**
 * The commit chain (kernel ADR D9). Keeps each diary's accepted Yjs state in memory
 * between commits, valid only for the version it was built at: a commit takes the entry
 * out under the diary lock, uses it only if PG's version still matches, and puts it back
 * after COMMIT. Any failure leaves no entry, so the next commit reloads from PG; stale
 * memory never stands in for PG, whichever instance or crash caused the gap.
 */
export function createCommitService(store: Store) {
  const active = new Map<string, ActiveState>();

  async function activeState(locked: LockedDocument): Promise<ActiveState> {
    const { id, generationId, version } = locked.document;
    const cached = active.get(id);
    active.delete(id);
    if (cached?.version === version) return cached;
    return {
      version,
      doc: await locked.state(id, generationId, version),
      bindings: await locked.bindings(id),
    };
  }

  return {
    /**
     * Commits one send batch as one version, or reports why not; nothing is written
     * unless every operation passes (invariant 8). The receipt lookup runs under the lock,
     * so the same batch arriving on two connections at once commits once (D9 step 3).
     * Throws on PG failure or lock timeout (INTERNAL, retry) and VersionUnreadable.
     */
    async commit(actor: string, batch: SubmitBatch): Promise<CommitOutcome> {
      const updates = batch.operations.map((op) => op.update);
      const hashes = await Promise.all(updates.map((update) => sha256(update)));
      const identity = {
        generationId: batch.generationId,
        epochId: batch.epochId ?? null,
        operations: batch.operations.map((op, i) => ({
          operationId: op.operationId,
          updateSha256: hashes[i]!,
        })),
      };
      const digest = await batchDigest(identity, DIGEST_ALGORITHM);
      let accepted: ActiveState | undefined;

      const outcome = await store
        .withDocumentLock(batch.diaryId, async (locked): Promise<CommitOutcome> => {
          const { document: diary } = locked;
          const { page } = diary;
          const isOwner = diary.ownerId === actor;
          // Someone the diary was never shared with sees it as missing (D10). A former
          // recipient keeps their receipts, so a batch of theirs committed before the
          // share froze still replays below; so do the two people of a page.
          const known = page
            ? page.participants.includes(actor)
            : isOwner || (await locked.epochs.recipientEpochs(diary.id, actor)).length > 0;
          if (!known) return { ok: false, code: 'NOT_FOUND' };

          const committed = await locked.batch(diary.id, batch.batchId);
          if (committed) {
            // Compared with the algorithm stored on the commit, so a retry still matches
            // after the current one changes (D9). Only algorithm 1 exists; another value
            // was written by a newer server this one cannot check against.
            if (committed.digestAlgorithm !== DIGEST_ALGORITHM)
              throw new Error(`digest algorithm ${committed.digestAlgorithm} is unknown`);
            const same =
              committed.authorId === actor && Buffer.from(digest).equals(committed.batchDigest);
            return same
              ? { ok: true, receipt: committed.receipt, replayed: true, event: null }
              : { ok: false, code: 'BATCH_CONFLICT' };
          }
          const operationIds = batch.operations.map((op) => op.operationId);
          if ((await locked.committedOperations(diary.id, actor, operationIds)).length)
            return { ok: false, code: 'OPERATION_ALREADY_COMMITTED' };
          // The owner writes through the personal entry, a partner only in the live epoch
          // they opened; an old share's request never turns into a personal one (D7). The
          // diary lock orders this check against freezing: a batch either commits inside
          // the epoch, before it froze, or is refused (invariant 16).
          // A page has no epochs: the open binding decides (shared-pages D7), and the lock
          // order holds it, so a commit lands before unbinding or is refused.
          if (page?.deleted) return { ok: false, code: 'NOT_FOUND' };
          if (page && !page.open) return { ok: false, code: 'SPACE_READ_ONLY' };
          const live = page
            ? null
            : ((await locked.epochs.liveEpochs([diary.id])).get(diary.id) ?? null);
          const allowed =
            page || isOwner
              ? batch.epochId === undefined
              : live?.recipientId === actor && batch.epochId === live.id;
          if (!allowed || batch.generationId !== diary.generationId)
            return { ok: false, code: 'STALE_CONTEXT' };

          const state = await activeState(locked);
          const before = Y.encodeStateVector(state.doc);
          const result = acceptBatch(state.doc, updates, actor, state.bindings);
          // The rejected candidate holds a prefix of the batch; it is already out of the
          // cache and is dropped here.
          if (!result.ok)
            return { ok: false, code: 'EDIT_REJECTED', reason: result.reason, index: result.index };

          const { version, receipt } = await locked.insertCommit({
            batchId: batch.batchId,
            authorId: actor,
            generationId: batch.generationId,
            epochId: live?.id ?? null,
            batchDigest: digest,
            digestAlgorithm: DIGEST_ALGORITHM,
            delta: result.delta,
            operations: batch.operations.map((op, i) => ({
              operationId: op.operationId,
              updateSha256: hashes[i]!,
              writtenAt: op.writtenAt,
            })),
            ranges: insertedRanges(before, updates),
            claimedClientIds: result.claimedClientIds,
            state: () => Y.encodeStateAsUpdate(state.doc),
          });
          if (page) await locked.notePageWritten(page, actor, batch.batchId, digest);
          else await registerBackups(locked, version, live);
          for (const clientId of result.claimedClientIds) state.bindings.set(clientId, actor);
          accepted = { ...state, version };
          return {
            ok: true,
            receipt,
            replayed: false,
            event: {
              type: 'commit',
              diaryId: diary.id,
              generationId: receipt.generationId,
              epochId: live?.id ?? null,
              seq: receipt.seq,
              publicId: receipt.publicId,
              delta: result.delta,
              bindings: result.claimedClientIds.map((clientId) => ({ clientId, userId: actor })),
            },
          };
        })
        .catch((error: unknown) => {
          active.delete(batch.diaryId);
          throw error;
        });
      // Only now has PG committed; the entry is reusable for the next version.
      if (accepted) active.set(batch.diaryId, accepted);
      return outcome ?? { ok: false, code: 'NOT_FOUND' };
    },

    /**
     * The caller's committed batch with this batch ID or containing this operation ID;
     * `null` when nothing is committed under it (D10). Stays answerable forever, because a
     * device offline for long can come back with old batches to reconcile.
     */
    async receipt(
      actor: string,
      diaryId: string,
      lookup: ReceiptLookup,
    ): Promise<Receipt | null | 'NOT_FOUND'> {
      return store.read(async (queries) => {
        const participants = await queries.pageParticipants(diaryId);
        if (participants) {
          if (!participants.includes(actor)) return 'NOT_FOUND';
        } else {
          const diary = await queries.findDiary(diaryId);
          if (!diary) return 'NOT_FOUND';
          if (
            diary.ownerId !== actor &&
            !(await queries.epochs.recipientEpochs(diaryId, actor)).length
          )
            return 'NOT_FOUND';
        }
        if ('operationId' in lookup)
          return queries.receiptByOperation(diaryId, actor, lookup.operationId);
        const committed = await queries.batch(diaryId, lookup.batchId);
        return committed?.authorId === actor ? committed.receipt : null;
      });
    },
  };
}

export type CommitService = ReturnType<typeof createCommitService>;
