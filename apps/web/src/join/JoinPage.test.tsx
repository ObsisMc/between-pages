import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';
import { PARTNER, PERIOD, SPACE, TOKEN, errorBody, space } from '../../test/relationship.ts';
import { pendingInvite } from './pending.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const preview = () =>
  Response.json({
    inviter: { id: PARTNER, displayName: 'bob' },
    expiresAt: '2026-11-03T08:00:00.000Z',
    mode: 'new',
  });

describe('JoinPage', () => {
  it('[adr:spaces-and-invitations#10] keeps the token across login and removes it from the address', async () => {
    stubApi({ 'GET /api/me': signedOut });
    const { router } = renderAt(`/join#token=${TOKEN}`);

    expect(await screen.findByText('去登录')).toBeDefined();
    await waitFor(() => expect(router.state.location.hash).toBe(''));
    expect(pendingInvite()).toBe(TOKEN);
  });

  it('continues at /join after login lands on the home page', async () => {
    sessionStorage.setItem('between-pages-pending-invite', TOKEN);
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': () => Response.json({ days: [], nextBefore: null, nextAfter: null }),
      'POST /api/binding/invitations/preview': preview,
    });
    const { router } = renderAt('/');

    await waitFor(() => expect(router.state.location.pathname).toBe('/join'));
    expect(await screen.findByText('bob')).toBeDefined();
  });

  it('[adr:display-name#1] renames the current account beside it and stays on the invitation', async () => {
    sessionStorage.setItem('between-pages-pending-invite', TOKEN);
    let name = 'alice';
    stubApi({
      ...noRelationship,
      'GET /api/me': () =>
        Response.json({ user: { id: '6f1c1d0e-0000-4000-8000-000000000001', displayName: name } }),
      'POST /api/binding/invitations/preview': preview,
      'PATCH /api/me': (init) => {
        name = (JSON.parse(String(init?.body)) as { displayName: string }).displayName;
        return Response.json({
          user: { id: '6f1c1d0e-0000-4000-8000-000000000001', displayName: name },
        });
      },
    });
    const { router } = renderAt('/join');

    fireEvent.click(await screen.findByRole('button', { name: '修改名字 alice' }));
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: '小雨' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('button', { name: '修改名字 小雨' })).toBeDefined();
    expect(screen.getByText('bob')).toBeDefined();
    expect(screen.getByText('接受邀请')).toBeDefined();
    expect(router.state.location.pathname).toBe('/join');
  });

  it('[adr:spaces-and-invitations#3] shows both accounts and binds only on accepting', async () => {
    sessionStorage.setItem('between-pages-pending-invite', TOKEN);
    const accepted = vi.fn((init: RequestInit | undefined) => {
      void init;
      return Response.json({ binding: { space: space(), periodId: PERIOD }, restored: false });
    });
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'POST /api/binding/invitations/preview': preview,
      'POST /api/binding/invitations/accept': accepted,
      [`GET /api/spaces/${SPACE}`]: () => Response.json({ space: space(), periods: [] }),
      [`GET /api/spaces/${SPACE}/my-sharing`]: () =>
        Response.json({
          selection: { include: [], exclude: [] },
          revision: 0,
          confirmedPeriodId: null,
        }),
    });
    const { router } = renderAt('/join');

    expect(await screen.findByText('alice')).toBeDefined();
    expect(screen.getByText('bob')).toBeDefined();
    expect(screen.getByText(/首版绑定后搭档固定/)).toBeDefined();
    expect(accepted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('暂不设置'));
    fireEvent.click(screen.getByText('接受邀请'));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/spaces/${SPACE}`));
    expect(JSON.parse(accepted.mock.calls[0]![0]!.body as string)).toEqual({
      token: TOKEN,
      sharingSelection: null,
    });
    expect(pendingInvite()).toBeNull();
  });

  it('follows a new link opened while the page already shows an earlier one', async () => {
    const OTHER = 'zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJ';
    stubApi({
      'GET /api/me': signedIn('alice'),
      'POST /api/binding/invitations/preview': (init) =>
        JSON.parse(init!.body as string).token === TOKEN
          ? errorBody('INVITE_REVOKED', 409)()
          : preview(),
    });
    const { router } = renderAt(`/join#token=${TOKEN}`);
    expect((await screen.findByRole('alert')).textContent).toBe('这条邀请已被撤销');

    await router.navigate(`/join#token=${OTHER}`);

    expect(await screen.findByText('接受邀请')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(pendingInvite()).toBe(OTHER);
  });

  it('forgets a token the server refuses for good, and keeps it after a network failure', async () => {
    sessionStorage.setItem('between-pages-pending-invite', TOKEN);
    let online = false;
    stubApi({
      'GET /api/me': signedIn('alice'),
      'POST /api/binding/invitations/preview': () =>
        online ? errorBody('PARTNER_FIXED', 409)() : Promise.reject(new TypeError('offline')),
    });
    renderAt('/join');

    expect((await screen.findByRole('alert')).textContent).toBe(
      '网络中断，无法确认结果，请联网后重试',
    );
    expect(pendingInvite()).toBe(TOKEN);
    online = true;
    fireEvent.click(screen.getByText('重试'));

    expect(await screen.findByText('首版绑定后搭档固定，只能与原搭档恢复关系')).toBeDefined();
    expect(pendingInvite()).toBeNull();
  });
});
