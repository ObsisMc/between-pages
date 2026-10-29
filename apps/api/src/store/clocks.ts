import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { activeBindings, users } from '../db/schema.ts';

// SQL for the two-clocks settings on `users` (two-clocks D1, D2, D5). Writes touch only the
// caller's own row and only these columns, a plain row update that never waits on the
// `FOR KEY SHARE` diary creation takes and queues briefly behind a relationship flow's lock.

export type ClockRow = {
  timezone: string | null;
  sleepStartMinute: number | null;
  sleepEndMinute: number | null;
};
export type PartnerClockRow = ClockRow & { id: string; displayName: string };

const clockColumns = {
  timezone: users.timezone,
  sleepStartMinute: users.sleepStartMinute,
  sleepEndMinute: users.sleepEndMinute,
};

export function createClockStore(db: Db) {
  return {
    /**
     * The caller's settings and, only while the caller has a current binding, the partner's,
     * read in one snapshot so an unbinding cannot fall between the two reads (D5).
     */
    view(userId: string): Promise<{ me: ClockRow; partner: PartnerClockRow | null }> {
      return db.transaction(
        async (tx) => {
          const [me] = await tx.select(clockColumns).from(users).where(eq(users.id, userId));
          const [own] = await tx
            .select({ periodId: activeBindings.periodId })
            .from(activeBindings)
            .where(eq(activeBindings.userId, userId));
          const [other] = own
            ? await tx
                .select({ userId: activeBindings.userId })
                .from(activeBindings)
                .where(
                  and(eq(activeBindings.periodId, own.periodId), ne(activeBindings.userId, userId)),
                )
            : [];
          const [partner] = other
            ? await tx
                .select({ id: users.id, displayName: users.displayName, ...clockColumns })
                .from(users)
                .where(eq(users.id, other.userId))
            : [];
          return { me: me!, partner: partner ?? null };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },

    async setTimezone(userId: string, timezone: string, at: Date): Promise<ClockRow> {
      const [row] = await db
        .update(users)
        .set({ timezone, timezoneUpdatedAt: at })
        .where(eq(users.id, userId))
        .returning(clockColumns);
      return row!;
    },

    async setSleep(
      userId: string,
      sleep: { start: number; end: number } | null,
    ): Promise<ClockRow> {
      const [row] = await db
        .update(users)
        .set({ sleepStartMinute: sleep?.start ?? null, sleepEndMinute: sleep?.end ?? null })
        .where(eq(users.id, userId))
        .returning(clockColumns);
      return row!;
    },
  };
}

export type ClockStore = ReturnType<typeof createClockStore>;
