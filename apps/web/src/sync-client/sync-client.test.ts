import {
  ClientMessage,
  PROTOCOL_VERSION,
  closeCode,
  type CommitReceipt,
  type ServerMessage,
} from '@between-pages/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from './base64.ts';
import { createSyncClient, type CommittedDelta, type SyncStatus } from './sync-client.ts';

const DIARY = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const GENERATION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const USER = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

/** The browser WebSocket at the network boundary: records what the client sends. */
class FakeSocket {
  static all: FakeSocket[] = [];
  sent: ClientMessage[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  // The server parses strictly, so so does the stand-in.
  send(data: string) {
    this.sent.push(ClientMessage.parse(JSON.parse(data)));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  receive(message: ServerMessage | Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

const clients: { close(): void }[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  FakeSocket.all = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(knownSeq = 0) {
  vi.stubGlobal('WebSocket', FakeSocket);
  const statuses: SyncStatus[] = [];
  const delivered: CommittedDelta[] = [];
  const bindings: unknown[] = [];
  const client = createSyncClient({
    diaryId: DIARY,
    generationId: GENERATION,
    knownSeq,
    onCommits: (commits, b) => {
      delivered.push(...commits);
      bindings.push(...b);
    },
    onStatus: (status) => statuses.push(status),
  });
  clients.push(client);
  return { client, statuses, delivered, bindings, socket: () => FakeSocket.all.at(-1)! };
}

const commit = (seq: number, bytes: number[]) => ({
  seq,
  publicId: crypto.randomUUID(),
  delta: toBase64(new Uint8Array(bytes)),
});

const synced = (seq: number, commits: ReturnType<typeof commit>[]) => ({
  v: PROTOCOL_VERSION,
  type: 'synced' as const,
  diaryId: DIARY,
  generationId: GENERATION,
  seq,
  commits,
  bindings: [{ clientId: 7, userId: USER }],
});

const broadcast = (c: ReturnType<typeof commit>) => ({
  v: PROTOCOL_VERSION,
  type: 'commit' as const,
  diaryId: DIARY,
  generationId: GENERATION,
  ...c,
  bindings: [],
});

const batch = () => ({
  diaryId: DIARY,
  batchId: crypto.randomUUID(),
  generationId: GENERATION,
  operations: [
    {
      operationId: crypto.randomUUID(),
      update: new Uint8Array([1, 2, 250]),
      writtenAt: new Date('2026-10-27T08:00:00Z'),
    },
  ],
});

const receiptOf = (b: ReturnType<typeof batch>, seq: number): CommitReceipt => ({
  batchId: b.batchId,
  operationIds: b.operations.map((op) => op.operationId),
  generationId: GENERATION,
  seq,
  publicId: crypto.randomUUID(),
  committedAt: '2026-10-27T08:00:01.000Z',
});

async function live(knownSeq = 0) {
  const harness = setup(knownSeq);
  harness.socket().open();
  harness.socket().receive(synced(knownSeq, []));
  return harness;
}

describe('sync client', () => {
  it('subscribes from the known seq and hands over the catch-up decoded and in order', () => {
    const { socket, delivered, bindings, statuses } = setup(3);
    expect(socket().url).toBe(`ws://${location.host}/api/sync`);
    socket().open();
    expect(socket().sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: 'subscribe',
        diaryId: DIARY,
        generationId: GENERATION,
        knownSeq: 3,
      },
    ]);

    socket().receive(synced(5, [commit(5, [5]), commit(4, [4])]));
    expect(delivered.map((c) => [c.seq, [...c.delta]])).toEqual([
      [4, [4]],
      [5, [5]],
    ]);
    expect(bindings).toEqual([{ clientId: 7, userId: USER }]);
    expect(statuses.at(-1)).toBe('live');
  });

  it('ignores commits it already has and catches up after a gap', async () => {
    const { socket, delivered } = await live(1);
    socket().receive(broadcast(commit(2, [2])));
    socket().receive(broadcast(commit(2, [2])));
    socket().receive(broadcast(commit(4, [4])));
    expect(delivered.map((c) => c.seq)).toEqual([2]);
    expect(socket().sent.at(-1)).toMatchObject({ type: 'subscribe', knownSeq: 2 });

    socket().receive(synced(4, [commit(3, [3]), commit(4, [4])]));
    expect(delivered.map((c) => c.seq)).toEqual([2, 3, 4]);
  });

  it('submits a batch in the contract shape and resolves with its ACK', async () => {
    const { client, socket } = await live();
    const b = batch();
    const result = client.submit(b);
    expect(socket().sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: 'submit',
      diaryId: DIARY,
      batchId: b.batchId,
      generationId: GENERATION,
      operations: [
        {
          operationId: b.operations[0]!.operationId,
          update: toBase64(new Uint8Array([1, 2, 250])),
          writtenAt: '2026-10-27T08:00:00.000Z',
        },
      ],
    });
    const receipt = receiptOf(b, 1);
    // Clients parse leniently: a field a newer server adds changes nothing.
    socket().receive({
      v: PROTOCOL_VERSION,
      type: 'ack',
      diaryId: DIARY,
      receipt,
      replayed: false,
      extra: 1,
    });
    await expect(result).resolves.toEqual({ type: 'ack', receipt });
  });

  it("answers a submit with the server's error code", async () => {
    const { client, socket } = await live();
    const b = batch();
    const result = client.submit(b);
    socket().receive({
      v: PROTOCOL_VERSION,
      type: 'error',
      code: 'EDIT_REJECTED',
      message: 'Batch not committed',
      diaryId: DIARY,
      batchId: b.batchId,
      reason: 'foreign-delete',
      index: 0,
    });
    await expect(result).resolves.toEqual({ type: 'error', code: 'EDIT_REJECTED' });
  });

  it('reports a submit as offline when not connected or when the connection drops before the answer', async () => {
    const { client, socket } = setup();
    await expect(client.submit(batch())).resolves.toEqual({ type: 'offline' });

    socket().open();
    socket().receive(synced(0, []));
    const result = client.submit(batch());
    socket().drop();
    await expect(result).resolves.toEqual({ type: 'offline' });
  });

  it('reconnects with backoff and subscribes from the last delivered seq', async () => {
    vi.useFakeTimers();
    const { socket, statuses } = await live(0);
    socket().receive(broadcast(commit(1, [1])));
    socket().drop();
    expect(statuses.at(-1)).toBe('offline');
    expect(FakeSocket.all).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    socket().open();
    expect(socket().sent).toEqual([expect.objectContaining({ type: 'subscribe', knownSeq: 1 })]);
  });

  it('stops on an ended session instead of reconnecting', async () => {
    vi.useFakeTimers();
    const { socket, statuses } = await live();
    socket().drop(closeCode.UNAUTHENTICATED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses.at(-1)).toBe('reauth');
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('stops for an outdated protocol, also answering the batch in flight', async () => {
    vi.useFakeTimers();
    const { client, socket, statuses } = await live();
    const result = client.submit(batch());
    socket().receive({
      v: PROTOCOL_VERSION,
      type: 'error',
      code: 'PROTOCOL_UNSUPPORTED',
      message: 'This server speaks protocol 2 only',
    });
    await expect(result).resolves.toEqual({ type: 'error', code: 'PROTOCOL_UNSUPPORTED' });
    expect(statuses.at(-1)).toBe('upgrade');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('reports a subscription the server refuses', async () => {
    const { socket, statuses } = setup();
    socket().open();
    socket().receive({
      v: PROTOCOL_VERSION,
      type: 'error',
      code: 'NOT_FOUND',
      message: 'No such diary',
      diaryId: DIARY,
    });
    expect(statuses.at(-1)).toBe('refused');
    expect(socket().closed).toBe(true);
  });

  it('looks up a receipt over HTTP through the contract route', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ receipt: null }));
    vi.stubGlobal('fetch', fetchImpl);
    const { client } = setup();
    const batchId = crypto.randomUUID();
    await expect(client.receipt(DIARY, batchId)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(`/api/diaries/${DIARY}/receipt?batchId=${batchId}`, {
      method: 'GET',
    });
  });
});

describe('shared diaries', () => {
  const EPOCH = 'e1e1e1e1-0000-4000-8000-000000000001';

  it('subscribes and submits in the partner epoch, and hands over context changes', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const changes: unknown[] = [];
    const client = createSyncClient({
      diaryId: DIARY,
      generationId: GENERATION,
      epochId: EPOCH,
      knownSeq: 2,
      onCommits: () => undefined,
      onStatus: () => undefined,
      onContext: (change) => changes.push(change),
    });
    clients.push(client);
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: 'subscribe', epochId: EPOCH, knownSeq: 2 });
    socket.receive(synced(2, []));

    void client.submit({ ...batch(), epochId: EPOCH });
    expect(socket.sent[1]).toMatchObject({ type: 'submit', epochId: EPOCH });

    const next = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
    socket.receive({
      v: PROTOCOL_VERSION,
      type: 'context',
      diaryId: DIARY,
      change: 'opened',
      generationId: next,
      epochId: EPOCH,
    });
    expect(changes).toEqual([{ change: 'opened', generationId: next, epochId: EPOCH }]);
  });

  it('sends no epoch on the owner’s own diary', () => {
    const { socket } = setup();
    socket().open();
    expect(socket().sent[0]).not.toHaveProperty('epochId');
  });
});
