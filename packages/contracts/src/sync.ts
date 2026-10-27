import { z } from 'zod';
import { ErrorCode } from './errors.ts';
import { ClientBinding, CommitReceipt } from './diaries.ts';

// The collaboration WebSocket (kernel ADR D10). The server parses client messages strictly
// and rejects unknown fields; clients parse server messages leniently, so the server may
// add fields without a new protocol version. Only an incompatible change bumps it, and
// the server supports only the current one.

export const PROTOCOL_VERSION = 1;

/** Hard cap on one WebSocket message, in bytes, either direction (D10). */
export const MAX_MESSAGE_BYTES = 1_048_576;

export const syncSocket = { path: '/api/sync' } as const;

/** Close codes the server uses, so a client knows to pause rather than reconnect. */
export const closeCode = {
  /** The session ended or was revoked: pause sync and ask the same account to sign in. */
  UNAUTHENTICATED: 4401,
} as const;

const Uuid = z.uuid();
const Version = z.literal(PROTOCOL_VERSION);

export const SubscribeMessage = z.strictObject({
  v: Version,
  type: z.literal('subscribe'),
  diaryId: Uuid,
  generationId: Uuid,
  /**
   * The partner's shared entry: the live epoch the client opened. Omitted for the owner's
   * personal entry. Never widens access: the server checks it against the caller.
   */
  epochId: Uuid.optional(),
  /** Highest seq the client holds in this generation; the server sends what follows. */
  knownSeq: z.int().nonnegative(),
});

export const SubmitOperation = z.strictObject({
  operationId: Uuid,
  /** One Yjs transaction as the `update` event emits it, base64. */
  update: z.base64(),
  /** Client clock, for display only; never used for order or permission (D15). */
  writtenAt: z.iso.datetime({ offset: true }),
});

/** A send batch: the identity, context and ordered members persisted before first send. */
export const SubmitMessage = z.strictObject({
  v: Version,
  type: z.literal('submit'),
  diaryId: Uuid,
  batchId: Uuid,
  generationId: Uuid,
  /** The live epoch a partner writes in; omitted for the owner's personal entry (kernel D7). */
  epochId: Uuid.optional(),
  operations: z
    .array(SubmitOperation)
    .min(1)
    .refine(
      (ops) => new Set(ops.map((op) => op.operationId)).size === ops.length,
      'operation IDs repeat within the batch',
    ),
});

/** An encoded `Y.RelativePosition`: where a caret sits, stable while text around it changes (D8). */
const RelativePosition = z.base64().max(256);

/**
 * The sender's caret and selection in the diary it subscribed to (kernel D8), relayed at
 * once to the connections that may read it now, never stored. Both null: the caret left.
 * No user field: the server names the sender from the session.
 */
export const CursorMessage = z.strictObject({
  v: Version,
  type: z.literal('cursor'),
  diaryId: Uuid,
  generationId: Uuid,
  anchor: RelativePosition.nullable(),
  head: RelativePosition.nullable(),
});

export const ClientMessage = z.discriminatedUnion('type', [
  SubscribeMessage,
  SubmitMessage,
  CursorMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

const CommittedDelta = {
  seq: z.int().positive(),
  publicId: Uuid,
  /** Re-encoded by the server from accepted state, never the uploaded bytes (D3). */
  delta: z.base64(),
};

/** Reply to subscribe: every commit after `knownSeq`, then live `commit` messages. */
export const SyncedMessage = z.object({
  v: Version,
  type: z.literal('synced'),
  diaryId: Uuid,
  generationId: Uuid,
  seq: z.int().nonnegative(),
  commits: z.array(z.object(CommittedDelta)),
  bindings: z.array(ClientBinding),
});

/**
 * A commit after PG COMMIT, to every subscriber including its sender, whose ACK comes
 * first. Broadcasts can arrive out of seq order; on a gap the client subscribes again
 * with its known seq.
 */
export const CommitMessage = z.object({
  v: Version,
  type: z.literal('commit'),
  diaryId: Uuid,
  generationId: Uuid,
  ...CommittedDelta,
  /** clientIDs this commit bound, so receivers can show the new text's author. */
  bindings: z.array(ClientBinding),
});

/** The whole batch committed; `replayed` when it had been committed by an earlier send. */
export const AckMessage = z.object({
  v: Version,
  type: z.literal('ack'),
  diaryId: Uuid,
  receipt: CommitReceipt,
  replayed: z.boolean(),
});

export const ErrorMessage = z.object({
  v: Version,
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string(),
  diaryId: Uuid.optional(),
  batchId: Uuid.optional(),
  /** EDIT_REJECTED only: the collab reject reason and failing operation, for diagnosis. */
  reason: z.string().optional(),
  index: z.int().nonnegative().optional(),
});

/**
 * The diary's sharing changed (kernel D10). `opened`: it now runs in `generationId`,
 * shared as `epochId`; owners reconcile pending input and reload, the partner may open the
 * new epoch. `stopped`: `epochId` froze; its partner keeps that version read-only. Sent
 * after PG COMMIT; a client that missed it learns the same from STALE_CONTEXT.
 */
export const ContextMessage = z.object({
  v: Version,
  type: z.literal('context'),
  diaryId: Uuid,
  change: z.enum(['opened', 'stopped']),
  generationId: Uuid,
  epochId: Uuid,
});

/** Another person's caret, by their session's user; null positions remove it. */
export const RemoteCursorMessage = z.object({
  v: Version,
  type: z.literal('cursor'),
  diaryId: Uuid,
  generationId: Uuid,
  user: Uuid,
  anchor: RelativePosition.nullable(),
  head: RelativePosition.nullable(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  SyncedMessage,
  CommitMessage,
  AckMessage,
  ErrorMessage,
  ContextMessage,
  RemoteCursorMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
