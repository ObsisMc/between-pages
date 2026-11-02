import { and, eq, inArray, isNull, ne, or, sql, type Column, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { bindingPeriods, spaceActions, spaceChanges, spaceReads, spaces } from '../db/schema.ts';
import type { Tx } from './store.ts';

// SQL for the shared space-record tables (space-records ADR). A record's history rows are
// inserted only while its feature row is locked FOR UPDATE (or, for a creation, before the
// row exists to anyone else), so on one record the sequence order is the commit order and a
// "seen up to" mark never skips a row that commits later.

export type RecordRef = { type: string; id: string };
export type Membership = { spaceId: string; partnerId: string };
export type HistoryRow = {
  seq: number;
  recordType: string;
  recordId: string;
  /** `create`, `edit`, `delete` for changes; the feature's kind for actions. */
  kind: string;
  source: 'change' | 'action';
  actorId: string;
  committedAt: Date;
};
export type RequestHit = { recordType: string; recordId: string; digest: string };

const key = (type: string, id: string) => `${type}:${id}`;

/**
 * Rows a viewer may see: shared ones and those private to them (D9). Every read of a
 * record, change or action goes through this, for feature tables too.
 */
export const visibleTo = (privateTo: Column, viewer: string): SQL =>
  or(isNull(privateTo), eq(privateTo, viewer))!;

/** Reads inside one transaction: a snapshot under `read`, the writer's view under `write`. */
export class SpaceRecordQueries {
  readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  async membership(userId: string): Promise<Membership | null> {
    const [row] = await this.tx
      .select({ id: spaces.id, low: spaces.userLow, high: spaces.userHigh })
      .from(spaces)
      .where(or(eq(spaces.userLow, userId), eq(spaces.userHigh, userId)));
    return row ? { spaceId: row.id, partnerId: row.low === userId ? row.high : row.low } : null;
  }

  async hasOpenPeriod(spaceId: string): Promise<boolean> {
    const [row] = await this.tx
      .select({ id: bindingPeriods.id })
      .from(bindingPeriods)
      .where(and(eq(bindingPeriods.spaceId, spaceId), isNull(bindingPeriods.endedAt)));
    return row !== undefined;
  }

  /**
   * The history of these records a viewer may see, oldest first. Changes and actions share
   * one sequence, so the merged order is the order they committed in.
   */
  async history(
    viewer: string,
    spaceId: string,
    refs: readonly RecordRef[],
  ): Promise<HistoryRow[]> {
    if (!refs.length) return [];
    const ids = [...new Set(refs.map((r) => r.id))];
    const wanted = new Set(refs.map((r) => key(r.type, r.id)));
    const changes = await this.tx
      .select({
        seq: spaceChanges.seq,
        recordType: spaceChanges.recordType,
        recordId: spaceChanges.recordId,
        kind: spaceChanges.kind,
        actorId: spaceChanges.actorId,
        committedAt: spaceChanges.committedAt,
      })
      .from(spaceChanges)
      .where(
        and(
          eq(spaceChanges.spaceId, spaceId),
          inArray(spaceChanges.recordId, ids),
          visibleTo(spaceChanges.privateTo, viewer),
        ),
      );
    const actions = await this.tx
      .select({
        seq: spaceActions.seq,
        recordType: spaceActions.recordType,
        recordId: spaceActions.recordId,
        kind: spaceActions.kind,
        actorId: spaceActions.actorId,
        committedAt: spaceActions.committedAt,
      })
      .from(spaceActions)
      .where(
        and(
          eq(spaceActions.spaceId, spaceId),
          inArray(spaceActions.recordId, ids),
          visibleTo(spaceActions.privateTo, viewer),
        ),
      );
    return [
      ...changes.map((r) => ({ ...r, source: 'change' as const })),
      ...actions.map((r) => ({ ...r, source: 'action' as const })),
    ]
      .filter((r) => wanted.has(key(r.recordType, r.recordId)))
      .sort((a, b) => a.seq - b.seq);
  }

  /** The viewer's seen marks on these records, keyed `type:id`. */
  async reads(viewer: string, refs: readonly RecordRef[]): Promise<Map<string, number>> {
    if (!refs.length) return new Map();
    const rows = await this.tx
      .select({ type: spaceReads.recordType, id: spaceReads.recordId, seq: spaceReads.seq })
      .from(spaceReads)
      .where(
        and(
          eq(spaceReads.userId, viewer),
          inArray(spaceReads.recordId, [...new Set(refs.map((r) => r.id))]),
        ),
      );
    return new Map(rows.map((r) => [key(r.type, r.id), r.seq]));
  }

  /** Records of these types the partner deleted, as seen by the viewer, with the viewer's own actions on them. */
  async deletionsByOthers(
    viewer: string,
    spaceId: string,
    types: readonly string[],
  ): Promise<RecordRef[]> {
    const rows = await this.tx
      .selectDistinct({ type: spaceChanges.recordType, id: spaceChanges.recordId })
      .from(spaceChanges)
      .where(
        and(
          eq(spaceChanges.spaceId, spaceId),
          eq(spaceChanges.kind, 'delete'),
          ne(spaceChanges.actorId, viewer),
          inArray(spaceChanges.recordType, [...types]),
          visibleTo(spaceChanges.privateTo, viewer),
        ),
      );
    return rows;
  }

  /** The kinds of the viewer's own actions on these records, keyed `type:id`. */
  async ownActionKinds(
    viewer: string,
    refs: readonly RecordRef[],
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (!refs.length) return out;
    const rows = await this.tx
      .select({ type: spaceActions.recordType, id: spaceActions.recordId, kind: spaceActions.kind })
      .from(spaceActions)
      .where(
        and(
          eq(spaceActions.actorId, viewer),
          inArray(spaceActions.recordId, [...new Set(refs.map((r) => r.id))]),
        ),
      );
    for (const r of rows) {
      const k = key(r.type, r.id);
      out.set(k, (out.get(k) ?? new Set()).add(r.kind));
    }
    return out;
  }

  async changeRequest(actorId: string, requestId: string): Promise<RequestHit | null> {
    const [row] = await this.tx
      .select({
        recordType: spaceChanges.recordType,
        recordId: spaceChanges.recordId,
        digest: spaceChanges.requestDigest,
      })
      .from(spaceChanges)
      .where(and(eq(spaceChanges.actorId, actorId), eq(spaceChanges.requestId, requestId)));
    return row ? { ...row, digest: row.digest! } : null;
  }

  async actionRequest(actorId: string, requestId: string): Promise<RequestHit | null> {
    const [row] = await this.tx
      .select({
        recordType: spaceActions.recordType,
        recordId: spaceActions.recordId,
        digest: spaceActions.requestDigest,
      })
      .from(spaceActions)
      .where(and(eq(spaceActions.actorId, actorId), eq(spaceActions.requestId, requestId)));
    return row ?? null;
  }
}

/** Writes, only inside a transaction that holds the open period FOR SHARE (D5). */
export class SpaceRecordWrites extends SpaceRecordQueries {
  /**
   * The open period of the space, FOR SHARE: unbinding updates that row, so it waits for
   * this transaction, and a write that starts after it committed finds no open period.
   */
  async lockOpenPeriod(spaceId: string): Promise<string | null> {
    const [row] = await this.tx
      .select({ id: bindingPeriods.id })
      .from(bindingPeriods)
      .where(and(eq(bindingPeriods.spaceId, spaceId), isNull(bindingPeriods.endedAt)))
      .for('share');
    return row?.id ?? null;
  }

  async appendChange(row: {
    spaceId: string;
    ref: RecordRef;
    kind: 'create' | 'edit' | 'delete';
    actorId: string;
    privateTo: string | null;
    request?: { id: string; digest: string };
  }): Promise<void> {
    await this.tx.insert(spaceChanges).values({
      spaceId: row.spaceId,
      recordType: row.ref.type,
      recordId: row.ref.id,
      kind: row.kind,
      actorId: row.actorId,
      privateTo: row.privateTo,
      requestId: row.request?.id ?? null,
      requestDigest: row.request?.digest ?? null,
    });
  }

  async appendAction(row: {
    spaceId: string;
    ref: RecordRef;
    kind: string;
    actorId: string;
    privateTo: string | null;
    request: { id: string; digest: string };
  }): Promise<void> {
    await this.tx.insert(spaceActions).values({
      spaceId: row.spaceId,
      recordType: row.ref.type,
      recordId: row.ref.id,
      kind: row.kind,
      actorId: row.actorId,
      privateTo: row.privateTo,
      requestId: row.request.id,
      requestDigest: row.request.digest,
    });
  }

  /** Raises the viewer's mark on a record; a lower or equal mark changes nothing. */
  async markSeen(viewer: string, spaceId: string, ref: RecordRef, seq: number): Promise<void> {
    await this.tx
      .insert(spaceReads)
      .values({ userId: viewer, spaceId, recordType: ref.type, recordId: ref.id, seq })
      .onConflictDoUpdate({
        target: [spaceReads.userId, spaceReads.recordType, spaceReads.recordId],
        set: { seq: sql`greatest(${spaceReads.seq}, excluded.seq)` },
      });
  }
}

/** A unique violation on a request ID: the same request committed concurrently. */
export const isRequestConflict = (error: unknown): boolean => {
  const cause = (error as { cause?: { code?: string; constraint?: string } }).cause ?? error;
  const { code, constraint } = cause as { code?: string; constraint?: string };
  return (
    code === '23505' &&
    (constraint === 'space_changes_request' || constraint === 'space_actions_request')
  );
};

export function createSpaceRecordStore(db: Db) {
  return {
    /** One read-only snapshot, so lists, history and marks agree. */
    read<T>(fn: (q: SpaceRecordQueries) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(new SpaceRecordQueries(tx)), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    },
    write<T>(fn: (w: SpaceRecordWrites) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(new SpaceRecordWrites(tx)));
    },
  };
}

export type SpaceRecordStore = ReturnType<typeof createSpaceRecordStore>;
