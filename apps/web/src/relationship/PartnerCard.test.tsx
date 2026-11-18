import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { noRelationship, renderAt, signedIn, stubApi } from '../../test/render.tsx';
import { INVITE, SPACE, space } from '../../test/relationship.ts';

const noDays = () => Response.json({ days: [], nextBefore: null, nextAfter: null });
const card = () => screen.findByRole('region', { name: '搭档' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PartnerCard', () => {
  it('shows one line of state on the home and leads to 设置 → 搭档, never the range editor', async () => {
    stubApi({ ...noRelationship, 'GET /api/me': signedIn('alice'), 'GET /api/days': noDays });
    const { router } = renderAt('/');
    const region = await card();
    expect(within(region).getByText('还没有搭档')).toBeDefined();
    expect(screen.queryByText('或者生成邀请链接')).toBeNull();
    expect(screen.queryByLabelText('自选日期')).toBeNull();

    fireEvent.click(within(region).getByRole('link', { name: '邀请搭档' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/partner'));
    expect(await screen.findByRole('heading', { level: 1, name: '搭档' })).toBeDefined();
    expect(await screen.findByText('或者生成邀请链接')).toBeDefined();
  });

  it('names the archived space after unbinding, as a link', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/spaces': () => Response.json({ spaces: [space('archived')] }),
    });
    renderAt('/');
    const region = await card();
    const link = await within(region).findByRole('link', { name: '与 bob 的空间（已解绑）' });
    expect(link.getAttribute('href')).toBe(`/spaces/${SPACE}`);
    expect(within(region).queryByText('还没有搭档')).toBeNull();
    expect(within(region).getByRole('link', { name: '邀请搭档' }).getAttribute('href')).toBe(
      '/partner',
    );
  });

  it('says an invitation is out and until when', async () => {
    stubApi({
      ...noRelationship,
      'GET /api/me': signedIn('alice'),
      'GET /api/days': noDays,
      'GET /api/binding': () =>
        Response.json({
          binding: null,
          invitation: {
            id: INVITE,
            expiresAt: '2026-11-03T08:00:00.000Z',
            state: 'pending',
            recipientEmail: null,
          },
          invitationsForMe: [],
        }),
    });
    renderAt('/');
    const region = await card();
    const expected = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(
      new Date('2026-11-03T08:00:00.000Z'),
    );
    expect(await within(region).findByText(`已发出邀请，${expected} 前有效`)).toBeDefined();
    expect(screen.queryByText('撤销邀请')).toBeNull();
  });
});
