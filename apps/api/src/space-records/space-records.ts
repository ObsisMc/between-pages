import { createHash } from 'node:crypto';
import {
  isRequestConflict,
  type HistoryRow,
  type Membership,
  type RecordRef,
  type RequestHit,
  type SpaceRecordQueries,
  type SpaceRecordStore,
  type SpaceRecordWrites,
} from '../store/space-records.ts';
import type { Tx } from '../store/store.ts';

// The rules every space feature beyond the diary shares (space-records ADR). Feature
// services write only through `write`, which checks membership and the open binding (D2,
// D5) and appends history in the same transaction (D4, D6); it knows no feature. The
// author check (D3) is `authorOnly`; private rows (D9) are filtered by `visibleTo` in every
// read, here and in the feature stores.

export type { RecordRef };
export type Refusal =
  'NOT_FOUND' | 'SPACE_READ_ONLY' | 'RECORD_STALE' | 'RECORD_EXISTS' | 'VALIDATION_FAILED';

/** Thrown inside `write` to refuse and roll back whatever the transaction did. */
export class Refused extends Error {
  readonly code: Refusal;
  constructor(code: Refusal) {
    super(code);
    this.code = code;
  }
}

/** A record's state for one viewer (D8): what is new to them, and the mark a seen report sends back. */
export type Unseen = { unread: 'new' | 'edited' | 'acted' | null; mark: number };

/**
 * One record a feature's entry dot counts (D8): its reference, its current `mark`, and
 * whether it is new, changed, acted on, or a deletion note. Email reminders read the same
 * list (email-reminders D3), so the dot and a mail never disagree.
 */
export type UnreadItem = RecordRef & {
  mark: number;
  unread: 'new' | 'edited' | 'acted' | 'deleted';
};

export type DeletionNote = {
  ref: RecordRef;
  deletedBy: string;
  deletedAt: Date;
  /** The kinds of the viewer's own actions on the record before it was deleted. */
  acted: Set<string>;
  unread: boolean;
  mark: number;
};

export type ReadContext = Membership & {
  caller: string;
  tx: Tx;
  readOnly: boolean;
  /** The open binding period this snapshot saw; null exactly when `readOnly`. */
  periodId: string | null;
  unseen(refs: readonly RecordRef[]): Promise<Map<string, Unseen>>;
  /** Deleted records of these types the viewer had acted on (D6). */
  deletionNotes(types: readonly string[]): Promise<DeletionNote[]>;
};

type Request = { id: string; digest: string };

export type WriteContext = Membership & {
  caller: string;
  tx: Tx;
  periodId: string;
  unseen(refs: readonly RecordRef[]): Promise<Map<string, Unseen>>;
  /** History of the caller's own change; `request` makes a creation replayable. */
  changed(
    ref: RecordRef,
    kind: 'create' | 'edit' | 'delete',
    privateTo: string | null,
    request?: Request,
  ): Promise<void>;
  /** History of an action whose current state the feature has just written on the record. */
  acted(ref: RecordRef, kind: string, privateTo: string | null, request: Request): Promise<void>;
};

export const keyOf = (ref: RecordRef) => `${ref.type}:${ref.id}`;

/** The same request ID with another request is refused (D4, 失败与恢复). */
export const requestDigest = (route: string, input: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([route, input]))
    .digest('base64url');

/**
 * A second history row of one request (e.g. "我在准备" with the gift it creates) gets its
 * own request ID, derived so a replay finds the same one.
 */
export function derivedRequest(request: Request, step: string): Request {
  const hex = createHash('sha256').update(`${request.id}:${step}`).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { id, digest: request.digest };
}

/** Text and fields of a record change only by its author (D3). */
export function authorOnly(caller: string, record: { authorId: string }): void {
  if (record.authorId !== caller) throw new Refused('NOT_FOUND');
}

async function unseenOf(
  q: SpaceRecordQueries,
  viewer: string,
  spaceId: string,
  refs: readonly RecordRef[],
): Promise<Map<string, Unseen>> {
  const [history, reads] = await Promise.all([
    q.history(viewer, spaceId, refs),
    q.reads(viewer, refs),
  ]);
  const byRecord = new Map<string, HistoryRow[]>();
  for (const row of history) {
    if (row.actorId === viewer) continue;
    const k = keyOf({ type: row.recordType, id: row.recordId });
    byRecord.set(k, [...(byRecord.get(k) ?? []), row]);
  }
  const out = new Map<string, Unseen>();
  for (const ref of refs) {
    const k = keyOf(ref);
    const rows = byRecord.get(k) ?? [];
    const seen = reads.get(k) ?? 0;
    const fresh = rows.filter((r) => r.seq > seen);
    const unread = !fresh.length
      ? null
      : fresh.some((r) => r.source === 'change' && r.kind === 'create')
        ? 'new'
        : fresh.some((r) => r.source === 'change')
          ? 'edited'
          : 'acted';
    out.set(k, { unread, mark: rows.length });
  }
  return out;
}

export function createSpaceRecords(store: SpaceRecordStore) {
  const context = async (q: SpaceRecordQueries, caller: string) => {
    const membership = await q.membership(caller);
    return membership && { ...membership, caller, tx: q.tx };
  };

  return {
    /** One snapshot of the caller's space; NOT_FOUND for an account never bound (D2). */
    async read<T>(caller: string, fn: (ctx: ReadContext) => Promise<T>): Promise<T | 'NOT_FOUND'> {
      return store.read(async (q) => {
        const base = await context(q, caller);
        if (!base) return 'NOT_FOUND' as const;
        const periodId = await q.openPeriod(base.spaceId);
        return fn({
          ...base,
          readOnly: periodId === null,
          periodId,
          unseen: (refs) => unseenOf(q, caller, base.spaceId, refs),
          async deletionNotes(types) {
            const deleted = await q.deletionsByOthers(caller, base.spaceId, types);
            const own = await q.ownActionKinds(caller, deleted);
            const acted = deleted.filter((ref) => own.has(keyOf(ref)));
            const history = await q.history(caller, base.spaceId, acted);
            const unseen = await unseenOf(q, caller, base.spaceId, acted);
            return acted.map((ref) => {
              const removal = history.findLast(
                (r) =>
                  r.recordId === ref.id &&
                  r.recordType === ref.type &&
                  r.source === 'change' &&
                  r.kind === 'delete',
              )!;
              const state = unseen.get(keyOf(ref))!;
              return {
                ref,
                deletedBy: removal.actorId,
                deletedAt: removal.committedAt,
                acted: own.get(keyOf(ref))!,
                unread: state.unread !== null,
                mark: state.mark,
              };
            });
          },
        });
      });
    },

    /**
     * Runs `fn` while the space has an open binding, held FOR SHARE until commit (D5).
     * With `request`, a request ID already committed by the caller skips `fn` and answers
     * through `replay` with the record it touched; the same ID with another digest is
     * VALIDATION_FAILED. A `Refused` thrown by `fn` rolls everything back.
     */
    async write<T>(
      caller: string,
      request: (Request & { source: 'change' | 'action' }) | null,
      fn: (ctx: WriteContext) => Promise<T>,
      replay?: (ctx: WriteContext, hit: RequestHit) => Promise<T>,
    ): Promise<T | Refusal> {
      const attempt = () =>
        store.write(async (w: SpaceRecordWrites) => {
          const base = await context(w, caller);
          if (!base) throw new Refused('NOT_FOUND');
          const ctx = (periodId: string): WriteContext => ({
            ...base,
            periodId,
            unseen: (refs) => unseenOf(w, caller, base.spaceId, refs),
            changed: (ref, kind, privateTo, req) =>
              w.appendChange({
                spaceId: base.spaceId,
                ref,
                kind,
                actorId: caller,
                privateTo,
                ...(req ? { request: req } : {}),
              }),
            acted: (ref, kind, privateTo, req) =>
              w.appendAction({
                spaceId: base.spaceId,
                ref,
                kind,
                actorId: caller,
                privateTo,
                request: req,
              }),
          });
          if (request && replay) {
            const hit =
              request.source === 'change'
                ? await w.changeRequest(caller, request.id)
                : await w.actionRequest(caller, request.id);
            if (hit) {
              if (hit.digest !== request.digest) throw new Refused('VALIDATION_FAILED');
              return replay(ctx(''), hit);
            }
          }
          const periodId = await w.lockOpenPeriod(base.spaceId);
          if (!periodId) throw new Refused('SPACE_READ_ONLY');
          return fn(ctx(periodId));
        });
      try {
        try {
          return await attempt();
        } catch (error) {
          // The same request committed on another connection meanwhile: answer as a replay.
          if (request && replay && isRequestConflict(error)) return await attempt();
          throw error;
        }
      } catch (error) {
        if (error instanceof Refused) return error.code;
        throw error;
      }
    },

    /**
     * Raises the caller's marks on records they had on screen (D8): each to the partner's
     * change or action numbered `mark` among those visible to the caller, so one that
     * arrived after the screen loaded stays unread. Allowed while unbound, since reading
     * is; records the caller cannot see are ignored.
     */
    async seen(
      caller: string,
      records: readonly (RecordRef & { mark: number })[],
    ): Promise<'NOT_FOUND' | true> {
      return store.write(async (w) => {
        const base = await context(w, caller);
        if (!base) return 'NOT_FOUND' as const;
        const history = await w.history(caller, base.spaceId, records);
        for (const record of records) {
          const rows = history.filter(
            (r) => r.actorId !== caller && r.recordId === record.id && r.recordType === record.type,
          );
          const upTo = rows[Math.min(record.mark, rows.length) - 1];
          if (upTo) await w.markSeen(caller, base.spaceId, record, upTo.seq);
        }
        return true as const;
      });
    },
  };
}

export type SpaceRecords = ReturnType<typeof createSpaceRecords>;
