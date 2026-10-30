import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';
import { refusalText, spaceUnreadKey } from '../space-common/index.ts';

// Anniversaries state (anniversaries ADR) in TanStack Query. Every request carries the
// browser's zone, which counts the caller's own birthday and stands in while the partner's
// zone is unknown (partner-local-dates D1, D2); the server picks the basis.

export const anniversariesKey = ['anniversaries'] as const;
export type AnniversariesView = ResponseOf<'anniversaries'>;
export type Anniversary = AnniversariesView['anniversaries'][number];
export type People = Pick<AnniversariesView, 'me' | 'partner'>;

/** The browser's IANA zone right now. */
export const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const useAnniversaries = () =>
  useQuery({
    queryKey: anniversariesKey,
    queryFn: () => callApi('anniversaries', { query: { timezone: zone() } }),
    refetchInterval: 60_000,
  });

export const useAnniversary = (id: string) =>
  useQuery({
    queryKey: [...anniversariesKey, id],
    queryFn: () =>
      callApi('anniversary', { params: { anniversaryId: id }, query: { timezone: zone() } }),
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
      await client.invalidateQueries({ queryKey: anniversariesKey });
      await client.invalidateQueries({ queryKey: spaceUnreadKey });
    }
  };
  return { run, error, busy };
}
