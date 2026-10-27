/** A batch that PG has committed, as receivers of the same generation get it (kernel D10). */
export type CommittedEvent = {
  type: 'commit';
  diaryId: string;
  generationId: string;
  /**
   * The epoch stamped on the commit row in its transaction; null for a private commit.
   * Sockets decide recipients from it without asking PG again (D10).
   */
  epochId: string | null;
  seq: number;
  publicId: string;
  /** The server-encoded delta stored on the commit row, never uploaded bytes (D17). */
  delta: Uint8Array;
  bindings: { clientId: number; userId: string }[];
};

/**
 * A diary's sharing changed and PG has committed it (kernel D10): `opened` starts
 * `generationId` as the epoch's baseline; `stopped` froze the epoch.
 */
export type ContextEvent = {
  type: 'context';
  diaryId: string;
  change: 'opened' | 'stopped';
  generationId: string;
  epochId: string;
  recipientId: string;
};

export type DiaryEvent = CommittedEvent | ContextEvent;

type Listener = (event: DiaryEvent) => void;

/**
 * In-process diary events (kernel D11): publish after PG COMMIT, subscribe per diary.
 * Delivery is best effort and this process only; correctness never depends on it,
 * because a connection that missed an event catches up from PG by seq, or learns of a
 * context change from STALE_CONTEXT. Running more than one API instance replaces only
 * this module's inside (e.g. LISTEN/NOTIFY).
 */
export function createEvents() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    publish(event: DiaryEvent): void {
      for (const listener of listeners.get(event.diaryId) ?? []) listener(event);
    },
    /** Returns the unsubscribe function. */
    subscribe(diaryId: string, listener: Listener): () => void {
      const set = listeners.get(diaryId) ?? new Set();
      set.add(listener);
      listeners.set(diaryId, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(diaryId);
      };
    },
  };
}

export type Events = ReturnType<typeof createEvents>;
