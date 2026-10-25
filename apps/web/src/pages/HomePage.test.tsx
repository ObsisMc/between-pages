import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('signs out, forgets the session and returns to /login', async () => {
    let session = true;
    stubApi({
      'GET /api/me': () => (session ? signedIn('alice')() : signedOut()),
      'POST /api/auth/sign-out': () => ((session = false), Response.json({ success: true })),
    });
    const { router, client } = renderAt('/');
    fireEvent.click(await screen.findByText('退出'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText('使用 Google 登录')).toBeDefined();
    expect(client.getQueryData(['me'])).toBeUndefined();
  });

  it('stays and says so when signing out fails', async () => {
    stubApi({
      'GET /api/me': signedIn('alice'),
      'POST /api/auth/sign-out': () => new Response(null, { status: 500 }),
    });
    const { router } = renderAt('/');
    fireEvent.click(await screen.findByText('退出'));
    expect((await screen.findByRole('alert')).textContent).toBe('退出失败，请重试');
    expect(router.state.location.pathname).toBe('/');
  });
});
