import { createDiaryDoc } from '@between-pages/collab';
import { ClientMessage, PROTOCOL_VERSION, type ErrorCode } from '@between-pages/contracts';
import * as Y from 'yjs';

// Stand-ins at the network and browser boundaries for diary tests: the sync socket's far
// end, Web Locks, and the API's answer for an empty diary.

export const USER = '6f1c1d0e-0000-4000-8000-000000000001';
export const DIARY = '7c1d2b8e-3f4a-4b5c-8d6e-9f0a1b2c3d4e';
export const GENERATION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

type Submit = Extract<ClientMessage, { type: 'submit' }>;

/** The sync socket's far end: answers each submit as the test says, ACK by default. */
export class FakeSocket {
  static all: FakeSocket[] = [];
  static answer: (submit: Submit) => ErrorCode | 'ack' | 'hold' = () => 'ack';
  static seq = 0;
  private static held: (() => void) | null = null;
  private static releaseEarly = false;
  /**
   * ACKs the submit last answered with `hold`. A test may observe the pending state before
   * the sender has handed the batch to the socket, so a release that comes first ACKs the
   * held submit as soon as it arrives.
   */
  static release() {
    if (FakeSocket.held) FakeSocket.held();
    else FakeSocket.releaseEarly = true;
  }
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    const message = ClientMessage.parse(JSON.parse(data));
    this.sent.push(message);
    const reply = (m: object) =>
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(m) }));
    if (message.type === 'subscribe')
      return reply({
        ...base,
        type: 'synced',
        generationId: GENERATION,
        seq: FakeSocket.seq,
        commits: [],
        bindings: [],
      });
    // Carets are relayed to others only; the sender hears nothing back.
    if (message.type === 'cursor') return;
    const answer = FakeSocket.answer(message);
    if (answer === 'hold') {
      FakeSocket.held = () => this.ack(message, reply);
      if (FakeSocket.releaseEarly) FakeSocket.held();
      return;
    }
    if (answer !== 'ack')
      return reply({
        ...base,
        type: 'error',
        code: answer,
        message: 'no',
        batchId: message.batchId,
      });
    this.ack(message, reply);
  }
  /** ACKs the batch, then broadcasts it to every subscriber, its sender included, as the API does. */
  ack(message: Submit, reply: (m: object) => void) {
    const seq = ++FakeSocket.seq;
    const publicId = crypto.randomUUID();
    reply({
      ...base,
      type: 'ack',
      replayed: false,
      receipt: {
        batchId: message.batchId,
        operationIds: message.operations.map((op) => op.operationId),
        generationId: GENERATION,
        seq,
        publicId,
        committedAt: new Date().toISOString(),
      },
    });
    const updates = message.operations.map((op) =>
      Uint8Array.from(atob(op.update), (c) => c.charCodeAt(0)),
    );
    const delta = Y.mergeUpdates(updates);
    reply({
      ...base,
      type: 'commit',
      generationId: GENERATION,
      seq,
      publicId,
      delta: btoa(String.fromCharCode(...delta)),
      bindings: [],
    });
  }
  close() {}
  /** Delivers a server message, such as another device's commit. */
  push(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  static reset() {
    FakeSocket.all = [];
    FakeSocket.answer = () => 'ack';
    FakeSocket.seq = 0;
    FakeSocket.held = null;
    FakeSocket.releaseEarly = false;
  }
}
const base = { v: PROTOCOL_VERSION, diaryId: DIARY };

export function stubLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name: string, callback: () => Promise<unknown>) {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

const empty = () => btoa(String.fromCharCode(...Y.encodeStateAsUpdate(createDiaryDoc())));
export const diaryResponse = () =>
  Response.json({
    diary: {
      diaryId: DIARY,
      diaryDate: '2026-10-27',
      ownerId: USER,
      generationId: GENERATION,
      seq: 0,
      state: empty(),
      bindings: [],
    },
  });
