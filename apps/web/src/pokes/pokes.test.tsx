import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { PARTNER, SPACE, space } from '../../test/relationship.ts';

// The home's mascots (window-mascots ADR): playing with one's own sends nothing, the
// partner's sends pokes and pets, what arrived is said once and confirmed by count, and the
// partner's mascot sleeps only by their sleep schedule.

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const LAST_AT = '2026-11-03T09:02:00.000Z';

/** A sleep schedule on the 15-minute grid around this minute, or away from it. */
function sleepAround(asleep: boolean) {
  const now = new Date();
  const minute = Math.floor((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  const at = (offset: number) => (((minute + offset) % 1440) + 1440) % 1440;
  return asleep ? { start: at(-60), end: at(60) } : { start: at(120), end: at(240) };
}

function openHome(
  more: Parameters<typeof stubApi>[0] = {},
  partnerSleep: { start: number; end: number } | null = null,
) {
  return stubApi({
    ...noRelationship,
    'GET /api/me': signedIn('alice'),
    'GET /api/binding': () =>
      Response.json({
        binding: { space: space(), periodId: SPACE },
        invitation: null,
        invitationsForMe: [],
      }),
    'GET /api/spaces': () => Response.json({ spaces: [space()] }),
    'GET /api/clocks': () =>
      Response.json({
        me: { timezone: zone, sleep: null },
        partner: { user: { id: PARTNER, displayName: 'bob' }, timezone: zone, sleep: partnerSleep },
      }),
    'GET /api/days': () => Response.json({ days: [], nextBefore: null, nextAfter: null }),
    'GET /api/days/next-unread': () => Response.json({ date: null }),
    'GET /api/pokes': () => Response.json({ received: null }),
    'POST /api/pokes': () => Response.json({ received: null }),
    ...more,
  });
}

const posts = (api: ReturnType<typeof stubApi>) =>
  api.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => [String(url), JSON.parse(String(init!.body))]);

beforeEach(() => {
  // jsdom has no pointer capture; the mascot asks for it when pressed.
  Element.prototype.setPointerCapture = () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the home mascots', () => {
  it('[adr:window-mascots#1] play in this browser only when poked or petted on the own side', async () => {
    const api = openHome();
    renderAt('/');
    const mine = await screen.findByRole('button', { name: '戳戳或摸摸自己的团子' });
    fireEvent.click(mine);
    expect(await screen.findByText(/^(嘿嘿|痒～|在呢|别闹啦)$/)).toBeDefined();
    fireEvent.pointerDown(mine, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(mine, { pointerId: 1, clientX: 30, clientY: 0 });
    fireEvent.pointerUp(mine, { pointerId: 1, clientX: 30, clientY: 0 });
    expect(await screen.findByText('好舒服～')).toBeDefined();
    expect(posts(api)).toEqual([]);
  });

  it('sends a tap on the partner as a poke, counting a streak, and a drag as one pet', async () => {
    const api = openHome();
    renderAt('/');
    const theirs = await screen.findByRole('button', { name: '戳戳或摸摸bob' });
    fireEvent.click(theirs);
    expect(await screen.findByText('戳了bob一下')).toBeDefined();
    fireEvent.click(theirs);
    expect(await screen.findByText('戳了bob 2 下')).toBeDefined();
    fireEvent.pointerDown(theirs, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(theirs, { pointerId: 1, clientX: 10, clientY: 0 });
    fireEvent.pointerMove(theirs, { pointerId: 1, clientX: 30, clientY: 0 });
    fireEvent.pointerUp(theirs, { pointerId: 1, clientX: 30, clientY: 0 });
    // The click that ends a drag is not a poke.
    fireEvent.click(theirs);
    expect(await screen.findByText('摸了摸bob')).toBeDefined();
    await waitFor(() =>
      expect(posts(api)).toEqual([
        ['/api/pokes', { kind: 'poke' }],
        ['/api/pokes', { kind: 'poke' }],
        ['/api/pokes', { kind: 'pet' }],
      ]),
    );
  });

  it('[adr:window-mascots#4] says what arrived, and confirms it by count once', async () => {
    let waiting: object | null = { pokes: 2, pets: 1, lastAt: LAST_AT };
    const seen = vi.fn((init: RequestInit | undefined) => {
      void init;
      waiting = null;
      return Response.json({ received: null });
    });
    openHome({
      'GET /api/pokes': () => Response.json({ received: waiting }),
      'POST /api/pokes/seen': seen,
    });
    renderAt('/');
    const time = new Date(LAST_AT).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(await screen.findByText(`bob 在 ${time} 戳了你 2 下，摸了摸你`)).toBeDefined();
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(seen.mock.calls[0]![0]!.body))).toEqual({ pokes: 2, pets: 1 });
  });

  it('[adr:window-mascots#5] lets the partner sleep only inside their sleep schedule', async () => {
    openHome({}, sleepAround(true));
    renderAt('/');
    // The clocks say so too: the same rule as "大概在睡".
    expect(await screen.findByText(/大概在睡/)).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: '戳戳或摸摸bob' }));
    expect(await screen.findByText('嘘…bob大概在睡')).toBeDefined();
    cleanup();

    openHome({}, sleepAround(false));
    renderAt('/');
    expect(await screen.findByText('TA 那边')).toBeDefined();
    expect(screen.queryByText(/大概在睡/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '戳戳或摸摸bob' }));
    expect(await screen.findByText('戳了bob一下')).toBeDefined();
    cleanup();

    // No schedule set: awake.
    openHome({}, null);
    renderAt('/');
    expect(await screen.findByText('TA 那边')).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: '戳戳或摸摸bob' }));
    expect(await screen.findByText('戳了bob一下')).toBeDefined();
  });

  it('[adr:window-mascots#2] offers nobody to poke while unbound', async () => {
    const api = stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': () => Response.json({ days: [], nextBefore: null, nextAfter: null }),
      'GET /api/days/next-unread': () => Response.json({ date: null }),
    });
    renderAt('/');
    expect(await screen.findByRole('button', { name: '戳戳或摸摸自己的团子' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /戳戳或摸摸(?!自己)/ })).toBeNull();
    expect(api.mock.calls.some(([url]) => String(url).startsWith('/api/pokes'))).toBe(false);
  });
});
