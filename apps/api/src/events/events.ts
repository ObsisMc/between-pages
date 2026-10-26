/** A batch that PG has committed, as receivers of the same generation get it (kernel D10). */
export type CommittedEvent = {
  diaryId: string;
  generationId: string;
  seq: number;
  publicId: string;
  /** The server-encoded delta stored on the commit row, never uploaded bytes (D17). */
  delta: Uint8Array;
  bindings: { clientId: number; userId: string }[];
};

type Listener = (event: CommittedEvent) => void;

/**
 * In-process commit events (kernel D11): publish after PG COMMIT, subscribe per diary.
 * Delivery is best effort and this process only; correctness never depends on it,
 * because a connection that missed an event catches up from PG by seq. Running more
 * than one API instance replaces only this module's inside (e.g. LISTEN/NOTIFY).
 */
export function createEvents() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    publish(event: CommittedEvent): void {
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
