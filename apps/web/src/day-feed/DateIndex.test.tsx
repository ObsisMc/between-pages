import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Day } from '@between-pages/contracts';
import { renderAt, stubApi } from '../../test/render.tsx';
import { ME, PARTNER, errorBody } from '../../test/relationship.ts';
import { DateIndex } from './index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = (n: number, more: Partial<NonNullable<Day['mine']>> = {}) => ({
  diaryId: id(n),
  excerpt: '不该出现的摘要',
  updatedAt: '2026-10-27T08:00:00Z',
  hasText: true,
  unread: false,
  sharedWithPartner: true,
  writing: false,
  partnerWriting: false,
  ...more,
});
const shared = (n: number, more: Partial<NonNullable<Day['partner']>> = {}) => ({
  diaryId: id(n),
  epochId: id(100 + n),
  share: 'live' as const,
  excerpt: '对方的摘要',
  updatedAt: '2026-10-27T09:00:00Z',
  hasText: true,
  unread: false,
  writing: false,
  partnerWriting: false,
  ...more,
});
const page =
  (days: Day[], more: { nextBefore?: string; nextAfter?: string } = {}) =>
  () =>
    Response.json({ days, nextBefore: more.nextBefore ?? null, nextAfter: more.nextAfter ?? null });

const people = {
  me: { id: ME, name: 'alice', slot: 1 as const },
  partner: { id: PARTNER, name: 'bob', slot: 2 as const },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const index = () => screen.findByRole('navigation', { name: '日期索引' });
const rowOf = (nav: HTMLElement, date: string) =>
  nav.querySelector<HTMLElement>(`[data-date="${date}"]`)!;
const shownDates = (nav: HTMLElement) =>
  [...nav.querySelectorAll<HTMLElement>('[data-date]')].map((el) => el.dataset.date);
const requested = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);

describe('DateIndex', () => {
  it('[adr:digital-paper-interface#3] lists the dates by month with who wrote and the list’s unread, reading no diary', async () => {
    const fetchMock = stubApi({
      'GET /api/days': page(
        [
          { diaryDate: '2026-11-03', mine: own(1), partner: shared(2, { unread: true }) },
          { diaryDate: '2026-11-01', mine: own(3, { hasText: false }), partner: null },
          { diaryDate: '2026-10-30', mine: null, partner: shared(4) },
        ],
        { nextBefore: '2026-10-30' },
      ),
      'GET /api/days?before=2026-10-30': page([
        { diaryDate: '2026-10-02', mine: own(5), partner: null },
      ]),
    });
    renderAt('/', [{ path: '/', element: <DateIndex {...people} /> }]);
    const nav = await index();
    await waitFor(() => expect(shownDates(nav)).toHaveLength(3));

    expect(
      within(nav)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['2026 年 11 月', '2026 年 10 月']);
    const newest = rowOf(nav, '2026-11-03');
    expect(within(newest).getByRole('link').getAttribute('href')).toBe('/days/2026-11-03');
    expect(newest.textContent).toContain('11 月 3 日 · 周二');
    expect(newest.textContent).toContain('alice、bob');
    expect(within(newest).getByRole('img', { name: '有新内容' })).toBeDefined();
    expect(rowOf(nav, '2026-11-01').textContent).toContain('还没有写字');
    expect(rowOf(nav, '2026-10-30').textContent).toContain('bob');
    expect(within(rowOf(nav, '2026-10-30')).queryByRole('img')).toBeNull();
    // Dates only: no excerpt is shown and no diary is read.
    expect(nav.textContent).not.toContain('摘要');

    fireEvent.click(within(nav).getByRole('button', { name: '更早的日期' }));
    await waitFor(() => expect(shownDates(nav)).toContain('2026-10-02'));
    expect(within(nav).getByText('已经是最早的一天')).toBeDefined();
    expect(requested(fetchMock)).toEqual(['GET /api/days', 'GET /api/days?before=2026-10-30']);
  });

  it('[adr:book-frontend-workspace#4] jumps to a chosen date not loaded with two requests around it and marks it', async () => {
    const fetchMock = stubApi({
      'GET /api/days?before=2026-06-11': page(
        [{ diaryDate: '2026-06-08', mine: own(3), partner: null }],
        { nextBefore: '2026-06-08' },
      ),
      'GET /api/days?after=2026-06-10': page(
        [{ diaryDate: '2026-06-20', mine: null, partner: shared(4) }],
        { nextAfter: '2026-06-20' },
      ),
    });
    renderAt('/', [{ path: '/', element: <DateIndex {...people} chosenDate="2026-06-10" /> }]);
    const nav = await index();
    await waitFor(() =>
      expect(shownDates(nav)).toEqual(['2026-06-20', '2026-06-10', '2026-06-08']),
    );
    const chosen = within(rowOf(nav, '2026-06-10')).getByRole('link');
    expect(chosen.getAttribute('aria-current')).toBe('page');
    expect(chosen.textContent).toContain('没有可以读的日记');
    expect(within(nav).getByRole('button', { name: '更新的日期' })).toBeDefined();
    expect(requested(fetchMock)).toEqual([
      'GET /api/days?before=2026-06-11',
      'GET /api/days?after=2026-06-10',
    ]);
  });

  it('hands a chosen date to onChoose instead of navigating', async () => {
    stubApi({
      'GET /api/days': page([{ diaryDate: '2026-11-03', mine: own(1), partner: null }]),
    });
    const onChoose = vi.fn();
    const { router } = renderAt('/', [
      { path: '/', element: <DateIndex {...people} onChoose={onChoose} /> },
    ]);
    const nav = await index();
    fireEvent.click(await within(nav).findByRole('link', { name: /11 月 3 日/ }));
    expect(onChoose).toHaveBeenCalledWith('2026-11-03');
    expect(router.state.location.pathname).toBe('/');
  });

  it('keeps the dates but no unread marks while the list cannot be read, and recovers with 重试', async () => {
    let fail = false;
    stubApi({
      'GET /api/days': () =>
        fail
          ? errorBody('INTERNAL', 500)()
          : page([{ diaryDate: '2026-11-03', mine: null, partner: shared(2, { unread: true }) }])(),
    });
    renderAt('/', [{ path: '/', element: <DateIndex {...people} /> }]);
    const nav = await index();
    expect(await within(nav).findByRole('img', { name: '有新内容' })).toBeDefined();

    fail = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    expect((await within(nav).findByRole('alert')).textContent).toBe('日期读取失败');
    expect(shownDates(nav)).toEqual(['2026-11-03']);
    expect(within(nav).queryByRole('img', { name: '有新内容' })).toBeNull();

    fail = false;
    fireEvent.click(within(nav).getByRole('button', { name: '重试' }));
    expect(await within(nav).findByRole('img', { name: '有新内容' })).toBeDefined();
    expect(within(nav).queryByRole('alert')).toBeNull();
  });
});
