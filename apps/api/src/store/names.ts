import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { activeBindings, users } from '../db/schema.ts';
import type { Tx } from './store.ts';
import { registerSpaceCopy } from './together.ts';

// SQL for renaming (display-name D7). The caller's `users` row is the transaction's first
// and only row lock, the same first lock every relationship flow takes, so a rename queues
// behind a binding or unbinding instead of deadlocking with it. The update touches a non-key
// column, a `FOR NO KEY UPDATE` that never blocks the `FOR KEY SHARE` diary creation takes.

export class NameWrites {
  private readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  /** Writes the name; false when it already was this name, and then nothing changed. */
  async rename(userId: string, displayName: string): Promise<boolean> {
    const rows = await this.tx
      .update(users)
      .set({ displayName })
      .where(and(eq(users.id, userId), sql`${users.displayName} is distinct from ${displayName}`))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /** The space the user is bound in now, read without a lock (D7 "与绑定、解绑并发"). */
  async currentSpace(userId: string): Promise<string | null> {
    const [row] = await this.tx
      .select({ spaceId: activeBindings.spaceId })
      .from(activeBindings)
      .where(eq(activeBindings.userId, userId));
    return row?.spaceId ?? null;
  }

  /** Every `Together` Doc of the space, in both Drives, is written again (D4). */
  async copySpace(spaceId: string): Promise<void> {
    await registerSpaceCopy(this.tx, {
      spaceId,
      recordType: null,
      recordId: null,
      privateTo: null,
    });
  }
}

export function createNameStore(db: Db) {
  return {
    /** Runs `work` in one transaction; a throw rolls the name and the copy back together. */
    write<T>(work: (writes: NameWrites) => Promise<T>): Promise<T> {
      return db.transaction((tx) => work(new NameWrites(tx)));
    },
  };
}

export type NameStore = ReturnType<typeof createNameStore>;
