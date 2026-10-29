import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { callApi } from '../api/client.ts';

// Two-clocks state (two-clocks ADR) lives in TanStack Query, refreshed on focus like the
// relationship answers; the partner's part is null unless the two are bound (D5).

export const clocksKey = ['clocks'] as const;

export const useClocks = () => useQuery({ queryKey: clocksKey, queryFn: () => callApi('clocks') });

/** The browser's IANA zone right now; it follows the system setting while travelling (D1). */
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The current time, moving on every `everyMs` so the clocks keep up. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * Reports the browser's zone when it differs from the last one stored, on mount and each time
 * the page comes back to the foreground (D1). A failed report is retried on the next of those.
 */
export function useTimezoneReport() {
  const client = useQueryClient();
  const stored = useClocks().data?.me.timezone;
  useEffect(() => {
    if (stored === undefined) return;
    let sent: string | null = stored;
    const report = () => {
      const zone = browserZone();
      if (document.visibilityState !== 'visible' || zone === sent) return;
      sent = zone;
      callApi('reportTimezone', { body: { timezone: zone } }).then(
        (me) => client.setQueryData(clocksKey, (old) => old && { ...old, me }),
        () => {
          sent = stored;
        },
      );
    };
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [client, stored]);
}
