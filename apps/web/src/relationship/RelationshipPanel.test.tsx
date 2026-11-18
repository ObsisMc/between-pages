import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { INVITE, ME, SPACE, TOKEN, errorBody, space } from '../../test/relationship.ts';
import { RelationshipPanel } from './index.ts';

const noDays = () => Response.json({ days: [], nextBefore: null, nextAfter: null });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pending = {
  id: INVITE,
  expiresAt: '2026-11-03T08:00:00.000Z',
  state: 'pending',
};

describe('RelationshipPanel', () => {
  it('creates an invitation with the chosen range and shows its link once', async () => {
    let invitation: typeof pending | null = null;
    const created = vi.fn((init: RequestInit | undefined) => {
      invitation = pending;
      void init;
      return Response.json({ invitation: pending, token: TOKEN });
    });
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () => Response.json({ binding: null, invitation }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/binding/invitations': created,
    });
    renderAt('/partner');

    expect(await screen.findByRole('heading', { level: 1, name: '搭档' })).toBeDefined();
    fireEvent.click(await screen.findByText('生成邀请链接'));

    const link = (await screen.findByLabelText('邀请链接')) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/join#token=${TOKEN}`);
    const body = JSON.parse(created.mock.calls[0]![0]!.body as string) as Record<string, unknown>;
    expect(body.sharingSelection).toEqual({ include: [{ from: null, to: null }], exclude: [] });
    expect(await screen.findByText('撤销邀请')).toBeDefined();
  });

  it('[adr:spaces-and-invitations#3] says a retried invitation has no link to show again', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () => Response.json({ binding: null, invitation: null }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/binding/invitations': () => Response.json({ invitation: pending, token: null }),
    });
    renderAt('/partner');
    fireEvent.click(await screen.findByText('暂不设置'));
    fireEvent.click(await screen.findByText('生成邀请链接'));

    expect((await screen.findByRole('alert')).textContent).toBe(
      '邀请已经生成过，但链接无法再次显示，请撤销后重新生成',
    );
    expect(screen.queryByLabelText('邀请链接')).toBeNull();
  });

  it('revokes a pending invitation', async () => {
    let invitation: typeof pending | null = pending;
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () => Response.json({ binding: null, invitation }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      [`POST /api/binding/invitations/${INVITE}/revoke`]: () => {
        invitation = null;
        return Response.json({ revoked: true });
      },
    });
    renderAt('/partner');
    expect(await screen.findByText(/链接只在生成时显示/)).toBeDefined();

    fireEvent.click(screen.getByText('撤销邀请'));

    expect(await screen.findByText('生成邀请链接')).toBeDefined();
  });

  it('links the current and archived spaces and offers no invitation while bound', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () =>
        Response.json({ binding: { space: space(), periodId: SPACE }, invitation: null }),
      'GET /api/spaces': () => Response.json({ spaces: [space()] }),
    });
    // The header lists the page only while unbound; the panel itself still links a current space.
    const { router } = renderAt('/partner', [
      { path: '/partner', element: <RelationshipPanel me={{ id: ME, displayName: 'alice' }} /> },
      { path: '/spaces/:spaceId', element: <p>空间</p> },
    ]);

    fireEvent.click(await screen.findByText('与 bob 的空间'));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/spaces/${SPACE}`));
  });

  it('[adr:display-name#1] shows the name the partner will see and renames it in place', async () => {
    let name = 'alice';
    stubApi({
      'GET /api/me': () => Response.json({ user: { id: ME, displayName: name } }),
      'GET /api/days': noDays,
      'GET /api/binding': () => Response.json({ binding: null, invitation: null }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'PATCH /api/me': (init) => {
        name = (JSON.parse(String(init?.body)) as { displayName: string }).displayName;
        return Response.json({ user: { id: ME, displayName: name } });
      },
    });
    const { router } = renderAt('/partner');

    expect((await screen.findByText(/对方会看到你叫/)).textContent).toContain('alice');
    fireEvent.click(screen.getByRole('button', { name: '修改名字 alice' }));
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: '小雨' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('button', { name: '修改名字 小雨' })).toBeDefined();
    expect(screen.queryByLabelText('名字')).toBeNull();
    expect(router.state.location.pathname).toBe('/partner');
    expect(screen.getByText('生成邀请链接')).toBeDefined();
  });

  it('names a bound caller’s refusal', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () => Response.json({ binding: null, invitation: null }),
      'GET /api/spaces': () => Response.json({ spaces: [] }),
      'POST /api/binding/invitations': errorBody('ALREADY_BOUND', 409),
    });
    renderAt('/partner');
    fireEvent.click(await screen.findByText('生成邀请链接'));
    expect((await screen.findByRole('alert')).textContent).toBe('你或对方已有当前绑定');
  });
});
