import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderAt, signedIn, stubApi } from '../../test/render.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOTICE =
  '现在离线。日记和共享页面里写下的字先存在这台设备上，联网后自动发出；其他修改要联网后再做。';

describe('the offline notice', () => {
  it('[adr:installable-pwa#4] shows under the header while the API does not answer, never saying saved, and goes once it answers', async () => {
    let online = true;
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    stubApi({
      'GET /api/me': signedIn('alice'),
      'GET /api/spaces': () => (online ? Response.json({ spaces: [] }) : offline()),
      'GET /api/binding': () =>
        online ? Response.json({ binding: null, invitation: null }) : offline(),
      'GET /api/health': () => (online ? Response.json({ status: 'ok' }) : offline()),
    });
    const { client } = renderAt('/partner');
    await screen.findByRole('button', { name: '账号：alice' });
    expect(screen.queryByText(NOTICE)).toBeNull();

    online = false;
    window.dispatchEvent(new Event('offline'));
    const notice = await screen.findByText(NOTICE);
    expect(notice.textContent).not.toContain('已保存');
    // The page itself stays: the session was confirmed before the connection went.
    expect(screen.getByRole('button', { name: '账号：alice' })).toBeDefined();

    // The browser says online on a network that reaches nothing: still offline.
    window.dispatchEvent(new Event('online'));
    await client.refetchQueries({ queryKey: ['binding'] }).catch(() => undefined);
    expect(screen.getByText(NOTICE)).toBeDefined();

    online = true;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
  });

  it('is not shown while signed out', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    stubApi({ 'GET /api/me': () => Promise.reject(new TypeError('Failed to fetch')) });
    renderAt('/login');
    await screen.findByText('现在离线，联网后再登录');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
