import type { ResponseOf } from '@between-pages/contracts';
import type { NameStore } from '../store/names.ts';

// Renaming (display-name ADR). The name is the caller's own `users.display_name`, which every
// screen, mail and Doc reads when it is shown or written, so nothing else is updated here
// except the `Together` Docs, whose summaries promise the current state (D3, D4).

export function createDisplayNameService(store: NameStore) {
  return {
    /** `displayName` has passed the contract's `DisplayName`; `caller` comes from the session. */
    rename(caller: string, displayName: string): Promise<ResponseOf<'updateMe'>> {
      return store.write(async (writes) => {
        if (await writes.rename(caller, displayName)) {
          const spaceId = await writes.currentSpace(caller);
          if (spaceId) await writes.copySpace(spaceId);
        }
        return { user: { id: caller, displayName } };
      });
    },
  };
}

export type DisplayNameService = ReturnType<typeof createDisplayNameService>;
