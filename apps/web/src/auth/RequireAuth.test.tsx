import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RequireAuth', () => {
  it('shows a loading state, then the page for a signed-in user', async () => {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    stubApi({ 'GET /api/me': async () => (await answered, signedIn('alice')()) });
    renderAt('/');
    expect(await screen.findByText('正在打开…')).toBeDefined();
    release();
    expect(await screen.findByText('已登录为 alice')).toBeDefined();
  });

  it('redirects to /login without a session', async () => {
    stubApi({ 'GET /api/me': signedOut });
    const { router } = renderAt('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText('使用 Google 登录')).toBeDefined();
  });

  it('offers a retry when the service fails, and recovers', async () => {
    let healthy = false;
    stubApi({
      'GET /api/me': () => (healthy ? signedIn('alice')() : new Response(null, { status: 503 })),
    });
    renderAt('/');
    expect(await screen.findByText('服务暂不可用，请稍后再试')).toBeDefined();
    healthy = true;
    fireEvent.click(screen.getByText('重试'));
    expect(await screen.findByText('已登录为 alice')).toBeDefined();
  });

  it('sends unknown paths to the home page', async () => {
    stubApi({ 'GET /api/me': signedIn() });
    const { router } = renderAt('/somewhere');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
