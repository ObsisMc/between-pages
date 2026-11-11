import type { ClientBinding, CommitReceipt } from '@between-pages/contracts';
import * as Y from 'yjs';
import { request, transact } from './idb.ts';

// The app-managed local journal of kernel ADR D7: one IndexedDB database per account
// holding the confirmed baseline, pending operations, the send batch, receipts and
// recovery drafts of each diary. Every state change is one transaction, so a crash leaves
// either the old state or the new one.

/** Bumped only with a forward migration in `upgrade`; open tabs on the old one stop (D10). */
export const JOURNAL_SCHEMA_VERSION = 1;

/** Soft batch limits (D13): they decide how much a batch holds, an oversized operation still goes alone. */
export const BATCH_MAX_OPERATIONS = 100;
export const BATCH_SOFT_BYTES = 64 * 1024;

/**
 * The confirmed state of one diary generation. Every commit up to `seq` is in `state`;
 * so may be this account's later commits, acknowledged before the ones between arrived.
 */
export type Baseline = {
  diaryId: string;
  generationId: string;
  /** The partner's live epoch this copy belongs to; absent on the owner's own diary. */
  epochId?: string;
  /** A shared page's document, which can be deleted under its writer (shared-pages D7). */
  page?: true;
  /**
   * A shared page's binding period, absent while unbound. Part of the context: input
   * written in one period is never sent in another, it becomes drafts (shared-pages D4).
   */
  periodId?: string;
  seq: number;
  /** A Yjs update holding the whole state. */
  state: Uint8Array;
  bindings: ClientBinding[];
};

/** An editor operation as the journal keeps it; `intent` is stored for drafts, never read. */
export type JournalOperation<Intent> = {
  operationId: string;
  update: Uint8Array;
  writtenAt: Date;
  intent: Intent;
};

export type PendingOperation<Intent> = JournalOperation<Intent> & {
  diaryId: string;
  generationId: string;
  /** Shared by every tab of the account; the order operations are sent in (D7). */
  localSequence: number;
};

/** A send batch exactly as it is sent and every time it is resent (invariant 9). */
export type SendBatch = {
  diaryId: string;
  batchId: string;
  generationId: string;
  /** The context it was written in, kept with the batch: the partner's epoch (kernel D7). */
  epochId?: string;
  operations: { localSequence: number; operationId: string; update: Uint8Array; writtenAt: Date }[];
};

export type DraftReason =
  /** The server refused the batch it was in, or one before it (a `stop` error). */
  | 'rejected'
  /** It was written against a generation that is no longer current. */
  | 'stale-generation';

/** Input that will not reach the text; kept until the user deletes it (D7, invariant 20). */
export type Draft<Intent> = {
  draftId: string;
  diaryId: string;
  generationId: string;
  reason: DraftReason;
  savedAt: Date;
  /** Where the input stood in the account's order; drafts are listed in it. */
  localSequence: number;
  operationId: string;
  writtenAt: Date;
  intent: Intent;
};

export type JournalState<Intent> = {
  baseline: Baseline | null;
  pending: PendingOperation<Intent>[];
  batch: SendBatch | null;
};

/** The database was upgraded by a newer tab, or closed; this instance must not write. */
export class JournalUnavailable extends Error {}

export type Journal<Intent = unknown> = {
  load(diaryId: string): Promise<JournalState<Intent>>;
  /**
   * Takes the server's state of the diary when it is newer and returns the baseline now
   * stored. A different generation or epoch throws: that is `switchTo`.
   */
  install(server: Baseline): Promise<Baseline>;
  /**
   * Moves the diary to the server's state in another generation or epoch (kernel D7
   * "切换起点"): asks `receiptOf` whether the unconfirmed batch was committed; committed
   * input is saved and dropped, every other pending operation becomes a draft, and the new
   * baseline is installed, all in one transaction. If the queue changed while the receipt
   * was fetched, that transaction is abandoned and the switch starts over. Returns the
   * drafts made; in the same generation and epoch it is `install`, returning none. A
   * receipt that cannot be fetched throws and changes nothing.
   */
  switchTo(
    server: Baseline,
    receiptOf: (batchId: string) => Promise<CommitReceipt | null>,
  ): Promise<Draft<Intent>[]>;
  /**
   * As `switchTo` for a context that ended without a next one, such as a share that froze:
   * the queue is settled the same way and the baseline stays. Returns the drafts made.
   */
  retire(
    diaryId: string,
    receiptOf: (batchId: string) => Promise<CommitReceipt | null>,
  ): Promise<Draft<Intent>[]>;
  /**
   * Stores one operation behind the last one. Written against a generation that is no
   * longer current, it becomes a draft instead and is never sent (D7, old tabs).
   */
  append(
    diaryId: string,
    generationId: string,
    operation: JournalOperation<Intent>,
  ): Promise<'pending' | 'draft'>;
  /** The unconfirmed batch, or a new one formed from pending operations; null when idle. */
  nextBatch(diaryId: string): Promise<SendBatch | null>;
  /** The server committed the batch: its operations leave pending and join the baseline. */
  confirm(diaryId: string, receipt: CommitReceipt): Promise<void>;
  /** Applies committed deltas in seq order, up to the first gap; returns the baseline seq. */
  advance(
    diaryId: string,
    generationId: string,
    commits: { seq: number; delta: Uint8Array }[],
    bindings: ClientBinding[],
  ): Promise<number>;
  /**
   * Turns the batch, and every pending operation that may build on it, into drafts and
   * returns them. Operations of another editor instance that touch none of that text stay.
   */
  reject(diaryId: string, batchId: string, reason: DraftReason): Promise<Draft<Intent>[]>;
  drafts(diaryId: string): Promise<Draft<Intent>[]>;
  /** The shared pages this device holds a copy of, for input left on a deleted one. */
  pages(): Promise<string[]>;
  deleteDraft(draftId: string): Promise<void>;
  close(): void;
};

type RefusedRange = { client: number; from: number; to: number };
type BaselineRecord = Baseline & {
  nextSequence: number;
  /** Characters of refused input; anything building on them becomes a draft too. */
  refused?: RefusedRange[];
};
type ReceiptRecord = CommitReceipt & { diaryId: string };

const BASELINES = 'baselines';
const PENDING = 'pending';
const BATCHES = 'batches';
const RECEIPTS = 'receipts';
const DRAFTS = 'drafts';

export const journalName = (userId: string) => `between-pages-journal:${userId}`;

const ofDiary = (diaryId: string) => IDBKeyRange.bound([diaryId, -Infinity], [diaryId, Infinity]);
const receiptsOf = (diaryId: string) => IDBKeyRange.bound([diaryId, ''], [diaryId, '￿']);

function upgrade(db: IDBDatabase, oldVersion: number) {
  if (oldVersion < 1) {
    db.createObjectStore(BASELINES, { keyPath: 'diaryId' });
    db.createObjectStore(PENDING, { keyPath: ['diaryId', 'localSequence'] });
    db.createObjectStore(BATCHES, { keyPath: 'diaryId' });
    db.createObjectStore(RECEIPTS, { keyPath: ['diaryId', 'batchId'] });
    db.createObjectStore(DRAFTS, { keyPath: 'draftId' }).createIndex('diaryId', 'diaryId');
  }
}

/** Opens the account's journal; one database per user ID, so no code path reads another's. */
export async function openJournal<Intent = unknown>(userId: string): Promise<Journal<Intent>> {
  const open = indexedDB.open(journalName(userId), JOURNAL_SCHEMA_VERSION);
  open.onupgradeneeded = (event) => upgrade(open.result, event.oldVersion);
  const db = await request(open);
  let available = true;
  db.onversionchange = () => {
    available = false;
    db.close();
  };
  // Lowers the chance that the browser evicts unsent text (D7); the answer changes nothing here.
  void navigator.storage?.persist?.().catch(() => undefined);

  const run = <T>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> => {
    if (!available)
      return Promise.reject(new JournalUnavailable('The journal was upgraded or closed'));
    return transact(db, stores, mode, body);
  };

  const baselineOf = async (tx: IDBTransaction, diaryId: string) => {
    const record = await request<BaselineRecord | undefined>(
      tx.objectStore(BASELINES).get(diaryId),
    );
    if (!record) throw new Error(`No baseline for diary ${diaryId}`);
    return record;
  };

  const toDrafts = (tx: IDBTransaction, ops: PendingOperation<Intent>[], reason: DraftReason) => {
    const savedAt = new Date();
    const drafts = ops.map((op) => draftOf(op, reason, savedAt));
    for (const draft of drafts) tx.objectStore(DRAFTS).put(draft);
    return drafts;
  };

  const install = (server: Baseline) =>
    run([BASELINES, RECEIPTS], 'readwrite', async (tx) => {
      const store = tx.objectStore(BASELINES);
      const current = await request<BaselineRecord | undefined>(store.get(server.diaryId));
      if (!current) {
        store.put({ ...server, nextSequence: 1 } satisfies BaselineRecord);
        return server;
      }
      if (!sameContext(current, server))
        throw new Error('The diary moved to a new generation or epoch');
      const next: BaselineRecord = {
        ...current,
        bindings: unionBindings(current.bindings, server.bindings),
      };
      if (server.seq > current.seq) {
        next.state = Y.mergeUpdates([current.state, server.state]);
        next.seq = await skipOwn(tx, server.diaryId, server.seq);
      }
      store.put(next);
      return baselineFrom(next);
    });

  /** What a switch decides on: the context and the exact queue it saw. */
  const queueOf = async (tx: IDBTransaction, diaryId: string) => {
    const record = await request<BaselineRecord | undefined>(
      tx.objectStore(BASELINES).get(diaryId),
    );
    const pending = await request<PendingOperation<Intent>[]>(
      tx.objectStore(PENDING).getAll(ofDiary(diaryId)),
    );
    const batch = await request<SendBatch | undefined>(tx.objectStore(BATCHES).get(diaryId));
    const key = `${batch?.batchId ?? ''}:${pending.map((op) => op.localSequence).join()}`;
    return { record, pending, batch, key };
  };

  /**
   * Settles the queue of a context that ended (kernel D7): committed input of the
   * unconfirmed batch is dropped as saved, the rest becomes drafts, and `next` (another
   * context) is installed in the same transaction; null keeps the baseline as it is.
   */
  async function reconcile(
    diaryId: string,
    receiptOf: (batchId: string) => Promise<CommitReceipt | null>,
    next: Baseline | null,
  ): Promise<Draft<Intent>[]> {
    const settled = (record: BaselineRecord | undefined) =>
      next ? !record || sameContext(record, next) : !record;
    for (;;) {
      const seen = await run([BASELINES, PENDING, BATCHES], 'readonly', (tx) =>
        queueOf(tx, diaryId),
      );
      if (settled(seen.record)) {
        if (next) await install(next);
        return [];
      }
      if (!next && !seen.batch && !seen.pending.length) return [];
      // Outside any transaction: IndexedDB commits a transaction left idle over a fetch.
      const receipt = seen.batch ? await receiptOf(seen.batch.batchId) : null;
      const drafts = await run(
        [BASELINES, PENDING, BATCHES, RECEIPTS, DRAFTS],
        'readwrite',
        async (tx) => {
          const now = await queueOf(tx, diaryId);
          if (now.key !== seen.key || settled(now.record)) return null;
          const saved = new Set(receipt ? now.batch!.operations.map((op) => op.localSequence) : []);
          for (const op of now.pending) tx.objectStore(PENDING).delete([diaryId, op.localSequence]);
          tx.objectStore(BATCHES).delete(diaryId);
          tx.objectStore(RECEIPTS).delete(receiptsOf(diaryId));
          if (next)
            tx.objectStore(BASELINES).put({
              ...next,
              nextSequence: now.record!.nextSequence,
            } satisfies BaselineRecord);
          return toDrafts(
            tx,
            now.pending.filter((op) => !saved.has(op.localSequence)),
            'stale-generation',
          );
        },
      );
      if (drafts) return drafts;
    }
  }

  return {
    load: (diaryId) =>
      run([BASELINES, PENDING, BATCHES], 'readonly', async (tx) => {
        const record = await request<BaselineRecord | undefined>(
          tx.objectStore(BASELINES).get(diaryId),
        );
        const pending = await request<PendingOperation<Intent>[]>(
          tx.objectStore(PENDING).getAll(ofDiary(diaryId)),
        );
        const batch = await request<SendBatch | undefined>(tx.objectStore(BATCHES).get(diaryId));
        return { baseline: record ? baselineFrom(record) : null, pending, batch: batch ?? null };
      }),

    install,

    switchTo: (server, receiptOf) => reconcile(server.diaryId, receiptOf, server),

    retire: (diaryId, receiptOf) => reconcile(diaryId, receiptOf, null),

    append: (diaryId, generationId, operation) =>
      run([BASELINES, PENDING, DRAFTS], 'readwrite', async (tx) => {
        const baseline = await baselineOf(tx, diaryId);
        const localSequence = baseline.nextSequence;
        const pending: PendingOperation<Intent> = {
          ...operation,
          diaryId,
          generationId,
          localSequence,
        };
        const next: BaselineRecord = { ...baseline, nextSequence: localSequence + 1 };
        // Rechecked inside the write: a tab still showing an old generation must not
        // queue its input for the new one (D7, old tabs).
        if (baseline.generationId !== generationId) {
          tx.objectStore(BASELINES).put(next);
          toDrafts(tx, [pending], 'stale-generation');
          return 'draft';
        }
        // Input the editor made before it was rebuilt without refused text can still build
        // on it; queued, it would take whatever batch it joins down with it.
        const refused = new Refused(baseline.refused);
        if (refused.touchedBy(operation.update)) {
          refused.add(operation.update);
          tx.objectStore(BASELINES).put({ ...next, refused: refused.ranges });
          toDrafts(tx, [pending], 'rejected');
          return 'draft';
        }
        tx.objectStore(BASELINES).put(next);
        tx.objectStore(PENDING).put(pending);
        return 'pending';
      }),

    nextBatch: (diaryId) =>
      run([BASELINES, PENDING, BATCHES], 'readwrite', async (tx) => {
        const existing = await request<SendBatch | undefined>(tx.objectStore(BATCHES).get(diaryId));
        if (existing) return existing;
        const candidates = await request<PendingOperation<Intent>[]>(
          tx.objectStore(PENDING).getAll(ofDiary(diaryId), BATCH_MAX_OPERATIONS),
        );
        const first = candidates[0];
        if (!first) return null;
        const members: SendBatch['operations'] = [];
        let bytes = 0;
        for (const op of candidates) {
          if (op.generationId !== first.generationId) break;
          bytes += op.update.byteLength;
          if (members.length > 0 && bytes > BATCH_SOFT_BYTES) break;
          const { localSequence, operationId, update, writtenAt } = op;
          members.push({ localSequence, operationId, update, writtenAt });
        }
        const baseline = await request<BaselineRecord | undefined>(
          tx.objectStore(BASELINES).get(diaryId),
        );
        const batch: SendBatch = {
          diaryId,
          batchId: crypto.randomUUID(),
          generationId: first.generationId,
          ...(baseline?.epochId ? { epochId: baseline.epochId } : {}),
          operations: members,
        };
        tx.objectStore(BATCHES).put(batch);
        return batch;
      }),

    confirm: (diaryId, receipt) =>
      run([BASELINES, PENDING, BATCHES, RECEIPTS], 'readwrite', async (tx) => {
        const batch = await request<SendBatch | undefined>(tx.objectStore(BATCHES).get(diaryId));
        if (!batch || batch.batchId !== receipt.batchId)
          throw new Error(`Batch ${receipt.batchId} is not the diary's unconfirmed batch`);
        const baseline = await baselineOf(tx, diaryId);
        if (baseline.generationId !== receipt.generationId)
          throw new Error('The receipt belongs to another generation');
        for (const op of batch.operations)
          tx.objectStore(PENDING).delete([diaryId, op.localSequence]);
        tx.objectStore(BATCHES).delete(diaryId);
        const updates = batch.operations.map((op) => op.update);
        // The ACK means the server bound every clientID that inserted text in the batch to
        // this account (the journal's owner), so their author is known before the broadcast.
        const own = updates.flatMap((u) => [...Y.parseUpdateMeta(u).from.keys()]);
        const next: BaselineRecord = {
          ...baseline,
          state: Y.mergeUpdates([baseline.state, ...updates]),
          bindings: unionBindings(
            baseline.bindings,
            own.map((clientId) => ({ clientId, userId })),
          ),
        };
        tx.objectStore(RECEIPTS).put({ ...receipt, diaryId } satisfies ReceiptRecord);
        next.seq = await skipOwn(tx, diaryId, baseline.seq);
        tx.objectStore(BASELINES).put(next);
      }),

    advance: (diaryId, generationId, commits, bindings) =>
      run([BASELINES, RECEIPTS], 'readwrite', async (tx) => {
        const baseline = await baselineOf(tx, diaryId);
        if (baseline.generationId !== generationId) return baseline.seq;
        const updates: Uint8Array[] = [];
        let seq = baseline.seq;
        for (const commit of [...commits].sort((a, b) => a.seq - b.seq)) {
          if (commit.seq <= seq) continue;
          seq = await skipOwn(tx, diaryId, seq);
          if (commit.seq <= seq) continue;
          if (commit.seq !== seq + 1) break;
          updates.push(commit.delta);
          seq = commit.seq;
        }
        seq = await skipOwn(tx, diaryId, seq);
        tx.objectStore(BASELINES).put({
          ...baseline,
          state: updates.length ? Y.mergeUpdates([baseline.state, ...updates]) : baseline.state,
          seq,
          bindings: unionBindings(baseline.bindings, bindings),
        } satisfies BaselineRecord);
        return seq;
      }),

    reject: (diaryId, batchId, reason) =>
      run([BASELINES, PENDING, BATCHES, DRAFTS], 'readwrite', async (tx) => {
        const batch = await request<SendBatch | undefined>(tx.objectStore(BATCHES).get(diaryId));
        if (!batch || batch.batchId !== batchId)
          throw new Error(`Batch ${batchId} is not the diary's unconfirmed batch`);
        const pending = await request<PendingOperation<Intent>[]>(
          tx.objectStore(PENDING).getAll(ofDiary(diaryId)),
        );
        const members = new Set(batch.operations.map((op) => op.localSequence));
        const baseline = await baselineOf(tx, diaryId);
        const refused = new Refused(baseline.refused);
        const drafted = pending.filter((op) => {
          if (!members.has(op.localSequence) && !refused.touchedBy(op.update)) return false;
          refused.add(op.update);
          tx.objectStore(PENDING).delete([diaryId, op.localSequence]);
          return true;
        });
        tx.objectStore(BATCHES).delete(diaryId);
        tx.objectStore(BASELINES).put({ ...baseline, refused: refused.ranges });
        return toDrafts(tx, drafted, reason);
      }),

    drafts: (diaryId) =>
      run([DRAFTS], 'readonly', async (tx) => {
        const drafts = await request<Draft<Intent>[]>(
          tx.objectStore(DRAFTS).index('diaryId').getAll(diaryId),
        );
        return drafts.sort((a, b) => a.localSequence - b.localSequence);
      }),

    pages: () =>
      run([BASELINES], 'readonly', async (tx) => {
        const baselines = await request<Baseline[]>(tx.objectStore(BASELINES).getAll());
        return baselines.filter((b) => b.page).map((b) => b.diaryId);
      }),

    deleteDraft: (draftId) =>
      run([DRAFTS], 'readwrite', async (tx) => {
        tx.objectStore(DRAFTS).delete(draftId);
      }),

    close: () => {
      available = false;
      db.close();
    },
  };
}

/**
 * Moves `seq` past this account's acknowledged commits that directly follow it: their
 * text is already in the state, merged when they were confirmed.
 */
async function skipOwn(tx: IDBTransaction, diaryId: string, seq: number): Promise<number> {
  const store = tx.objectStore(RECEIPTS);
  const receipts = await request<ReceiptRecord[]>(store.getAll(receiptsOf(diaryId)));
  const bySeq = new Map(receipts.map((r) => [r.seq, r]));
  while (bySeq.has(seq + 1)) seq += 1;
  for (const r of receipts) if (r.seq <= seq) store.delete([diaryId, r.batchId]);
  return seq;
}

/**
 * Text that will not reach the server, by Yjs clientID. A later operation may build on it
 * when it inserts as one of those clients (the same editor instance, whose next items
 * chain onto it) or deletes any of its characters. Another instance's inserts cannot
 * build on it: that editor never showed it.
 */
class Refused {
  readonly ranges: RefusedRange[];
  private readonly clients: Set<number>;

  constructor(ranges: RefusedRange[] = []) {
    this.ranges = [...ranges];
    this.clients = new Set(ranges.map((r) => r.client));
  }

  add(update: Uint8Array) {
    const { from, to } = Y.parseUpdateMeta(update);
    for (const [client, clock] of from) {
      this.clients.add(client);
      this.ranges.push({ client, from: clock, to: to.get(client) ?? clock });
    }
  }

  touchedBy(update: Uint8Array): boolean {
    const { structs, ds } = Y.decodeUpdate(update);
    if (structs.some((struct) => this.clients.has(struct.id.client))) return true;
    for (const [client, deletes] of ds.clients)
      for (const { clock, len } of deletes)
        if (this.ranges.some((r) => r.client === client && clock < r.to && clock + len > r.from))
          return true;
    return false;
  }
}

function draftOf<Intent>(
  op: PendingOperation<Intent>,
  reason: DraftReason,
  savedAt: Date,
): Draft<Intent> {
  return {
    draftId: crypto.randomUUID(),
    diaryId: op.diaryId,
    generationId: op.generationId,
    reason,
    savedAt,
    localSequence: op.localSequence,
    operationId: op.operationId,
    writtenAt: op.writtenAt,
    intent: op.intent,
  };
}

function baselineFrom(record: BaselineRecord): Baseline {
  const { diaryId, generationId, epochId, periodId, seq, state, bindings } = record;
  return {
    diaryId,
    generationId,
    ...(epochId ? { epochId } : {}),
    ...(periodId ? { periodId } : {}),
    seq,
    state,
    bindings,
  };
}

/** One generation and the same epoch (or none): the same context, where input merges (D7). */
// A shared page's binding period counts too (shared-pages D4).
const sameContext = (a: Baseline, b: Baseline) =>
  a.generationId === b.generationId && a.epochId === b.epochId && a.periodId === b.periodId;

function unionBindings(a: ClientBinding[], b: ClientBinding[]): ClientBinding[] {
  const byClient = new Map(a.map((binding) => [binding.clientId, binding]));
  for (const binding of b) byClient.set(binding.clientId, binding);
  return [...byClient.values()];
}
