import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

// SQL for the home's pokes and pets (window-mascots D3, D4). Each statement finds the caller's
// current binding period itself, so an unbinding can never fall between the check and the
// write, and a row of an earlier period is never read again (a rebind is a new period).

export type PokeKind = 'poke' | 'pet';
export type Waiting = { pokes: number; pets: number; lastAt: Date } | null;

type Row = { pokes: number; pets: number; last_at: Date | string };
const waitingOf = (row: Row | undefined): Waiting =>
  row && (row.pokes > 0 || row.pets > 0)
    ? { pokes: row.pokes, pets: row.pets, lastAt: new Date(row.last_at) }
    : null;

/** The caller's current binding period, as a subquery. */
const periodOf = (userId: string) =>
  sql`(select period_id from active_bindings where user_id = ${userId}::uuid)`;

export function createPokeStore(db: Db) {
  return {
    /** What the partner sent the caller in their current binding and they have not seen. */
    async waiting(userId: string): Promise<Waiting> {
      const result = await db.execute<Row>(sql`
        select pokes, pets, last_at from mascot_pokes
        where recipient_id = ${userId}::uuid and period_id = ${periodOf(userId)}`);
      return waitingOf(result.rows[0]);
    },

    /**
     * Counts one `kind` for the caller's current partner, unless the caller counted the same
     * kind under a second ago. False when the caller has no current binding; true otherwise,
     * whether or not it counted, so nothing about the partner's row comes back (D4).
     */
    async send(userId: string, kind: PokeKind, now: Date): Promise<boolean> {
      const count = sql.raw(kind === 'poke' ? 'pokes' : 'pets');
      const sentAt = sql.raw(kind === 'poke' ? 'poke_sent_at' : 'pet_sent_at');
      const result = await db.execute<{ bound: boolean }>(sql`
        with pair as (
          select other.period_id, other.user_id as recipient_id
          from active_bindings mine
          join active_bindings other
            on other.period_id = mine.period_id and other.user_id <> mine.user_id
          where mine.user_id = ${userId}::uuid
        ), counted as (
          insert into mascot_pokes (period_id, recipient_id, ${count}, last_at, ${sentAt})
          select period_id, recipient_id, 1, ${now}, ${now} from pair
          on conflict (period_id, recipient_id) do update
            set ${count} = mascot_pokes.${count} + 1, last_at = ${now}, ${sentAt} = ${now}
            where mascot_pokes.${sentAt} is null
              or mascot_pokes.${sentAt} <= ${now}::timestamptz - interval '1 second'
        )
        select exists (select 1 from pair) as bound`);
      return result.rows[0]!.bound;
    },

    /**
     * Takes what the caller has shown off what waits for them in their current binding, and
     * removes the row once nothing is left; what arrived meanwhile stays (D4, invariant 4).
     */
    async seen(userId: string, shown: { pokes: number; pets: number }): Promise<Waiting> {
      return db.transaction(async (tx) => {
        const result = await tx.execute<Row>(sql`
          update mascot_pokes
          set pokes = greatest(pokes - ${shown.pokes}, 0), pets = greatest(pets - ${shown.pets}, 0)
          where recipient_id = ${userId}::uuid and period_id = ${periodOf(userId)}
          returning pokes, pets, last_at`);
        const row = result.rows[0];
        if (row && row.pokes === 0 && row.pets === 0)
          await tx.execute(sql`
            delete from mascot_pokes
            where recipient_id = ${userId}::uuid and period_id = ${periodOf(userId)}
              and pokes = 0 and pets = 0`);
        return waitingOf(row);
      });
    },
  };
}

export type PokeStore = ReturnType<typeof createPokeStore>;
