import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebsocketHandler } from '@fastify/websocket';
import {
  ClientMessage,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  closeCode,
  syncSocket,
  type ErrorCode,
  type ServerMessage,
} from '@between-pages/contracts';
import { requireOrigin, requireUser, type CurrentUser } from '../auth/guards.ts';
import type { CommitService } from '../commit/commit.ts';
import type { DiaryService } from '../diaries/diaries.ts';
import type { CommittedEvent, DiaryEvent, Events } from '../events/events.ts';
import { VersionUnreadable } from '../errors.ts';
import type { Reader } from '../reader/reader.ts';

/** Fallback session check per connection (kernel D10); sign-out events arrive in phase 4. */
export const SESSION_RECHECK_MS = 60_000;

/**
 * ws drops a frame over its own limit by closing the connection without a reason, and a
 * client would then resend the same batch forever. So ws allows twice the contract's cap
 * and this module answers PAYLOAD_TOO_LARGE, which stops the batch (D10 "stop").
 */
export const TRANSPORT_MAX_BYTES = 2 * MAX_MESSAGE_BYTES;

type Deps = {
  publicOrigin: string;
  currentUser: CurrentUser;
  diaries: DiaryService;
  reader: Reader;
  commit: CommitService;
  events: Events;
};

type WebSocket = Parameters<WebsocketHandler>[0];
type RawData = Buffer | ArrayBuffer | Buffer[];

type Fields = { diaryId?: string; batchId?: string; reason?: string; index?: number };

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bindingList = (bindings: Map<number, string>) =>
  [...bindings].map(([clientId, userId]) => ({ clientId, userId }));

/**
 * The collaboration socket (kernel D10). The handshake checks Origin and the session
 * before upgrading (authentication-and-sessions invariants 6, 7); every submit checks the
 * session again (invariant 8). Messages of one connection run in arrival order.
 */
export function registerSyncSocket(app: FastifyInstance, deps: Deps) {
  app.route({
    method: 'GET',
    url: syncSocket.path,
    websocket: true,
    schema: { hide: true },
    preValidation: [requireOrigin(deps.publicOrigin), requireUser(deps.currentUser)],
    handler: (socket, request) => serve(socket, request, deps),
  });
}

function serve(socket: WebSocket, request: FastifyRequest, deps: Deps) {
  const user = request.user!;
  const subscriptions = new Map<string, () => void>();
  let queue = Promise.resolve();

  const send = (message: ServerMessage) => socket.send(JSON.stringify(message));
  const fail = (code: ErrorCode, message: string, fields: Fields = {}) =>
    send({ v: PROTOCOL_VERSION, type: 'error', code, message, ...fields });
  // Fields are listed, not spread, so the event's epoch never reaches the wire.
  const sendCommit = (event: CommittedEvent) =>
    send({
      v: PROTOCOL_VERSION,
      type: 'commit',
      diaryId: event.diaryId,
      generationId: event.generationId,
      seq: event.seq,
      publicId: event.publicId,
      delta: base64(event.delta),
      bindings: event.bindings,
    });
  const sendEvent = (event: DiaryEvent) =>
    event.type === 'commit'
      ? sendCommit(event)
      : send({
          v: PROTOCOL_VERSION,
          type: 'context',
          diaryId: event.diaryId,
          change: event.change,
          generationId: event.generationId,
          epochId: event.epochId,
        });

  // The handshake's cookie must still name the same user; otherwise the connection ends
  // with a close code the client reads as "sign in again", keeping its pending edits.
  async function sessionValid(): Promise<boolean> {
    const current = await deps.currentUser(request.headers);
    if (current?.id === user.id) return true;
    socket.close(closeCode.UNAUTHENTICATED, 'session ended');
    return false;
  }

  const recheck = setInterval(() => {
    sessionValid().catch((error: unknown) =>
      request.log.error({ err: error }, 'session recheck failed'),
    );
  }, SESSION_RECHECK_MS);

  socket.on('message', (data: RawData, isBinary: boolean) => {
    queue = queue
      .then(() => handle(data, isBinary))
      .catch((error: unknown) => {
        request.log.error({ err: error }, 'sync message failed');
        fail('INTERNAL', 'Internal error');
      });
  });
  socket.on('close', () => {
    clearInterval(recheck);
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });

  async function handle(data: RawData, isBinary: boolean) {
    const bytes = Buffer.isBuffer(data)
      ? data
      : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    if (bytes.length > MAX_MESSAGE_BYTES)
      return fail('PAYLOAD_TOO_LARGE', `Messages are limited to ${MAX_MESSAGE_BYTES} bytes`);
    let json: unknown;
    try {
      if (isBinary) throw new TypeError('binary frame');
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      // Binary frames and invalid JSON are equally outside the protocol.
      return fail('VALIDATION_FAILED', 'Messages are JSON text');
    }
    if ((json as { v?: unknown } | null)?.v !== PROTOCOL_VERSION)
      return fail('PROTOCOL_UNSUPPORTED', `This server speaks protocol ${PROTOCOL_VERSION} only`);
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) return fail('VALIDATION_FAILED', 'Message does not match the contract');
    const message = parsed.data;
    switch (message.type) {
      case 'subscribe':
        return subscribe(message);
      case 'submit':
        return submit(message);
      default:
        return message satisfies never;
    }
  }

  async function subscribe(message: Extract<ClientMessage, { type: 'subscribe' }>) {
    const { diaryId, generationId, epochId, knownSeq } = message;
    const sub = { viewer: user.id, generationId, epochId: epochId ?? null };
    // Listen before reading, so a commit landing during the catch-up read is held back
    // and sent after it instead of lost. Who receives what is decided from the event
    // alone (D10): the owner their generation, the partner their epoch.
    let live = false;
    let owner = false;
    const held: DiaryEvent[] = [];
    subscriptions.get(diaryId)?.();
    subscriptions.set(
      diaryId,
      deps.events.subscribe(diaryId, (event) => {
        if (!live) return void held.push(event);
        if (deps.reader.deliverable(event, sub, owner)) sendEvent(event);
      }),
    );
    const result =
      epochId === undefined
        ? await deps.diaries.catchUp(user.id, diaryId, generationId, knownSeq)
        : await deps.reader.catchUp(user.id, diaryId, generationId, epochId, knownSeq);
    if (result === 'NOT_FOUND' || result === 'STALE_CONTEXT') {
      subscriptions.get(diaryId)?.();
      subscriptions.delete(diaryId);
      return fail(result, result === 'NOT_FOUND' ? 'No such diary' : 'Context has changed', {
        diaryId,
      });
    }
    owner = epochId === undefined;
    send({
      v: PROTOCOL_VERSION,
      type: 'synced',
      diaryId,
      generationId,
      seq: result.seq,
      commits: result.commits.map((c) => ({ ...c, delta: base64(c.delta) })),
      bindings: bindingList(result.bindings),
    });
    live = true;
    for (const event of held)
      if (
        deps.reader.deliverable(event, sub, owner) &&
        (event.type === 'context' || event.seq > result.seq)
      )
        sendEvent(event);
  }

  async function submit(message: Extract<ClientMessage, { type: 'submit' }>) {
    const { diaryId, batchId, generationId, epochId } = message;
    if (!(await sessionValid()))
      return fail('UNAUTHENTICATED', 'Sign in required', { diaryId, batchId });
    let outcome;
    try {
      outcome = await deps.commit.commit(user.id, {
        diaryId,
        batchId,
        generationId,
        epochId,
        operations: message.operations.map((op) => ({
          operationId: op.operationId,
          update: new Uint8Array(Buffer.from(op.update, 'base64')),
          writtenAt: new Date(op.writtenAt),
        })),
      });
    } catch (error) {
      if (error instanceof VersionUnreadable) {
        request.log.error({ err: error }, 'stored diary state failed its check');
        return fail('VERSION_UNREADABLE', 'Stored diary state failed its check', {
          diaryId,
          batchId,
        });
      }
      // Lock timeout, PG down, crash before COMMIT: nothing was committed; resend the batch.
      request.log.error({ err: error }, 'commit failed');
      return fail('INTERNAL', 'Internal error', { diaryId, batchId });
    }
    if (!outcome.ok) {
      const { code, reason, index } = outcome;
      return fail(code, `Batch not committed: ${code}`, {
        diaryId,
        batchId,
        ...(reason ? { reason, index: index! } : {}),
      });
    }
    // ACK only after PG COMMIT (commit() resolved), and before anyone else hears of it.
    send({
      v: PROTOCOL_VERSION,
      type: 'ack',
      diaryId,
      receipt: { ...outcome.receipt, committedAt: outcome.receipt.committedAt.toISOString() },
      replayed: outcome.replayed,
    });
    if (outcome.event) deps.events.publish(outcome.event);
  }
}
