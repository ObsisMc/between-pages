import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isReachable, watchReachable } from './client.ts';

/** Whether the API answers (installable-pwa D4); for what the screen says, never for saving. */
export function useOnline(): boolean {
  return useSyncExternalStore(watchReachable, isReachable);
}

/**
 * Once the API answers again, the queries on screen ask once more, so a page that could not
 * read opens by itself. TanStack Query's own `onlineManager` is left alone: queries it pauses
 * neither send nor fail, which would hold the opening page at "正在打开…".
 */
export function useRefetchOnReconnect() {
  const client = useQueryClient();
  useEffect(() => {
    let was = isReachable();
    return watchReachable(() => {
      const now = isReachable();
      if (now && !was) void client.invalidateQueries();
      was = now;
    });
  }, [client]);
}
