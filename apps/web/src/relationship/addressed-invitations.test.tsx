import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';
import { INVITE, PARTNER, PERIOD, SPACE, errorBody, space } from '../../test/relationship.ts';

// Invitations addressed to a Google email on screen (in-app-invitation-by-email D5): the
// inviter's form and status on 设置 → 搭档, the recipient's home line and /join?invite=.

const EMAIL = 'bob@example.com';
const noDays = () => Response.json({ days: [], nextBefore: null, nextAfter: null });
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;
const addressed = (over: object = {}) => ({
  id: INVITE,
  expiresAt: '2026-11-25T08:00:00.000Z',
  state: 'pending',
  recipientEmail: EMAIL,
  ...over,
});
const incoming = (mode: 'new' | 'restore' = 'new') => ({
  id: INVITE,
  inviter: { id: PARTNER, displayName: 'bob' },
  expiresAt: '2026-11-25T08:00:00.000Z',
  mode,
});
const preview = () =>
  Response.json({
    inviter: { id: PARTNER, displayName: 'bob' },
    expiresAt: '2026-11-25T08:00:00.000Z',
    mode: 'new',
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('inviting by email on 设置 → 搭档', () => {
  it('[adr:in-app-invitation-by-email#3] sends to the address and says only that TA has to sign in', async () => {
    let invitation: object | null = null;
    const created = vi.fn((init?: RequestInit) => {
      invitation = addressed();
      void init;
      return Response.json({ invitation, token: null });
    });
    const fetch = stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () => Response.json({ binding: null, invitation, invitationsForMe: [] }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/binding/invitations': created,
    });
    renderAt('/partner');

    fireEvent.change(await screen.findByLabelText('TA 的 Google 邮箱'), {
      target: { value: 'not an address' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发出邀请' }));
    expect((await screen.findByRole('alert')).textContent).toBe('请填 TA 登录 Google 用的完整邮箱');
    expect(created).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('TA 的 Google 邮箱'), {
      target: { value: ' Bob@Example.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发出邀请' }));
    expect(await screen.findByText('已发出邀请')).toBeDefined();
    expect(bodyOf(created.mock.calls[0]![0])).toMatchObject({
      recipientEmail: 'Bob@Example.com',
      sharingSelection: { include: [{ from: null, to: null }], exclude: [] },
    });
    expect(await screen.findByText(/已邀请 bob@example.com，等 TA 登录/)).toBeDefined();
    expect(screen.queryByLabelText('邀请链接')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('mail'))).toBe(false);
  });

  it('re-sends with the address filled in only on another click, and says when the limit is reached', async () => {
    const created = vi.fn(errorBody('INVITE_LIMIT', 429));
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () =>
        Response.json({ binding: null, invitation: addressed(), invitationsForMe: [] }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/binding/invitations': created,
    });
    renderAt('/partner');

    fireEvent.click(await screen.findByRole('button', { name: '重新发出' }));
    expect((screen.getByLabelText('TA 的 Google 邮箱') as HTMLInputElement).value).toBe(EMAIL);
    expect(created).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '发出邀请' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '24 小时内已经发出 5 次邀请，请稍后再试，或改用邀请链接',
    );
  });

  it('offers a re-send once an addressed invitation expired', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () =>
        Response.json({
          binding: null,
          invitation: addressed({ state: 'expired' }),
          invitationsForMe: [],
        }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
    });
    renderAt('/partner');
    expect(await screen.findByText(`给 ${EMAIL} 的邀请已过期`)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '重新发出' }));
    expect((screen.getByLabelText('TA 的 Google 邮箱') as HTMLInputElement).value).toBe(EMAIL);
  });

  it('says the address on the home card', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () =>
        Response.json({ binding: null, invitation: addressed(), invitationsForMe: [] }),
    });
    renderAt('/');
    expect(await screen.findByText(/已邀请 bob@example.com，/)).toBeDefined();
  });
});

describe('an invitation addressed to me', () => {
  it('[adr:in-app-invitation-by-email#4] shows a home line per invitation that opens the confirm page by ID', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () =>
        Response.json({
          binding: null,
          invitation: null,
          invitationsForMe: [incoming(), { ...incoming('restore'), id: SPACE }],
        }),
      'POST /api/binding/invitations/preview': preview,
    });
    const { router } = renderAt('/');
    expect(await screen.findByText(/bob 邀请你一起写日记/)).toBeDefined();
    expect(screen.getByText(/bob 邀请你恢复你们的空间/)).toBeDefined();
    fireEvent.click(screen.getAllByRole('link', { name: '查看' })[0]!);
    await waitFor(() => expect(router.state.location.search).toBe(`?invite=${INVITE}`));
    expect(await screen.findByText('接受邀请')).toBeDefined();
    expect(sessionStorage.length).toBe(0);
  });

  it('[adr:in-app-invitation-by-email#5] accepts by ID with the chosen range', async () => {
    const accepted = vi.fn((init?: RequestInit) => {
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
    const { router } = renderAt(`/join?invite=${INVITE}`);
    expect(await screen.findByText('bob')).toBeDefined();
    expect(screen.getByText(/当前账号/).textContent).toContain('alice');
    fireEvent.click(screen.getByLabelText('暂不设置'));
    fireEvent.click(screen.getByText('接受邀请'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/spaces/${SPACE}`));
    expect(bodyOf(accepted.mock.calls[0]![0])).toEqual({
      inviteId: INVITE,
      sharingSelection: null,
    });
  });

  it('[adr:in-app-invitation-by-email#7] 不接受 dismisses it and goes home', async () => {
    const dismissed = vi.fn(() => Response.json({ dismissed: true }));
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'POST /api/binding/invitations/preview': preview,
      [`POST /api/binding/invitations/${INVITE}/dismiss`]: dismissed,
    });
    const { router } = renderAt(`/join?invite=${INVITE}`);
    fireEvent.click(await screen.findByRole('button', { name: '不接受' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(dismissed).toHaveBeenCalledOnce();
  });

  it('says why it cannot be accepted and still lets it be dismissed', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'POST /api/binding/invitations/preview': errorBody('ALREADY_BOUND', 409),
    });
    renderAt(`/join?invite=${INVITE}`);
    expect((await screen.findByRole('alert')).textContent).toBe('你或对方已有当前绑定');
    expect(screen.getByRole('button', { name: '不接受' })).toBeDefined();
    expect(screen.queryByText('接受邀请')).toBeNull();
  });

  it('[adr:in-app-invitation-by-email#2] shows nothing more for an ID that is not mine', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'POST /api/binding/invitations/preview': errorBody('INVITE_INVALID', 404),
    });
    renderAt(`/join?invite=${INVITE}`);
    expect((await screen.findByRole('alert')).textContent).toBe('这份邀请已经不在了');
    expect(screen.queryByRole('button', { name: '不接受' })).toBeNull();
    expect(screen.queryByText('bob')).toBeNull();
  });

  it('asks a signed-out visitor to sign in and keeps nothing', async () => {
    stubApi({ 'GET /api/me': signedOut });
    renderAt(`/join?invite=${INVITE}`);
    expect(await screen.findByText(/登录后首页会显示这份邀请/)).toBeDefined();
    expect(sessionStorage.length).toBe(0);
  });
});
