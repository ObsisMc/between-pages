import { useQuery } from '@tanstack/react-query';
import { callApi } from '../api/client.ts';
import { useAppBadge, useBadgeShown } from '../pwa/index.ts';

export const daysUnreadCountKey = ['days', 'unread-count'] as const;

/**
 * installable-pwa D5: the icon badge is the dates with list unread plus the space features'
 * unread, both from the server, read every 45 s while the app is open, hidden windows
 * included, and only where the badge would show. An unread count not yet known, or not
 * readable offline, leaves the badge as it was.
 */
export function useIconBadge(signedIn: boolean, spaceUnread: number | undefined) {
  const shown = useBadgeShown();
  const dates = useQuery({
    queryKey: daysUnreadCountKey,
    queryFn: () => callApi('daysUnreadCount'),
    enabled: signedIn && shown,
    refetchInterval: 45_000,
    refetchIntervalInBackground: true,
  }).data?.dates;
  useAppBadge(
    signedIn && dates !== undefined && spaceUnread !== undefined ? dates + spaceUnread : undefined,
    shown,
  );
}
