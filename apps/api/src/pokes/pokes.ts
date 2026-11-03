import type { ResponseOf } from '@between-pages/contracts';
import type { PokeKind, PokeStore, Waiting } from '../store/pokes.ts';

// Pokes and pets between the two people bound now (window-mascots ADR). The sender and the
// recipient come from the session and the current binding; every answer is the caller's own
// waiting pokes, so a sender never learns whether or when the partner saw anything (D4,
// invariant 3).

type Pokes = ResponseOf<'pokes'>;

const answer = (waiting: Waiting): Pokes => ({
  received: waiting && {
    pokes: waiting.pokes,
    pets: waiting.pets,
    lastAt: waiting.lastAt.toISOString(),
  },
});

export function createPokeService(store: PokeStore) {
  return {
    async waiting(caller: string): Promise<Pokes> {
      return answer(await store.waiting(caller));
    },

    /** Null without a current binding: there is nobody to poke (D4). */
    async send(caller: string, kind: PokeKind, now: Date): Promise<Pokes | null> {
      if (!(await store.send(caller, kind, now))) return null;
      return answer(await store.waiting(caller));
    },

    async seen(caller: string, shown: { pokes: number; pets: number }): Promise<Pokes> {
      return answer(await store.seen(caller, shown));
    },
  };
}

export type PokeService = ReturnType<typeof createPokeService>;
