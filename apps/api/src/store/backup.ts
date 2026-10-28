import { and, desc, eq, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { backupEvents, googleConnections, googleOauthStates } from '../db/schema.ts';

// The Drive connection side of the Google copy (server-backup-and-google-docs D9, D10): who
// is connected to which Google account, started authorizations, and the backup page's
// problem list. Token ciphertext passes through here as bytes; nothing here decrypts it.

export type ConnectionRow = typeof googleConnections.$inferSelect;
export type BackupEventKind = (typeof backupEvents.$inferSelect)['kind'];

export function createBackupStore(db: Db) {
  return {
    connection: async (userId: string): Promise<ConnectionRow | null> =>
      (await db.select().from(googleConnections).where(eq(googleConnections.userId, userId)))[0] ??
      null,

    async saveAuthorization(
      userId: string,
      stateSha256: Uint8Array,
      codeVerifier: string,
      expiresAt: Date,
    ) {
      // One open authorization per person: starting again replaces the earlier one.
      await db.transaction(async (tx) => {
        await tx.delete(googleOauthStates).where(eq(googleOauthStates.userId, userId));
        await tx.insert(googleOauthStates).values({ stateSha256, userId, codeVerifier, expiresAt });
      });
    },

    /** The verifier of `userId`'s unexpired authorization with this state, used up either way. */
    async takeAuthorization(
      userId: string,
      stateSha256: Uint8Array,
      now: Date,
    ): Promise<string | null> {
      const [row] = await db
        .delete(googleOauthStates)
        .where(eq(googleOauthStates.stateSha256, stateSha256))
        .returning();
      if (!row || row.userId !== userId || row.expiresAt <= now) return null;
      return row.codeVerifier;
    },

    /**
     * Stores the new connection unless the old grant is still being revoked: revoking a
     * Google grant revokes every token of it, so a later revoke would end the new one too.
     */
    async connect(
      row: Omit<ConnectionRow, 'attempts' | 'nextAttemptAt' | 'lastError'>,
    ): Promise<'connected' | 'disconnecting'> {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ status: googleConnections.status })
          .from(googleConnections)
          .where(eq(googleConnections.userId, row.userId))
          .for('update');
        if (existing?.status === 'revoking') return 'disconnecting';
        await tx
          .insert(googleConnections)
          .values(row)
          .onConflictDoUpdate({
            target: googleConnections.userId,
            set: { ...row, attempts: 0, nextAttemptAt: sql`now()`, lastError: null },
          });
        return 'connected';
      });
    },

    /** Hands the grant to the worker to revoke; the page shows it as disconnecting until then. */
    async disconnect(userId: string): Promise<void> {
      await db
        .update(googleConnections)
        .set({ status: 'revoking', attempts: 0, nextAttemptAt: sql`now()`, lastError: null })
        .where(eq(googleConnections.userId, userId));
    },

    /** The next grant due for revocation, locked for this worker until its transaction ends. */
    async withDueRevocation<T>(
      now: Date,
      fn: (row: ConnectionRow, done: RevocationOutcome) => Promise<T>,
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(googleConnections)
          .where(
            and(
              eq(googleConnections.status, 'revoking'),
              lte(googleConnections.nextAttemptAt, now),
            ),
          )
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return null;
        return fn(row, {
          revoked: async () => {
            await tx.delete(googleConnections).where(eq(googleConnections.userId, row.userId));
          },
          retry: async (error: string, at: Date) => {
            await tx
              .update(googleConnections)
              .set({ attempts: row.attempts + 1, nextAttemptAt: at, lastError: error })
              .where(eq(googleConnections.userId, row.userId));
          },
          gaveUp: async () => {
            await tx.delete(googleConnections).where(eq(googleConnections.userId, row.userId));
            await tx.insert(backupEvents).values({ userId: row.userId, kind: 'revoke_failed' });
          },
        });
      });
    },

    async addEvent(userId: string, kind: BackupEventKind, diaryDate: string | null = null) {
      await db.insert(backupEvents).values({ userId, kind, diaryDate });
    },

    events: (userId: string, limit = 20) =>
      db
        .select({ at: backupEvents.at, kind: backupEvents.kind, diaryDate: backupEvents.diaryDate })
        .from(backupEvents)
        .where(eq(backupEvents.userId, userId))
        .orderBy(desc(backupEvents.at))
        .limit(limit),
  };
}

export type RevocationOutcome = {
  revoked(): Promise<void>;
  retry(error: string, at: Date): Promise<void>;
  /** Removes the ciphertext anyway and tells the user to remove the app in their Google account. */
  gaveUp(): Promise<void>;
};

export type BackupStore = ReturnType<typeof createBackupStore>;
