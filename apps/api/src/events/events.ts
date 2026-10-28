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

/** A session was signed out or revoked and its deletion committed (kernel D10 "会话"). */
export type SessionEndedEvent = { type: 'session-ended'; sessionId: string };

export type Event = DiaryEvent | SessionEndedEvent;

/** What a listener hears: one diary's events, or the end of one session. */
export type Topic = { diaryId: string } | { sessionId: string };
type EventOf<T extends Topic> = T extends { diaryId: string } ? DiaryEvent : SessionEndedEvent;

const keyOf = (topic: Topic) =>
  'diaryId' in topic ? `diary:${topic.diaryId}` : `session:${topic.sessionId}`;

/**
 * In-process events (kernel D11): publish after PG COMMIT, subscribe per diary or per
 * session. Delivery is best effort and this process only; correctness never depends on
 * it, because a connection that missed an event catches up from PG by seq, learns of a
 * context change from STALE_CONTEXT, and of an ended session from its next write or the
 * 60 s recheck. Running more than one API instance replaces only this module's inside
 * (e.g. LISTEN/NOTIFY).
 */
export function createEvents() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    publish(event: Event): void {
      const key = keyOf(event.type === 'session-ended' ? event : { diaryId: event.diaryId });
      for (const listener of listeners.get(key) ?? []) listener(event);
    },
    /** Returns the unsubscribe function. */
    subscribe<T extends Topic>(topic: T, listener: (event: EventOf<T>) => void): () => void {
      const key = keyOf(topic);
      const set = listeners.get(key) ?? new Set();
      const heard = listener as (event: Event) => void;
      set.add(heard);
      listeners.set(key, set);
      return () => {
        set.delete(heard);
        if (!set.size) listeners.delete(key);
      };
    },
  };
}

export type Events = ReturnType<typeof createEvents>;
