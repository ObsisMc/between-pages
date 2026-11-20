import {
  PROTOCOL_VERSION,
  ServerMessage,
  closeCode,
  errorCategory,
  syncSocket,
  type ClientBinding,
  type ClientMessage,
  type CommitReceipt,
  type ErrorCode,
} from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { fromBase64, toBase64 } from './base64.ts';

// The collaboration socket of one diary generation (kernel ADR D10, D14): subscribes from
// the last seq it delivered, hands committed deltas over strictly in seq order, carries
// submits and their answers, and reconnects with backoff. It owns the wire encoding, so
// nothing else in the app sees base64.

/** A batch as the sender passes it; matches the journal's `SendBatch`. */
export type OutgoingBatch = {
  diaryId: string;
  batchId: string;
  generationId: string;
  epochId?: string;
  operations: { operationId: string; update: Uint8Array; writtenAt: Date }[];
};

/** The sender's `SubmitResult`: `offline` means no answer came, so the outcome is unknown. */
export type SubmitResult =
  | { type: 'ack'; receipt: CommitReceipt }
  | { type: 'error'; code: ErrorCode }
  | { type: 'offline' };

export type CommittedDelta = { seq: number; publicId: string; delta: Uint8Array };

/**
 * `live` subscribed and caught up; `offline` reconnecting; `reauth` the session ended
 * (close 4401), wait for sign-in; `upgrade` this client's protocol is outdated, reload;
 * `refused` the server will not serve this subscription (not found, generation changed).
 */
export type SyncStatus = 'connecting' | 'live' | 'offline' | 'reauth' | 'upgrade' | 'refused';

/** The diary's sharing changed (kernel D10): `opened` a new generation, or `stopped` an epoch. */
export type ContextChange = { change: 'opened' | 'stopped'; generationId: string; epochId: string };

export type SyncClientOptions = {
  diaryId: string;
  generationId: string;
  /** The partner's live epoch; absent on the owner's own diary. */
  epochId?: string;
  /** The highest seq the caller already holds; catch-up starts after it. */
  knownSeq: number;
  /**
   * Contiguous commits after the last delivered seq, and the bindings naming their authors;
   * `live` when they came as the server's broadcast of one commit, not as a catch-up
   * (`synced`), so the screen can tell text arriving now from text that waited
   * (read-marks-until-leaving D5).
   */
  onCommits: (commits: CommittedDelta[], bindings: ClientBinding[], live: boolean) => void;
  onStatus: (status: SyncStatus, code?: ErrorCode) => void;
  /** Told after the server committed it; the screen reconciles before switching (D7). */
  onContext?: (change: ContextChange) => void;
  /**
   * The owner's diary is in a live share as of each catch-up, before it reports `live`;
   * changes after it come through `onContext`. Never told on the partner's epoch.
   */
  onShared?: (shared: boolean) => void;
  /** Another person's caret in this generation, or null when it left (kernel D8). */
  onCaret?: (user: string, caret: { anchor: Uint8Array; head: Uint8Array } | null) => void;
};

export type SyncClient = {
  submit(batch: OutgoingBatch): Promise<SubmitResult>;
  /**
   * Sends the own caret, or null when it left. Only while live, and never queued: a caret
   * that cannot go now is out of date by the time it could (kernel D8).
   */
  caret(caret: { anchor: Uint8Array; head: Uint8Array } | null): void;
  receipt(diaryId: string, batchId: string): Promise<CommitReceipt | null>;
  close(): void;
};

const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function socketUrl(): string {
  const url = new URL(syncSocket.path, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function createSyncClient({
  diaryId,
  generationId,
  epochId,
  knownSeq,
  onCommits,
  onStatus,
  onContext,
  onShared,
  onCaret,
}: SyncClientOptions): SyncClient {
  let seq = knownSeq;
  let socket: WebSocket | null = null;
  let live = false;
  let ended = false;
  let retryMs = RECONNECT_FIRST_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** At most one per batch; a resend replaces the earlier wait, which learns nothing more. */
  const waiting = new Map<string, (result: SubmitResult) => void>();

  const send = (ws: WebSocket, message: ClientMessage) => ws.send(JSON.stringify(message));
  const subscribe = (ws: WebSocket) =>
    send(ws, {
      v: PROTOCOL_VERSION,
      type: 'subscribe',
      diaryId,
      generationId,
      ...(epochId ? { epochId } : {}),
      knownSeq: seq,
    });

  const answer = (batchId: string, result: SubmitResult) => {
    waiting.get(batchId)?.(result);
    waiting.delete(batchId);
  };
  const answerAll = (result: SubmitResult) => {
    for (const batchId of [...waiting.keys()]) answer(batchId, result);
  };

  const stop = () => {
    ended = true;
    clearTimeout(timer);
    const ws = socket;
    socket = null;
    live = false;
    answerAll({ type: 'offline' });
    ws?.close();
  };
  /** Stops for good: reconnecting cannot change the answer. */
  const end = (status: SyncStatus, code?: ErrorCode) => {
    stop();
    onStatus(status, code);
  };

  const deliver = (
    commits: { seq: number; publicId: string; delta: string }[],
    bindings: ClientBinding[],
    broadcast: boolean,
  ) => {
    const next: CommittedDelta[] = [];
    for (const commit of [...commits].sort((a, b) => a.seq - b.seq)) {
      if (commit.seq <= seq) continue;
      if (commit.seq !== seq + 1) return false;
      next.push({ seq: commit.seq, publicId: commit.publicId, delta: fromBase64(commit.delta) });
      seq = commit.seq;
    }
    if (next.length > 0 || bindings.length > 0) onCommits(next, bindings, broadcast);
    return true;
  };

  function receive(ws: WebSocket, data: unknown) {
    let parsed;
    try {
      parsed = ServerMessage.safeParse(JSON.parse(String(data)));
    } catch {
      return;
    }
    // Unknown message types come from a newer server; fields it added are dropped by parsing.
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'synced':
        if (message.diaryId !== diaryId || message.generationId !== generationId) return;
        if (!deliver(message.commits, message.bindings, false)) return subscribe(ws);
        if (message.shared !== undefined) onShared?.(message.shared);
        live = true;
        retryMs = RECONNECT_FIRST_MS;
        return onStatus('live');
      case 'commit':
        if (message.diaryId !== diaryId || message.generationId !== generationId) return;
        // A gap means a broadcast overtook another; catch up from what was delivered.
        if (!deliver([message], message.bindings, true)) subscribe(ws);
        return;
      case 'ack':
        return answer(message.receipt.batchId, { type: 'ack', receipt: message.receipt });
      case 'cursor':
        if (message.diaryId !== diaryId || message.generationId !== generationId) return;
        return onCaret?.(
          message.user,
          message.anchor && message.head
            ? { anchor: fromBase64(message.anchor), head: fromBase64(message.head) }
            : null,
        );
      case 'context':
        if (message.diaryId !== diaryId) return;
        return onContext?.({
          change: message.change,
          generationId: message.generationId,
          epochId: message.epochId,
        });
      case 'error': {
        // Errors the server could not tie to a message's diary (bad frame, protocol) answer
        // the batch in flight, if any; the rest concern the subscription.
        const batchId = message.batchId ?? (message.diaryId ? undefined : [...waiting.keys()][0]);
        if (batchId) answer(batchId, { type: 'error', code: message.code });
        const category = errorCategory[message.code];
        if (category === 'upgrade') return end('upgrade', message.code);
        if (batchId) return;
        if (category === 'reauth') return end('reauth', message.code);
        if (category === 'retry') return ws.close();
        return end('refused', message.code);
      }
    }
  }

  function connect() {
    const ws = new WebSocket(socketUrl());
    socket = ws;
    onStatus('connecting');
    ws.onopen = () => subscribe(ws);
    ws.onmessage = (event) => receive(ws, event.data);
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      live = false;
      answerAll({ type: 'offline' });
      if (event.code === closeCode.UNAUTHENTICATED) return end('reauth', 'UNAUTHENTICATED');
      onStatus('offline');
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
    };
  }

  connect();

  return {
    submit(batch) {
      const ws = socket;
      if (!ws || !live || ended) return Promise.resolve({ type: 'offline' });
      return new Promise((resolve) => {
        answer(batch.batchId, { type: 'offline' });
        waiting.set(batch.batchId, resolve);
        send(ws, {
          v: PROTOCOL_VERSION,
          type: 'submit',
          diaryId: batch.diaryId,
          batchId: batch.batchId,
          generationId: batch.generationId,
          ...(batch.epochId ? { epochId: batch.epochId } : {}),
          operations: batch.operations.map((op) => ({
            operationId: op.operationId,
            update: toBase64(op.update),
            writtenAt: op.writtenAt.toISOString(),
          })),
        });
      });
    },
    caret(caret) {
      if (!socket || !live || ended) return;
      send(socket, {
        v: PROTOCOL_VERSION,
        type: 'cursor',
        diaryId,
        generationId,
        anchor: caret && toBase64(caret.anchor),
        head: caret && toBase64(caret.head),
      });
    },
    async receipt(diaryId, batchId) {
      const { receipt } = await callApi('receipt', { params: { diaryId }, query: { batchId } });
      return receipt;
    },
    close: stop,
  };
}
