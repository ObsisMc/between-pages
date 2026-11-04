import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { diaryGenerations, documents, sharedPages, users } from '../db/schema.ts';
import type { Tx } from './store.ts';

// SQL for shared pages (shared-pages ADR). Pages have no private state, so no read needs
// `visibleTo`. A write already holds the open period FOR SHARE and takes the document lock
// after it, the one lock order (D7), so a deletion and a commit are ordered by that lock.

export type SharedPageRow = typeof sharedPages.$inferSelect;
export type SharedPageDocument = SharedPageRow & { generationId: string; version: number };

const alive = isNull(sharedPages.deletedAt);
const columns = {
  id: sharedPages.id,
  spaceId: sharedPages.spaceId,
  authorId: sharedPages.authorId,
  createdPeriodId: sharedPages.createdPeriodId,
  privateTo: sharedPages.privateTo,
  revision: sharedPages.revision,
  createdAt: sharedPages.createdAt,
  updatedAt: sharedPages.updatedAt,
  deletedAt: sharedPages.deletedAt,
  deletedBy: sharedPages.deletedBy,
  title: sharedPages.title,
  titleBy: sharedPages.titleBy,
  titleAt: sharedPages.titleAt,
  generationId: documents.generationId,
  version: documents.version,
};

export class SharedPageQueries {
  readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  list(spaceId: string): Promise<SharedPageRow[]> {
    return this.tx
      .select()
      .from(sharedPages)
      .where(and(eq(sharedPages.spaceId, spaceId), alive));
  }

  async one(spaceId: string, id: string): Promise<SharedPageDocument | null> {
    const [row] = await this.tx
      .select(columns)
      .from(sharedPages)
      .innerJoin(documents, eq(documents.id, sharedPages.id))
      .where(and(eq(sharedPages.spaceId, spaceId), eq(sharedPages.id, id), alive));
    return row ?? null;
  }

  /** Deleted ones too, for deletion notes. */
  byIds(spaceId: string, ids: readonly string[]): Promise<SharedPageRow[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.tx
      .select()
      .from(sharedPages)
      .where(and(eq(sharedPages.spaceId, spaceId), inArray(sharedPages.id, [...ids])));
  }

  people(ids: readonly string[]): Promise<{ id: string; displayName: string }[]> {
    return this.tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ids]));
  }
}

export class SharedPageWrites extends SharedPageQueries {
  /** The page and its one generation, on a new document (D6, D7). */
  async create(row: {
    id: string;
    generationId: string;
    baseline: Uint8Array;
    spaceId: string;
    authorId: string;
    createdPeriodId: string;
    title: string;
  }): Promise<SharedPageRow> {
    const { generationId, baseline, ...page } = row;
    await this.tx.insert(documents).values({ id: page.id, generationId });
    await this.tx.insert(diaryGenerations).values({
      id: generationId,
      diaryId: page.id,
      sourceVersion: 0,
      baseline,
      baselineSha256: createHash('sha256').update(baseline).digest(),
    });
    const [inserted] = await this.tx.insert(sharedPages).values(page).returning();
    return inserted!;
  }

  /** The page under its document lock; re-read after waiting, so a deleted one is null. */
  async lock(spaceId: string, id: string): Promise<SharedPageRow | null> {
    if (!(await this.one(spaceId, id))) return null;
    await this.tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, id))
      .for('update');
    return this.one(spaceId, id);
  }

  async update(id: string, set: Partial<SharedPageRow>): Promise<SharedPageRow> {
    const [row] = await this.tx
      .update(sharedPages)
      .set(set)
      .where(eq(sharedPages.id, id))
      .returning();
    return row!;
  }
}
