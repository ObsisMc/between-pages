import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, stubApi } from '../../test/render.tsx';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const card = (n: number, diaryDate: string, excerpt: string | null) => ({
  diaryId: id(n),
  diaryDate,
  excerpt,
  updatedAt: '2026-10-27T08:00:00Z',
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const list = () => screen.findByRole('region', { name: '我的日记' });

describe('DiaryList', () => {
  it('shows the diaries as cards, newest first, loads older ones and opens a card', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/diaries': () =>
        Response.json({
          diaries: [card(3, '2026-10-27', '今天下雨'), card(2, '2026-10-26', '')],
          nextBefore: '2026-10-26',
        }),
      'GET /api/diaries?before=2026-10-26': () =>
        Response.json({ diaries: [card(1, '2026-10-20', null)], nextBefore: null }),
    });
    const { router } = renderAt('/');

    const region = await list();
    await within(region).findByText('今天下雨');
    expect(within(region).getByText('还没有写字')).toBeDefined();
    fireEvent.click(within(region).getByText('加载更早的日记'));
    await within(region).findByText('这篇暂时无法读取');
    expect(within(region).queryByText('加载更早的日记')).toBeNull();
    const links = within(region).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/diaries/${id(3)}`,
      `/diaries/${id(2)}`,
      `/diaries/${id(1)}`,
    ]);

    fireEvent.click(links[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/diaries/${id(3)}`));
  });

  it('invites a first diary when there is none', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/diaries': () => Response.json({ diaries: [], nextBefore: null }),
    });
    renderAt('/');
    expect(await within(await list()).findByText('还没有日记，从今天开始写吧')).toBeDefined();
  });

  it('says it cannot read the list offline instead of showing none', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/diaries': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    renderAt('/');
    const region = await list();
    expect((await within(region).findByRole('alert')).textContent).toBe(
      '离线时无法读取日记列表，联网后再试',
    );
    expect(within(region).queryByText('还没有日记，从今天开始写吧')).toBeNull();
  });
});
