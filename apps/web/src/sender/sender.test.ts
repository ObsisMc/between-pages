import 'fake-indexeddb/auto';
import { BODY, createDiaryDoc } from '@between-pages/collab';
import type { CommitReceipt, ErrorCode } from '@between-pages/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openJournal, type Draft, type Journal, type SendBatch } from '../journal/index.ts';
import * as Y from 'yjs';
import { createSender, type SaveStatus, type Sender, type SubmitResult } from './sender.ts';

const DIARY = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
// The journal works in real time even under fake timers, so "nothing was sent" waits in it.
const realSetTimeout = globalThis.setTimeout;
const quiet = () => new Promise((resolve) => realSetTimeout(resolve, 30));
const GENERATION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Web Locks as browsers implement them for one origin: one holder per name, in request order. */
function stubLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request(name: string, callback: () => Promise<unknown>) {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
  vi.stubGlobal('navigator', { locks });
}

/** A stand-in server: each submit waits until the test answers it; commits are remembered by batch. */
function server() {
  const calls: { batch: SendBatch; answer: (result: SubmitResult) => void }[] = [];
  const committed = new Map<string, CommitReceipt>();
  let seq = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const commit = (batch: SendBatch) => {
    let receipt = committed.get(batch.batchId);
    if (!receipt) {
      receipt = {
        batchId: batch.batchId,
        operationIds: batch.operations.map((op) => op.operationId),
        generationId: GENERATION,
        seq: ++seq,
        publicId: crypto.randomUUID(),
        committedAt: new Date().toISOString(),
      };
      committed.set(batch.batchId, receipt);
    }
    return receipt;
  };
  return {
    calls,
    committed,
    get maxInFlight() {
      return maxInFlight;
    },
    commit,
    transport: {
      submit: (batch: SendBatch) =>
        new Promise<SubmitResult>((resolve) => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          calls.push({
            batch,
            answer: (result) => {
              inFlight -= 1;
              resolve(result);
            },
          });
        }),
      receipt: async (_diaryId: string, batchId: string) => committed.get(batchId) ?? null,
    },
    /** Commits and acknowledges call `i`. */
    ack(i: number) {
      const call = calls[i]!;
      call.answer({ type: 'ack', receipt: commit(call.batch) });
    },
    fail(i: number, code: ErrorCode) {
      calls[i]!.answer({ type: 'error', code });
    },
  };
}

async function journalFor(userId: string) {
  const journal = await openJournal<string>(userId);
  cleanup.push(() => journal.close());
  return journal;
}

async function setup(stand = server(), userId = crypto.randomUUID()) {
  stubLocks();
  const journal = await journalFor(userId);
  await journal.install({
    diaryId: DIARY,
    generationId: GENERATION,
    seq: 0,
    state: Y.encodeStateAsUpdate(createDiaryDoc()),
    bindings: [],
  });
  return { journal, userId, stand, ...senderOn(journal, userId, stand) };
}

function senderOn(journal: Journal<string>, userId: string, stand: ReturnType<typeof server>) {
  const statuses: SaveStatus[] = [];
  const drafts: Draft<string>[][] = [];
  const sender: Sender = createSender({
    journal,
    userId,
    diaryId: DIARY,
    transport: stand.transport,
    onStatus: (status) => statuses.push(status),
    onDrafts: (moved) => drafts.push(moved),
  });
  cleanup.push(() => sender.stop());
  return { sender, statuses, drafts };
}

const doc = createDiaryDoc();
function op(content: string, from = doc) {
  let update: Uint8Array = new Uint8Array();
  from.once('update', (u: Uint8Array) => (update = u));
  from.getText(BODY).insert(0, content);
  return { operationId: crypto.randomUUID(), update, writtenAt: new Date(), intent: content };
}

async function type(journal: Journal<string>, sender: Sender, content: string) {
  await journal.append(DIARY, GENERATION, op(content));
  sender.wake();
}

const intents = (batch: SendBatch, journalOps: Map<string, string>) =>
  batch.operations.map((o) => journalOps.get(o.operationId));

describe('sender', () => {
  it('sends the first operation at once and what came meanwhile only after it is confirmed', async () => {
    const { journal, sender, stand, statuses } = await setup();
    await type(journal, sender, '一');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    await type(journal, sender, '二');
    await type(journal, sender, '三');
    await quiet();
    expect(stand.calls).toHaveLength(1);

    stand.ack(0);
    await vi.waitFor(() => expect(stand.calls).toHaveLength(2));
    expect(stand.calls[1]!.batch.operations).toHaveLength(2);
    stand.ack(1);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('saved'));
    expect(await journal.load(DIARY)).toMatchObject({ pending: [], batch: null });
    expect((await journal.load(DIARY)).baseline!.seq).toBe(2);
  });

  it('stops saying saved as soon as it is woken for new input', async () => {
    const { journal, sender, stand, statuses } = await setup();
    sender.wake();
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('saved'));
    await journal.append(DIARY, GENERATION, op('新'));
    sender.wake();
    expect(statuses.at(-1)).toBe('syncing');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
  });

  it('[adr:diary-collaboration-kernel#10] resends the same batch after a lost answer and confirms it once', async () => {
    const { journal, sender, stand, statuses } = await setup();
    await type(journal, sender, '字');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    // Committed on the server, but the connection dropped before the ACK.
    stand.commit(stand.calls[0]!.batch);
    stand.calls[0]!.answer({ type: 'offline' });
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('offline'));

    sender.wake(); // the connection is back
    await vi.waitFor(() => expect(stand.calls).toHaveLength(2));
    expect(stand.calls[1]!.batch).toEqual(stand.calls[0]!.batch);
    stand.ack(1);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('saved'));
    expect(stand.committed.size).toBe(1);
    expect((await journal.load(DIARY)).baseline!.seq).toBe(1);
  });

  it('retries a temporary server failure with the same batch after a pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { journal, sender, stand, statuses } = await setup();
    await type(journal, sender, '字');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    stand.fail(0, 'INTERNAL');
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('offline'));

    await type(journal, sender, '再'); // typing on does not cut the pause short
    await quiet();
    expect(stand.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(stand.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(stand.calls).toHaveLength(2));
    expect(stand.calls[1]!.batch.batchId).toBe(stand.calls[0]!.batch.batchId);
  });

  it('[adr:diary-collaboration-kernel#8] moves a refused batch and later input to drafts, then sends new input', async () => {
    const { journal, sender, stand, statuses, drafts } = await setup();
    await type(journal, sender, '甲');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    await type(journal, sender, '乙');
    stand.fail(0, 'EDIT_REJECTED');
    await vi.waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]!.map((d) => d.intent)).toEqual(['甲', '乙']);
    expect(statuses).toContain('attention');
    expect(stand.committed.size).toBe(0);

    // The screen rebuilds the editor without the refused text; its input sends normally.
    await journal.append(DIARY, GENERATION, op('丙', createDiaryDoc()));
    sender.wake();
    await vi.waitFor(() => expect(stand.calls).toHaveLength(2));
    expect(stand.calls[1]!.batch.operations).toHaveLength(1);
    expect((await journal.drafts(DIARY)).map((d) => d.intent)).toEqual(['甲', '乙']);
  });

  it('[adr:diary-collaboration-kernel#21] treats a batch the server committed as saved when the context error comes back', async () => {
    const { journal, sender, stand, drafts } = await setup();
    await type(journal, sender, '已存');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    stand.commit(stand.calls[0]!.batch);
    stand.fail(0, 'STALE_CONTEXT');

    await vi.waitFor(async () => expect((await journal.load(DIARY)).pending).toEqual([]));
    expect(drafts).toEqual([]);
    expect(await journal.drafts(DIARY)).toEqual([]);
  });

  it('keeps uncommitted input of an outdated context as drafts', async () => {
    const { journal, sender, stand, drafts } = await setup();
    await type(journal, sender, '未存');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    stand.fail(0, 'STALE_CONTEXT');
    await vi.waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]).toMatchObject([{ intent: '未存', reason: 'stale-generation' }]);
  });

  it('pauses on an ended session and sends again only when woken', async () => {
    const { journal, sender, stand, statuses } = await setup();
    await type(journal, sender, '字');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    stand.fail(0, 'UNAUTHENTICATED');
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('reauth'));
    expect((await journal.load(DIARY)).pending).toHaveLength(1);

    sender.wake(); // signed in again
    await vi.waitFor(() => expect(stand.calls).toHaveLength(2));
  });

  it('stops for good on an unsupported protocol, keeping pending input', async () => {
    const { journal, sender, stand, statuses } = await setup();
    await type(journal, sender, '字');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    stand.fail(0, 'PROTOCOL_UNSUPPORTED');
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('upgrade'));

    await type(journal, sender, '再');
    await quiet();
    expect(stand.calls).toHaveLength(1);
    expect((await journal.load(DIARY)).pending).toHaveLength(2);
  });

  it('[adr:diary-collaboration-kernel#22] keeps one batch in flight across tabs and sends every operation once, in order', async () => {
    const stand = server();
    const { journal: tab1, userId, sender: sender1 } = await setup(stand);
    const tab2 = await journalFor(userId);
    const { sender: sender2 } = senderOn(tab2, userId, stand);
    const typed = new Map<string, string>();
    const write = async (journal: Journal<string>, sender: Sender, content: string) => {
      const operation = op(content);
      typed.set(operation.operationId, content);
      await journal.append(DIARY, GENERATION, operation);
      sender.wake();
    };

    await write(tab1, sender1, '1');
    await write(tab2, sender2, '2');
    await vi.waitFor(() => expect(stand.calls).toHaveLength(1));
    await write(tab2, sender2, '3');
    await write(tab1, sender1, '4');
    const committedOps = () =>
      [...stand.committed.values()].reduce((n, r) => n + r.operationIds.length, 0);
    for (let acked = 0; committedOps() < 4; acked++) {
      await vi.waitFor(() => expect(stand.calls.length).toBeGreaterThan(acked));
      stand.ack(acked);
    }
    await vi.waitFor(async () => expect((await tab2.load(DIARY)).pending).toEqual([]));

    expect(stand.maxInFlight).toBe(1);
    const sent = stand.calls.flatMap((call) => intents(call.batch, typed));
    expect(new Set(sent)).toEqual(new Set(['1', '2', '3', '4']));
    expect(sent).toEqual([...sent].sort());
    expect((await tab2.load(DIARY)).batch).toBeNull();
  });

  it('stays read-only without Web Locks', async () => {
    const stand = server();
    vi.stubGlobal('navigator', {});
    const journal = await journalFor(crypto.randomUUID());
    const { sender, statuses } = senderOn(journal, crypto.randomUUID(), stand);
    sender.wake();
    expect(statuses).toEqual(['readonly']);
    expect(stand.calls).toEqual([]);
  });
});
