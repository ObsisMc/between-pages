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
    expect(await screen.findByRole('button', { name: '账号：alice' })).toBeDefined();
  });

  it('redirects to /login without a session', async () => {
    stubApi({ 'GET /api/me': signedOut });
    const { router } = renderAt('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText('使用 Google 登录')).toBeDefined();
  });

  it('[adr:installable-pwa#3] offers a retry when the service fails, and recovers', async () => {
    let healthy = false;
    stubApi({
      'GET /api/me': () => (healthy ? signedIn('alice')() : new Response(null, { status: 503 })),
    });
    renderAt('/');
    expect(await screen.findByText('服务暂不可用，请稍后再试')).toBeDefined();
    healthy = true;
    fireEvent.click(screen.getByText('重试'));
    expect(await screen.findByRole('button', { name: '账号：alice' })).toBeDefined();
  });

  it('[adr:installable-pwa#3] says offline when the API does not answer, and opens by itself once it does', async () => {
    let online = false;
    stubApi({
      'GET /api/me': () =>
        online ? signedIn('alice')() : Promise.reject(new TypeError('Failed to fetch')),
      'GET /api/health': () => Response.json({ status: 'ok' }),
    });
    renderAt('/');
    expect((await screen.findByRole('status')).textContent).toBe('现在离线，联网后会自动打开');
    expect(screen.queryByText('服务暂不可用，请稍后再试')).toBeNull();
    expect(screen.queryByText('alice')).toBeNull();

    online = true;
    window.dispatchEvent(new Event('online'));
    expect(await screen.findByRole('button', { name: '账号：alice' })).toBeDefined();
  });

  it('[adr:installable-pwa#3] says offline at once when the browser is offline, before any answer', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    stubApi({ 'GET /api/me': () => new Promise<Response>(() => undefined) });
    renderAt('/');
    expect((await screen.findByRole('status')).textContent).toBe('现在离线，联网后会自动打开');
    expect(screen.queryByText('正在打开…')).toBeNull();
  });

  it('keeps the page when a later check of the session gets no answer', async () => {
    let online = true;
    stubApi({
      'GET /api/me': () =>
        online ? signedIn('alice')() : Promise.reject(new TypeError('Failed to fetch')),
    });
    const { client } = renderAt('/');
    expect(await screen.findByRole('button', { name: '账号：alice' })).toBeDefined();
    online = false;
    await client.refetchQueries({ queryKey: ['me'] });
    expect(screen.getByRole('button', { name: '账号：alice' })).toBeDefined();
    expect(screen.queryByText('服务暂不可用，请稍后再试')).toBeNull();
  });

  it('sends unknown paths to the home page', async () => {
    stubApi({ 'GET /api/me': signedIn() });
    const { router } = renderAt('/somewhere');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
