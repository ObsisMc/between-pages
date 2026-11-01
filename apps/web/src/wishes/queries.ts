import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { refusalText, spaceUnreadKey } from '../space-common/index.ts';

// Wishes and gifts state (wishes-and-gifts ADR) in TanStack Query: one answer holds both
// lists, the caller's own preparations, the gift wall and deletion notes. While a link is
// still being read it is fetched again soon, so the preview appears without a reload.

export const wishesKey = ['wishes'] as const;
export type WishesView = ResponseOf<'wishes'>;
export type Wish = WishesView['mine'][number];
export type Gift = WishesView['wall'][number];

const pendingPreview = (view: WishesView) =>
  [...view.mine, ...view.theirs, ...view.preparing, ...view.wall].some(
    (r) => r.preview?.state === 'pending',
  );

export const useWishes = () =>
  useQuery({
    queryKey: wishesKey,
    queryFn: () => callApi('wishes'),
    refetchInterval: (query) =>
      query.state.data && pendingPreview(query.state.data) ? 3_000 : 45_000,
  });

/** Runs one write, then refreshes the feature and the entry dots; keeps the refusal text. */
export function useWrite() {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (write: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      await write();
      return true;
    } catch (failure) {
      setError(refusalText(failure));
      return false;
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey: wishesKey });
      await client.invalidateQueries({ queryKey: spaceUnreadKey });
    }
  };
  return { run, error, busy };
}
