import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';
import { SPACE, space } from '../../test/relationship.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const nav = () => screen.findByRole('navigation', { name: '主要' });

/** Opens a menu of the header by keyboard, as Radix menus open, and lists its entries. */
async function menu(name: string) {
  const trigger = within(await nav()).getByRole('button', { name: new RegExp(`^${name}`) });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const opened = await screen.findByRole('menu');
  return within(opened)
    .getAllByRole('menuitem')
    .map((item) => [item.textContent, item.getAttribute('href')]);
}

describe('SiteHeader', () => {
  it('[adr:space-records#10] [adr:book-frontend-workspace#2] lists only the diaries and backup for an account that was never bound', async () => {
    stubApi({ ...noRelationship, 'GET /api/me': signedIn('alice') });
    renderAt('/');
    const bar = await nav();
    expect(within(bar).getByRole('link', { name: '此刻' }).getAttribute('href')).toBe('/');
    expect(within(bar).getByRole('link', { name: '日记' }).getAttribute('href')).toBe('/days');
    expect(within(bar).queryByRole('button', { name: /^一起/ })).toBeNull();
    expect(await menu('设置')).toEqual([['备份', '/backup']]);
  });

  it('lists the clocks, the space features with their dots and the space while bound', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/binding': () =>
        Response.json({ binding: { space: space(), periodId: SPACE }, invitation: null }),
      'GET /api/spaces': () => Response.json({ spaces: [space()] }),
      'GET /api/space/unread': () => Response.json({ features: { wishes: 2, anniversaries: 0 } }),
    });
    renderAt('/wishes');
    const bar = await nav();
    const together = await within(bar).findByRole('button', { name: /^一起/ });
    await waitFor(() => expect(within(together).queryByLabelText('有新内容')).not.toBeNull());
    expect(together.getAttribute('aria-current')).toBe('page');
    expect(await menu('一起')).toEqual([
      ['两地时间', '/clocks'],
      ['心愿与礼物', '/wishes'],
      ['纪念日', '/anniversaries'],
    ]);
    const wishes = screen.getByRole('menuitem', { name: /心愿与礼物/ });
    expect(within(wishes).queryByLabelText('有新内容')).not.toBeNull();
    expect(
      within(screen.getByRole('menuitem', { name: /纪念日/ })).queryByLabelText('有新内容'),
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(await menu('设置')).toEqual([
      ['双人空间', `/spaces/${SPACE}`],
      ['备份', '/backup'],
    ]);
  });

  it('[adr:book-frontend-workspace#7] keeps the read-only space and its records after unbinding, without the clocks', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/spaces': () => Response.json({ spaces: [space('archived')] }),
      'GET /api/space/unread': () => Response.json({ features: { wishes: 0, anniversaries: 0 } }),
    });
    renderAt('/');
    await waitFor(async () =>
      expect(within(await nav()).queryByRole('button', { name: /^一起/ })).not.toBeNull(),
    );
    expect(await menu('一起')).toEqual([
      ['心愿与礼物', '/wishes'],
      ['纪念日', '/anniversaries'],
    ]);
  });

  it('shows no header while signed out', async () => {
    stubApi({ 'GET /api/me': signedOut });
    renderAt('/login');
    expect(await screen.findByText('使用 Google 登录')).toBeDefined();
    expect(screen.queryByRole('navigation', { name: '主要' })).toBeNull();
  });

  it('signs out from the account menu, forgets the session and returns to /login', async () => {
    let session = true;
    stubApi({
      ...noRelationship,
      'GET /api/me': () => (session ? signedIn('alice')() : signedOut()),
      'POST /api/auth/sign-out': () => ((session = false), Response.json({ success: true })),
    });
    const { router, client } = renderAt('/');
    fireEvent.keyDown(await screen.findByRole('button', { name: '账号：alice' }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: '退出' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText('使用 Google 登录')).toBeDefined();
    expect(client.getQueryData(['me'])).toBeUndefined();
  });

  it('stays and says so when signing out fails', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'POST /api/auth/sign-out': () => new Response(null, { status: 500 }),
    });
    const { router } = renderAt('/');
    fireEvent.keyDown(await screen.findByRole('button', { name: '账号：alice' }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: '退出' }));
    expect((await screen.findByRole('alert')).textContent).toBe('退出失败，请重试');
    expect(router.state.location.pathname).toBe('/');
  });
});
