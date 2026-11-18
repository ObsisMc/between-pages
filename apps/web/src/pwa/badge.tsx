import { useEffect, useSyncExternalStore } from 'react';
import { Button, Card, CardDescription } from '../ui/index.ts';

// installable-pwa D5, D6: the installed icon's badge is the server's unread count. On the
// iPhone home screen Safari shows it only with notification permission, which the app asks
// for once, on a tap of 「好的」; it never shows a notification or subscribes to push.

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
  /** Only an iOS home-screen app has it, set to true. */
  standalone?: boolean;
};
const browser = () => navigator as BadgeNavigator;
const canBadge = () => typeof browser().setAppBadge === 'function';
const homeScreenApp = () => browser().standalone === true;
const permission = () =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

const watchers = new Set<() => void>();
const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};
const usePermission = () => useSyncExternalStore(watch, permission);

/**
 * Whether a badge set now would show: the browser has the Badging API and, in an iPhone
 * home-screen app, notifications are allowed. Elsewhere no permission is needed.
 */
export function useBadgeShown(): boolean {
  const allowed = usePermission();
  return canBadge() && (!homeScreenApp() || allowed === 'granted');
}

/**
 * Puts `count` on the icon while `shown`: 0 clears it, an unknown count (still loading)
 * leaves it as it is. iOS has no badge without a number, so it is always the total.
 */
export function useAppBadge(count: number | undefined, shown: boolean) {
  useEffect(() => {
    if (!shown || count === undefined) return;
    const done = count > 0 ? browser().setAppBadge?.(count) : browser().clearAppBadge?.();
    void done?.catch(() => undefined);
  }, [count, shown]);
}

/** Takes the badge off, as on signing out. */
export function clearAppBadge() {
  if (canBadge())
    void browser()
      .clearAppBadge?.()
      .catch(() => undefined);
}

/**
 * The home page's one request, only in an iPhone home-screen app that has not asked yet. It
 * cannot be skipped: iOS lists the app under 设置 → 通知 only after it asked once (D6).
 */
export function BadgePermissionCard() {
  const asked = usePermission();
  if (!homeScreenApp() || !canBadge() || asked !== 'default') return null;
  const ask = async () => {
    try {
      await Notification.requestPermission();
    } finally {
      for (const watcher of watchers) watcher();
    }
  };
  return (
    <Card className="mb-8 flex-row flex-wrap items-center justify-between gap-3">
      <CardDescription className="text-base text-ink">
        图标上的未读角标需要通知权限，只用来显示角标，不会发通知。
      </CardDescription>
      <Button type="button" onClick={() => void ask().catch(() => undefined)}>
        好的
      </Button>
    </Card>
  );
}
