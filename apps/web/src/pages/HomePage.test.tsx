import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { PARTNER, SPACE, space } from '../../test/relationship.ts';

const today = new Intl.DateTimeFormat('en-CA').format(new Date());
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DIARY = '7c1d2b8e-3f4a-4b5c-8d6e-9f0a1b2c3d4e';
const EPOCH = '8d2e3c9f-4a5b-4c6d-9e7f-0a1b2c3d4e5f';

const bound = {
  'GET /api/binding': () =>
    Response.json({ binding: { space: space(), periodId: SPACE }, invitation: null }),
  'GET /api/spaces': () => Response.json({ spaces: [space()] }),
  'GET /api/pokes': () => Response.json({ received: null }),
  'GET /api/clocks': () =>
    Response.json({
      me: { timezone: zone, sleep: null },
      partner: { user: { id: PARTNER, displayName: 'bob' }, timezone: zone, sleep: null },
    }),
};

/** The day list and the unread search as the home asks for them: nothing written yet. */
const lists = {
  'GET /api/days': () => Response.json({ days: [], nextBefore: null, nextAfter: null }),
  'GET /api/days/next-unread': () => Response.json({ date: null }),
};

const own = (excerpt: string, unread = false) => ({
  diaryId: DIARY,
  excerpt,
  updatedAt: '2026-10-27T08:00:00Z',
  hasText: true,
  unread,
  sharedWithPartner: true,
  writing: false,
});
const theirs = (excerpt: string, unread: boolean) => ({
  diaryId: DIARY,
  epochId: EPOCH,
  share: 'live',
  excerpt,
  updatedAt: '2026-10-27T08:00:00Z',
  hasText: true,
  unread,
  writing: false,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('[adr:digital-paper-interface#9] [adr:opening-book-home#1] lists the recent dates with who wrote and new content, never their text', async () => {
    stubApi({
      ...noRelationship,
      ...bound,
      ...lists,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': () =>
        Response.json({
          days: [
            { diaryDate: today, mine: own('今天下雨'), partner: theirs('我这边天晴', true) },
            { diaryDate: '2026-10-20', mine: own('只给自己看的一句'), partner: null },
          ],
          nextBefore: null,
          nextAfter: null,
        }),
    });
    renderAt('/');
    const recent = await screen.findByRole('region', { name: '最近的几页' });
    const first = await within(recent).findByRole('link', { name: /今天/ });
    expect(first.getAttribute('href')).toBe(`/days/${today}`);
    expect(first.textContent).toContain('你和bob都写了');
    expect(first.textContent).toContain('bob有新内容');
    const second = within(recent).getByRole('link', { name: /10 月 20 日/ });
    expect(second.textContent).toContain('你写了');
    expect(second.textContent).not.toContain('新内容');
    expect(screen.queryByText(/今天下雨|我这边天晴|只给自己看的一句/)).toBeNull();
  });

  it("[adr:opening-book-home#3] leads to today's diary to write, and to all diaries", async () => {
    stubApi({ ...noRelationship, ...lists, 'GET /api/me': signedIn('alice') });
    const { router } = renderAt('/');
    const write = await screen.findByRole('link', { name: '继续写今天' });
    expect(write.getAttribute('href')).toBe(`/days/${today}`);
    expect(screen.getByRole('link', { name: '所有日记' }).getAttribute('href')).toBe('/days');

    fireEvent.click(write);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/days/${today}`));
    expect(router.state.location.state).toEqual({ edit: true });
  });

  it("opens all diaries at the partner's nearest unread date, only when there is one", async () => {
    stubApi({
      ...noRelationship,
      ...bound,
      ...lists,
      'GET /api/me': signedIn('alice'),
      'GET /api/days/next-unread': () => Response.json({ date: '2026-10-21' }),
    });
    const { router } = renderAt('/');
    fireEvent.click(await screen.findByRole('link', { name: '读bob的新内容' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/days'));
    expect(router.state.location.state).toEqual({ feed: { date: '2026-10-21', offset: 0 } });
  });

  it('offers nothing to read when nothing is unread', async () => {
    stubApi({ ...noRelationship, ...bound, ...lists, 'GET /api/me': signedIn('alice') });
    renderAt('/');
    expect(await screen.findByText('TA 那边')).toBeDefined();
    await waitFor(() => expect(screen.getByText('还没有日记，从今天开始写吧')).toBeDefined());
    expect(screen.queryByRole('link', { name: /新内容/ })).toBeNull();
  });

  it('[adr:opening-book-home#5] offers the invitation instead of the partner while unbound', async () => {
    stubApi({ ...noRelationship, ...lists, 'GET /api/me': signedIn('alice') });
    renderAt('/');
    expect(await screen.findByText('生成邀请链接')).toBeDefined();
    expect(await screen.findByText('我这边')).toBeDefined();
    expect(screen.queryByText(/TA 那边|醒着/)).toBeNull();
  });

  it('[adr:opening-book-home#5] keeps the archived space and the restore invitation after unbinding, without the partner', async () => {
    stubApi({
      ...noRelationship,
      ...lists,
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

  it('shows the partner and no invitation while bound; the space is under 设置', async () => {
    stubApi({ ...noRelationship, ...bound, ...lists, 'GET /api/me': signedIn('alice') });
    renderAt('/');
    expect(await screen.findByText('TA 那边')).toBeDefined();
    expect(screen.queryByText(/邀请/)).toBeNull();
  });
});
