import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { anniversaries, anniversaryReminders, users } from '../db/schema.ts';
import type { Tx } from './store.ts';

// SQL for anniversaries (anniversaries ADR). Anniversaries have no private state, so no
// read needs `visibleTo`. Reminders are each person's own setting (invariant 4): every
// read and write of them is keyed by the caller.

export type AnniversaryRow = typeof anniversaries.$inferSelect;

const alive = isNull(anniversaries.deletedAt);

export class AnniversaryQueries {
  readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  list(spaceId: string): Promise<AnniversaryRow[]> {
    return this.tx
      .select()
      .from(anniversaries)
      .where(and(eq(anniversaries.spaceId, spaceId), alive));
  }

  async one(spaceId: string, id: string): Promise<AnniversaryRow | null> {
    const [row] = await this.tx
      .select()
      .from(anniversaries)
      .where(and(eq(anniversaries.spaceId, spaceId), eq(anniversaries.id, id), alive));
    return row ?? null;
  }

  /** Deleted ones too, for deletion notes. */
  byIds(spaceId: string, ids: readonly string[]): Promise<AnniversaryRow[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.tx
      .select()
      .from(anniversaries)
      .where(and(eq(anniversaries.spaceId, spaceId), inArray(anniversaries.id, [...ids])));
  }

  /** The caller's own reminder rows; an anniversary without one has the default (D3). */
  async reminders(userId: string, ids: readonly string[]): Promise<Map<string, number | null>> {
    if (!ids.length) return new Map();
    const rows = await this.tx
      .select({ id: anniversaryReminders.anniversaryId, days: anniversaryReminders.days })
      .from(anniversaryReminders)
      .where(
        and(
          eq(anniversaryReminders.userId, userId),
          inArray(anniversaryReminders.anniversaryId, [...ids]),
        ),
      );
    return new Map(rows.map((r) => [r.id, r.days]));
  }

  async people(ids: readonly string[]): Promise<{ id: string; displayName: string }[]> {
    return this.tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ids]));
  }

  /** The zone the partner's browser last reported (two-clocks D1); null if never. */
  async timezoneOf(userId: string): Promise<string | null> {
    const [row] = await this.tx
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId));
    return row?.timezone ?? null;
  }
}

/** Writes inside a space-records write; the row is locked FOR UPDATE before its history. */
export class AnniversaryWrites extends AnniversaryQueries {
  async lock(spaceId: string, id: string): Promise<AnniversaryRow | null> {
    const [row] = await this.tx
      .select()
      .from(anniversaries)
      .where(and(eq(anniversaries.spaceId, spaceId), eq(anniversaries.id, id), alive))
      .for('update');
    return row ?? null;
  }

  async insert(row: typeof anniversaries.$inferInsert): Promise<AnniversaryRow> {
    const [inserted] = await this.tx.insert(anniversaries).values(row).returning();
    return inserted!;
  }

  async update(
    id: string,
    set: Partial<typeof anniversaries.$inferInsert>,
  ): Promise<AnniversaryRow> {
    const [row] = await this.tx
      .update(anniversaries)
      .set(set)
      .where(eq(anniversaries.id, id))
      .returning();
    return row!;
  }
}

/** A second together day in one space (invariant 1). */
export const isSecondTogether = (error: unknown): boolean => {
  const cause = (error as { cause?: { code?: string; constraint?: string } }).cause ?? error;
  const { code, constraint } = cause as { code?: string; constraint?: string };
  return code === '23505' && constraint === 'anniversaries_together';
};

export function createReminderStore(db: Db) {
  return {
    /**
     * The caller's reminder of an anniversary that is alive in `spaceId` (D3). It is no
     * space record: no binding is needed and no history is kept.
     */
    async save(
      userId: string,
      spaceId: string,
      anniversaryId: string,
      days: number | null,
    ): Promise<boolean> {
      const saved = await db
        .insert(anniversaryReminders)
        .select(
          db
            .select({
              userId: sql<string>`${userId}::uuid`.as('user_id'),
              anniversaryId: anniversaries.id,
              days: sql<number | null>`${days}::smallint`.as('days'),
            })
            .from(anniversaries)
            .where(
              and(eq(anniversaries.id, anniversaryId), eq(anniversaries.spaceId, spaceId), alive),
            ),
        )
        .onConflictDoUpdate({
          target: [anniversaryReminders.userId, anniversaryReminders.anniversaryId],
          set: { days: sql`excluded.days` },
        })
        .returning({ id: anniversaryReminders.anniversaryId });
      return saved.length > 0;
    },
  };
}

export type ReminderStore = ReturnType<typeof createReminderStore>;
