import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, signedOut, stubApi } from '../../test/render.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RequireAuth', () => {
  it('[adr:book-fit-and-bookmark#4] shows a loading state on the book without a bookmark, then the page for a signed-in user', async () => {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    stubApi({ 'GET /api/me': async () => (await answered, signedIn('alice')()) });
    renderAt('/');
    expect((await screen.findByText('正在打开…')).closest('.book-left')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '目录' })).toBeNull();
    release();
    expect(await screen.findByText('已登录为 alice')).toBeDefined();
  });

  it('redirects to /login without a session', async () => {
    stubApi({ 'GET /api/me': signedOut });
    const { router } = renderAt('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText('使用 Google 登录')).toBeDefined();
  });

  it('[adr:book-fit-and-bookmark#4] offers a retry on the book when the service fails, and recovers', async () => {
    let healthy = false;
    stubApi({
      'GET /api/me': () => (healthy ? signedIn('alice')() : new Response(null, { status: 503 })),
    });
    renderAt('/');
    expect(
      (await screen.findByText('服务暂不可用，请稍后再试')).closest('.book-left'),
    ).not.toBeNull();
    expect(screen.getByText('重试').closest('.book-left')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '目录' })).toBeNull();
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
