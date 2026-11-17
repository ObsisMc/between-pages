import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { auth_user } from '../db/auth-schema.ts';

/**
 * Sign-in addresses, the only ones reminders go to (email-reminders D8, D10). They live
 * only in the auth layer (authentication-and-sessions invariant 10), so they are read here
 * and never copied into a domain table.
 */
export function createAddresses(db: Db) {
  return {
    /** The user's sign-in email; null for an ID the auth layer does not know. */
    async emailOf(userId: string): Promise<string | null> {
      const [row] = await db
        .select({ email: auth_user.email })
        .from(auth_user)
        .where(eq(auth_user.id, userId));
      return row?.email ?? null;
    },

    /** Every domain user who has a sign-in address, in ID order. */
    async recipients(): Promise<string[]> {
      const { rows } = await db.execute<{ id: string }>(
        sql`select u.id from users u join auth_user a on a.id = u.id order by u.id`,
      );
      return rows.map((r) => r.id);
    },
  };
}

export type Addresses = ReturnType<typeof createAddresses>;
