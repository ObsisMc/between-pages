import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { PARTNER, SPACE, space } from '../../test/relationship.ts';

// The Badging API and notification permission are the browser's: jsdom has neither, so
// navigator and Notification stand in for them and record what the app asks.

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CARD = '图标上的未读角标需要通知权限，只用来显示角标，不会发通知。';

type Unread = { dates: number; wishes: number; anniversaries: number; sharedPages: number };

/** The home of a bound account, with the two badge sources as `unread` says at each read. */
function home(unread: Unread) {
  return stubApi({
    ...noRelationship,
    'GET /api/me': signedIn('alice'),
    'GET /api/binding': () =>
      Response.json({ binding: { space: space(), periodId: SPACE }, invitation: null }),
    'GET /api/spaces': () => Response.json({ spaces: [space()] }),
    'GET /api/pokes': () => Response.json({ received: null }),
    'GET /api/clocks': () =>
      Response.json({
        me: { timezone: zone, sleep: null },
        partner: { user: { id: PARTNER, displayName: 'bob' }, timezone: zone, sleep: null },
      }),
    'GET /api/days': () => Response.json({ days: [], nextBefore: null, nextAfter: null }),
    'GET /api/days/next-unread': () => Response.json({ date: null }),
    'GET /api/days/unread-count': () => Response.json({ dates: unread.dates }),
    'GET /api/space/unread': () =>
      Response.json({
        features: {
          wishes: unread.wishes,
          anniversaries: unread.anniversaries,
          sharedPages: unread.sharedPages,
        },
      }),
    'POST /api/auth/sign-out': () => Response.json({ success: true }),
  });
}

/** A browser with the Badging API; `standalone` true makes it an iPhone home-screen app. */
function badging(more: { standalone?: boolean } = {}) {
  const badge = {
    setAppBadge: vi.fn(async (count?: number) => void count),
    clearAppBadge: vi.fn(async () => undefined),
  };
  vi.stubGlobal('navigator', { ...badge, ...more });
  return badge;
}

/** Notification permission as the browser keeps it; only `requestPermission` changes it. */
function notifications(answer: NotificationPermission) {
  const stand = {
    permission: 'default' as NotificationPermission,
    requestPermission: vi.fn(async () => (stand.permission = answer)),
  };
  vi.stubGlobal('Notification', stand);
  return stand;
}

const asked = (api: ReturnType<typeof stubApi>, path: string) =>
  api.mock.calls.some(([url]) => String(url) === path);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the icon badge', () => {
  it('[adr:installable-pwa#7] shows the unread dates plus the space records, and clears at none and on signing out', async () => {
    const badge = badging();
    notifications('granted');
    const unread = { dates: 2, wishes: 1, anniversaries: 1, sharedPages: 3 };
    home(unread);
    const { client } = renderAt('/');
    await waitFor(() => expect(badge.setAppBadge).toHaveBeenLastCalledWith(7));

    Object.assign(unread, { dates: 0, wishes: 0, anniversaries: 0, sharedPages: 1 });
    await client.refetchQueries();
    await waitFor(() => expect(badge.setAppBadge).toHaveBeenLastCalledWith(1));
    unread.sharedPages = 0;
    await client.refetchQueries();
    await waitFor(() => expect(badge.clearAppBadge).toHaveBeenCalledTimes(1));
    // iOS has no badge without a number: it is never set without one.
    expect(badge.setAppBadge.mock.calls.every(([count]) => typeof count === 'number')).toBe(true);

    unread.dates = 1;
    await client.refetchQueries();
    await waitFor(() => expect(badge.setAppBadge).toHaveBeenLastCalledWith(1));
    fireEvent.keyDown(await screen.findByRole('button', { name: '账号：alice' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '退出' }));
    await waitFor(() => expect(badge.clearAppBadge).toHaveBeenCalledTimes(2));
  });

  it('does nothing where the browser has no badge', async () => {
    vi.stubGlobal('navigator', {});
    const api = home({ dates: 2, wishes: 0, anniversaries: 0, sharedPages: 0 });
    renderAt('/');
    await screen.findByRole('button', { name: '账号：alice' });
    await screen.findByText('最近的几页');
    expect(asked(api, '/api/days/unread-count')).toBe(false);
    expect(screen.queryByText(CARD)).toBeNull();
  });
});

describe('the notification permission card', () => {
  it('[adr:installable-pwa#8] asks only in the iPhone home-screen app, on 「好的」, and goes once asked; allowed, the badge works', async () => {
    const badge = badging({ standalone: true });
    const permission = notifications('granted');
    const api = home({ dates: 2, wishes: 0, anniversaries: 0, sharedPages: 0 });
    renderAt('/');
    expect(await screen.findByText(CARD)).toBeDefined();
    // Without the permission Safari shows no badge, so nothing is read for it.
    expect(asked(api, '/api/days/unread-count')).toBe(false);
    expect(badge.setAppBadge).not.toHaveBeenCalled();
    expect(permission.requestPermission).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /不用|关闭/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '好的' }));
    await waitFor(() => expect(screen.queryByText(CARD)).toBeNull());
    expect(permission.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(badge.setAppBadge).toHaveBeenLastCalledWith(2));
  });

  it('[adr:installable-pwa#8] goes away after a refusal too, leaving no badge', async () => {
    const badge = badging({ standalone: true });
    const permission = notifications('denied');
    home({ dates: 2, wishes: 0, anniversaries: 0, sharedPages: 0 });
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: '好的' }));
    await waitFor(() => expect(screen.queryByText(CARD)).toBeNull());
    expect(permission.requestPermission).toHaveBeenCalledTimes(1);
    expect(badge.setAppBadge).not.toHaveBeenCalled();
  });

  it('[adr:installable-pwa#8] never shows or asks outside the iPhone home-screen app', async () => {
    badging();
    const permission = notifications('granted');
    home({ dates: 0, wishes: 0, anniversaries: 0, sharedPages: 0 });
    renderAt('/');
    await screen.findByText('最近的几页');
    expect(screen.queryByText(CARD)).toBeNull();
    expect(permission.requestPermission).not.toHaveBeenCalled();
  });

  it('[adr:installable-pwa#8] the app has no code that shows a notification or subscribes to push', () => {
    const source = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? source(join(dir, entry.name))
          : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
            ? [readFileSync(join(dir, entry.name), 'utf8')]
            : [],
      );
    const files = source(join(import.meta.dirname, '..'));
    expect(files.length).toBeGreaterThan(50);
    for (const text of files)
      expect(text).not.toMatch(/showNotification|new Notification|pushManager/);
  });
});
