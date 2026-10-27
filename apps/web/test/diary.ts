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
  /** Sends the ACK of the submit last answered with `hold`. */
  static release = () => {};
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
    const answer = FakeSocket.answer(message);
    if (answer === 'hold') {
      FakeSocket.release = () => this.ack(message, reply);
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
  ack(message: Submit, reply: (m: object) => void) {
    reply({
      ...base,
      type: 'ack',
      replayed: false,
      receipt: {
        batchId: message.batchId,
        operationIds: message.operations.map((op) => op.operationId),
        generationId: GENERATION,
        seq: ++FakeSocket.seq,
        publicId: crypto.randomUUID(),
        committedAt: new Date().toISOString(),
      },
    });
  }
  close() {}
  static reset() {
    FakeSocket.all = [];
    FakeSocket.answer = () => 'ack';
    FakeSocket.seq = 0;
    FakeSocket.release = () => {};
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
