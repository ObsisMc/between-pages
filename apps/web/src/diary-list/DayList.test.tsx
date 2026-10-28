import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Day } from '@between-pages/contracts';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { space } from '../../test/relationship.ts';
import { REFRESH_MS } from './index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mine = (n: number, excerpt: string | null, unread = false) => ({
  diaryId: id(n),
  excerpt,
  updatedAt: '2026-10-27T08:00:00Z',
  hasText: !!excerpt,
  unread,
  sharedWithPartner: true,
});
const theirs = (
  n: number,
  excerpt: string | null,
  unread = false,
  share: 'live' | 'frozen' = 'live',
) => ({
  diaryId: id(n),
  epochId: id(100 + n),
  share,
  excerpt,
  updatedAt: '2026-10-27T09:00:00Z',
  hasText: !!excerpt,
  unread,
});
const page =
  (days: Day[], nextBefore: string | null = null) =>
  () =>
    Response.json({ days, nextBefore });

const bound = {
  'GET /api/me': signedIn('alice'),
  'GET /api/binding': () =>
    Response.json({ binding: { space: space(), periodId: id(900) }, invitation: null }),
  'GET /api/spaces': () => Response.json({ spaces: [space()] }),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const list = () => screen.findByRole('region', { name: '日记' });

describe('DayList', () => {
  it('shows one card per date with both people’s avatars, an unread dot and a link to the day', async () => {
    stubApi({
      ...bound,
      'GET /api/days': page(
        [
          {
            diaryDate: '2026-10-27',
            mine: mine(1, '今天下雨'),
            partner: theirs(2, '我也写了', true),
          },
          { diaryDate: '2026-10-26', mine: null, partner: theirs(3, '', false, 'frozen') },
          { diaryDate: '2026-10-25', mine: mine(4, null), partner: null },
        ],
        '2026-10-25',
      ),
      'GET /api/days?before=2026-10-25': page([
        { diaryDate: '2026-10-20', mine: mine(5, ''), partner: null },
      ]),
    });
    const { router } = renderAt('/');

    const region = await list();
    await within(region).findByText('今天下雨');
    const cards = within(region).getAllByRole('listitem');
    // Avatars in slot order, by initial; hollow when that diary has no text yet.
    expect(
      within(cards[0]!)
        .getAllByRole('img')
        .map((img) => img.getAttribute('aria-label')),
    ).toEqual(['alice', 'bob', '有新内容']);
    expect(within(cards[0]!).getByLabelText('alice').textContent).toBe('A');
    expect(within(cards[0]!).getByLabelText('bob').className).toContain('author-slot-2');
    expect(within(cards[1]!).getByLabelText('bob（还没有写字）').className).toContain('hollow');
    expect(within(cards[1]!).queryByLabelText('有新内容')).toBeNull();
    expect(within(cards[1]!).getByText('已停止共享')).toBeDefined();
    expect(within(cards[2]!).getByText('这篇暂时无法读取')).toBeDefined();
    expect(
      within(region)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/days/2026-10-27', '/days/2026-10-27', '/days/2026-10-26', `/diaries/${id(4)}`]);

    fireEvent.click(within(region).getByText('加载更早的日记'));
    await within(region).findByText('还没有写字');
    expect(within(region).queryByText('加载更早的日记')).toBeNull();

    fireEvent.click(within(region).getByText('我也写了'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days/2026-10-27'));
  });

  it('reads the list again every 45 s and on coming back, keeping the pages loaded', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let unread = false;
    const first = vi.fn(() =>
      Response.json({
        days: [{ diaryDate: '2026-10-27', mine: mine(1, '早上', unread), partner: null }],
        nextBefore: '2026-10-27',
      }),
    );
    const second = vi.fn(page([{ diaryDate: '2026-10-20', mine: mine(2, '更早'), partner: null }]));
    stubApi({ ...bound, 'GET /api/days': first, 'GET /api/days?before=2026-10-27': second });
    renderAt('/');
    const region = await list();
    fireEvent.click(await within(region).findByText('加载更早的日记'));
    await within(region).findByText('更早');
    expect(within(region).queryByLabelText('有新内容')).toBeNull();

    unread = true;
    act(() => void vi.advanceTimersByTime(REFRESH_MS));
    await within(region).findByLabelText('有新内容');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(within(region).getByText('更早')).toBeDefined();

    unread = false;
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(within(region).queryByLabelText('有新内容')).toBeNull());
    expect(first).toHaveBeenCalledTimes(3);
  });

  it('keeps the cards without unread dots when reading again fails', async () => {
    let up = true;
    stubApi({
      ...bound,
      'GET /api/days': () =>
        up
          ? page([{ diaryDate: '2026-10-27', mine: mine(1, '早上', true), partner: null }])()
          : Promise.reject(new TypeError('Failed to fetch')),
    });
    renderAt('/');
    const region = await list();
    await within(region).findByLabelText('有新内容');

    up = false;
    act(() => void window.dispatchEvent(new Event('focus')));
    expect((await within(region).findByRole('alert')).textContent).toBe(
      '离线时无法读取日记列表，联网后再试',
    );
    expect(within(region).getByText('早上')).toBeDefined();
    expect(within(region).queryByLabelText('有新内容')).toBeNull();
  });

  it('invites a first diary when there is none, and says it cannot read the list offline', async () => {
    stubApi({ ...bound, 'GET /api/days': page([]) });
    renderAt('/');
    expect(await within(await list()).findByText('还没有日记，从今天开始写吧')).toBeDefined();
    cleanup();

    stubApi({ ...bound, 'GET /api/days': () => Promise.reject(new TypeError('Failed to fetch')) });
    renderAt('/');
    const region = await list();
    expect((await within(region).findByRole('alert')).textContent).toBe(
      '离线时无法读取日记列表，联网后再试',
    );
    expect(within(region).queryByText('还没有日记，从今天开始写吧')).toBeNull();
  });
});
