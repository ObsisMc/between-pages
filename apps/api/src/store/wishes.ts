import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { giftCards, gifts, users, wishes } from '../db/schema.ts';
import { visibleTo } from './space-records.ts';
import type { Tx } from './store.ts';

// SQL for wishes, gifts and cards (wishes-and-gifts ADR). Every read a caller's answer is
// built from filters private rows through `visibleTo` (space-records D9). The two lookups
// that do not, `preparingFor` and `preparingForAny`, decide what a wisher's action does to
// the giver's private gift and are never returned to the wisher.

export type WishRow = typeof wishes.$inferSelect;
export type GiftRow = typeof gifts.$inferSelect;
export type CardRow = typeof giftCards.$inferSelect;
export type Preview = { title: string | null; site: string | null; image: string | null };

const alive = (table: typeof wishes | typeof gifts | typeof giftCards) => isNull(table.deletedAt);

export class WishQueries {
  readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  /** Wishes still on either list: not deleted, not yet received. */
  listedWishes(spaceId: string): Promise<WishRow[]> {
    return this.tx
      .select()
      .from(wishes)
      .where(and(eq(wishes.spaceId, spaceId), alive(wishes), isNull(wishes.receivedAt)))
      .orderBy(sql`${wishes.want} desc nulls last`, desc(wishes.createdAt));
  }

  /** The viewer's own gifts in preparation. */
  preparing(viewer: string, spaceId: string): Promise<GiftRow[]> {
    return this.tx
      .select()
      .from(gifts)
      .where(
        and(
          eq(gifts.spaceId, spaceId),
          eq(gifts.status, 'preparing'),
          alive(gifts),
          visibleTo(gifts.privateTo, viewer),
        ),
      )
      .orderBy(desc(gifts.createdAt));
  }

  /** The gift wall (D5): every revealed gift, newest date first. */
  wall(spaceId: string): Promise<GiftRow[]> {
    return this.tx
      .select()
      .from(gifts)
      .where(and(eq(gifts.spaceId, spaceId), eq(gifts.status, 'revealed'), alive(gifts)))
      .orderBy(desc(gifts.giftDate), desc(gifts.revealedAt));
  }

  cards(viewer: string, giftIds: readonly string[]): Promise<CardRow[]> {
    if (!giftIds.length) return Promise.resolve([]);
    return this.tx
      .select()
      .from(giftCards)
      .where(
        and(
          inArray(giftCards.giftId, [...giftIds]),
          alive(giftCards),
          visibleTo(giftCards.privateTo, viewer),
        ),
      );
  }

  async wish(spaceId: string, id: string): Promise<WishRow | null> {
    const [row] = await this.tx
      .select()
      .from(wishes)
      .where(and(eq(wishes.spaceId, spaceId), eq(wishes.id, id)));
    return row ?? null;
  }

  async gift(viewer: string, spaceId: string, id: string): Promise<GiftRow | null> {
    const [row] = await this.tx
      .select()
      .from(gifts)
      .where(and(eq(gifts.spaceId, spaceId), eq(gifts.id, id), visibleTo(gifts.privateTo, viewer)));
    return row ?? null;
  }

  /** The gift a wish became on the wall, for replaying "收到了". */
  async revealedFor(spaceId: string, wishId: string): Promise<GiftRow | null> {
    const [row] = await this.tx
      .select()
      .from(gifts)
      .where(
        and(eq(gifts.spaceId, spaceId), eq(gifts.wishId, wishId), eq(gifts.status, 'revealed')),
      );
    return row ?? null;
  }

  /** Names of deleted records for deletion notes, keyed by ID. */
  async names(viewer: string, wishIds: string[], giftIds: string[]): Promise<Map<string, string>> {
    const rows = [
      ...(wishIds.length
        ? await this.tx
            .select({ id: wishes.id, name: wishes.name })
            .from(wishes)
            .where(inArray(wishes.id, wishIds))
        : []),
      ...(giftIds.length
        ? await this.tx
            .select({ id: gifts.id, name: gifts.name })
            .from(gifts)
            .where(and(inArray(gifts.id, giftIds), visibleTo(gifts.privateTo, viewer)))
        : []),
    ];
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async people(ids: readonly string[]): Promise<{ id: string; displayName: string }[]> {
    return this.tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ids]));
  }

  /** The caller's local zone, for the wall date of a reveal (D5); null if never reported. */
  async timezoneOf(userId: string): Promise<string | null> {
    const [row] = await this.tx
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId));
    return row?.timezone ?? null;
  }
}

/**
 * Writes inside a space-records write. Rows are locked FOR UPDATE before their history is
 * appended; when a flow needs both, the wish is locked before the gift.
 */
export class WishWrites extends WishQueries {
  async lockWish(spaceId: string, id: string): Promise<WishRow | null> {
    const [row] = await this.tx
      .select()
      .from(wishes)
      .where(and(eq(wishes.spaceId, spaceId), eq(wishes.id, id), alive(wishes)))
      .for('update');
    return row ?? null;
  }

  async lockGift(viewer: string, spaceId: string, id: string): Promise<GiftRow | null> {
    const [row] = await this.tx
      .select()
      .from(gifts)
      .where(
        and(
          eq(gifts.spaceId, spaceId),
          eq(gifts.id, id),
          alive(gifts),
          visibleTo(gifts.privateTo, viewer),
        ),
      )
      .for('update');
    return row ?? null;
  }

  /** The gift being prepared for a wish, whoever prepares it; for the wisher's actions only. */
  async preparingFor(wishId: string): Promise<GiftRow | null> {
    const [row] = await this.tx
      .select()
      .from(gifts)
      .where(and(eq(gifts.wishId, wishId), eq(gifts.status, 'preparing'), alive(gifts)))
      .for('update');
    return row ?? null;
  }

  async lockCard(giftId: string): Promise<CardRow | null> {
    const [row] = await this.tx
      .select()
      .from(giftCards)
      .where(and(eq(giftCards.giftId, giftId), alive(giftCards)))
      .for('update');
    return row ?? null;
  }

  async insertWish(row: typeof wishes.$inferInsert): Promise<WishRow> {
    const [inserted] = await this.tx.insert(wishes).values(row).returning();
    return inserted!;
  }

  async updateWish(id: string, set: Partial<typeof wishes.$inferInsert>): Promise<WishRow> {
    const [row] = await this.tx.update(wishes).set(set).where(eq(wishes.id, id)).returning();
    return row!;
  }

  async insertGift(row: typeof gifts.$inferInsert): Promise<GiftRow> {
    const [inserted] = await this.tx.insert(gifts).values(row).returning();
    return inserted!;
  }

  async updateGift(id: string, set: Partial<typeof gifts.$inferInsert>): Promise<GiftRow> {
    const [row] = await this.tx.update(gifts).set(set).where(eq(gifts.id, id)).returning();
    return row!;
  }

  async insertCard(row: typeof giftCards.$inferInsert): Promise<CardRow> {
    const [inserted] = await this.tx.insert(giftCards).values(row).returning();
    return inserted!;
  }

  async updateCard(id: string, set: Partial<typeof giftCards.$inferInsert>): Promise<CardRow> {
    const [row] = await this.tx.update(giftCards).set(set).where(eq(giftCards.id, id)).returning();
    return row!;
  }
}

// Link previews (D7): the worker takes links nobody has read yet and stores what it found,
// only if the link is still the one it read.
export type PendingLink = { table: 'wish' | 'gift'; id: string; link: string };

export function createPreviewStore(db: Db) {
  const pending = (table: typeof wishes | typeof gifts) =>
    db
      .select({ id: table.id, link: table.link })
      .from(table)
      .where(and(isNotNull(table.link), isNull(table.previewReadAt), alive(table)))
      .orderBy(table.createdAt)
      .limit(10);
  return {
    async pending(): Promise<PendingLink[]> {
      const [w, g] = await Promise.all([pending(wishes), pending(gifts)]);
      return [
        ...w.map((r) => ({ table: 'wish' as const, id: r.id, link: r.link! })),
        ...g.map((r) => ({ table: 'gift' as const, id: r.id, link: r.link! })),
      ];
    },

    async save(item: PendingLink, preview: Preview | null, at: Date): Promise<void> {
      const table = item.table === 'wish' ? wishes : gifts;
      await db
        .update(table)
        .set({
          previewTitle: preview?.title ?? null,
          previewSite: preview?.site ?? null,
          previewImage: preview?.image ?? null,
          previewReadAt: at,
        })
        .where(and(eq(table.id, item.id), eq(table.link, item.link), isNull(table.previewReadAt)));
    },
  };
}

export type PreviewStore = ReturnType<typeof createPreviewStore>;
