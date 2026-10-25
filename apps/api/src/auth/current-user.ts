import type { IncomingHttpHeaders } from 'node:http';
import { and, eq, lt, sql } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type { Auth } from './auth.ts';
import type { AuthenticatedUser, CurrentUser } from './guards.ts';

/** last_seen_at is written at most this often per user (authentication-and-sessions D7). */
export const LAST_SEEN_EVERY_SECONDS = 300;

// display_name defaults to the provider name, else the part of the email before "@".
function initialDisplayName(name: string, email: string): string {
  return name.trim() || email.split('@')[0] || 'Unnamed';
}

/**
 * The one way app code learns who is calling (authentication-and-sessions D7, invariant 10).
 * Creates the domain `users` row on first use, so a crash between "auth user created" and
 * "domain row created" heals on the next request. After that, display_name belongs to the
 * domain layer and provider profile changes do not overwrite it.
 */
export function createCurrentUser(auth: Auth, db: Db): CurrentUser {
  return async (headers: IncomingHttpHeaders): Promise<AuthenticatedUser | null> => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session) return null;
    const { id, name, email } = session.user;
    await db
      .insert(users)
      .values({ id, displayName: initialDisplayName(name, email) })
      .onConflictDoNothing();
    // Conditional update: inside the interval nothing is written, not even the same value.
    await db
      .update(users)
      .set({ lastSeenAt: sql`now()` })
      .where(
        and(
          eq(users.id, id),
          lt(users.lastSeenAt, sql`now() - make_interval(secs => ${LAST_SEEN_EVERY_SECONDS})`),
        ),
      );
    const [user] = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, id));
    return user ?? null;
  };
}
