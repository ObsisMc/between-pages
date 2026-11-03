import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { PARTNER, SPACE, space } from '../../test/relationship.ts';

const today = new Intl.DateTimeFormat('en-CA').format(new Date());
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const bound = {
  'GET /api/binding': () =>
    Response.json({ binding: { space: space(), periodId: SPACE }, invitation: null }),
  'GET /api/spaces': () => Response.json({ spaces: [space()] }),
  'GET /api/clocks': () =>
    Response.json({
      me: { timezone: zone, sleep: null },
      partner: { user: { id: PARTNER, displayName: 'bob' }, timezone: zone, sleep: null },
    }),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('[adr:opening-book-home#1] [adr:book-frontend-workspace#2] shows no diary text and never asks for diaries', async () => {
    const days = vi.fn(() =>
      Response.json({
        days: [
          {
            diaryDate: today,
            mine: {
              diaryId: '7c1d2b8e-3f4a-4b5c-8d6e-9f0a1b2c3d4e',
              excerpt: '今天下雨',
              updatedAt: '2026-10-27T08:00:00Z',
              hasText: true,
              unread: false,
              sharedWithPartner: false,
              writing: false,
            },
            partner: null,
          },
        ],
        nextBefore: null,
        nextAfter: null,
      }),
    );
    stubApi({
      ...noRelationship,
      ...bound,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': days,
    });
    renderAt('/');
    expect(await screen.findByText('TA 那边')).toBeDefined();
    expect(await screen.findByRole('link', { name: '浏览所有日记' })).toBeDefined();
    expect(days).not.toHaveBeenCalled();
    expect(screen.queryByText(/今天下雨/)).toBeNull();
  });

  it("[adr:opening-book-home#3] [adr:book-frontend-workspace#2] leads to today's diary and to all diaries", async () => {
    stubApi({ ...noRelationship, 'GET /api/me': signedIn('alice') });
    const { router } = renderAt('/');
    const todayLink = await screen.findByRole('link', { name: '打开今天的日记' });
    expect(todayLink.getAttribute('href')).toBe(`/days/${today}`);
    expect(screen.getByRole('link', { name: '浏览所有日记' }).getAttribute('href')).toBe('/days');

    fireEvent.click(todayLink);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/days/${today}`));
  });

  it('[adr:opening-book-home#5] offers the invitation instead of the partner while unbound', async () => {
    stubApi({ ...noRelationship, 'GET /api/me': signedIn('alice') });
    renderAt('/');
    expect(await screen.findByText('生成邀请链接')).toBeDefined();
    expect(await screen.findByText('我这边')).toBeDefined();
    expect(screen.queryByText(/TA 那边|醒着/)).toBeNull();
  });

  it('[adr:opening-book-home#5] keeps the archived space and the restore invitation after unbinding, without the partner', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/spaces': () => Response.json({ spaces: [space('archived')] }),
    });
    renderAt('/');
    expect(await screen.findByText('邀请原搭档恢复关系')).toBeDefined();
    expect(screen.getByRole('link', { name: '与 bob 的空间' }).getAttribute('href')).toBe(
      `/spaces/${SPACE}`,
    );
    expect(screen.queryByText(/TA 那边|醒着/)).toBeNull();
  });

  it('shows the partner and the current space in place of the invitation while bound', async () => {
    stubApi({ ...noRelationship, ...bound, 'GET /api/me': signedIn('alice') });
    renderAt('/');
    expect(await screen.findByText('TA 那边')).toBeDefined();
    expect((await screen.findByRole('link', { name: '与 bob 的空间' })).getAttribute('href')).toBe(
      `/spaces/${SPACE}`,
    );
    expect(screen.queryByText(/邀请/)).toBeNull();
  });
});
