import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderAt, signedOut, stubApi } from '../../test/render.tsx';
import { registerServiceWorker } from './index.ts';

// The browser's service worker is the boundary: jsdom has none, so Workbox stands in for it,
// and the test plays what the browser reports.
const workbox = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  registration: { waiting: {} as object | null },
  update: vi.fn(async () => undefined),
  messageSkipWaiting: vi.fn(),
}));
vi.mock('workbox-window', () => ({
  Workbox: class {
    addEventListener(type: string, listener: () => void) {
      workbox.listeners.set(type, listener);
    }
    register = async () => workbox.registration;
    update = workbox.update;
    messageSkipWaiting = workbox.messageSkipWaiting;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the update bar', () => {
  it('[adr:installable-pwa#5] says a new version waits and lets it in only when asked', async () => {
    const container = { addEventListener: vi.fn() };
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: container });
    stubApi({ 'GET /api/me': signedOut });
    registerServiceWorker();
    renderAt('/login');
    await screen.findByText('使用 Google 登录');
    expect(screen.queryByText('有新版本')).toBeNull();

    workbox.listeners.get('waiting')!();
    expect(await screen.findByText('有新版本')).toBeDefined();
    expect(workbox.messageSkipWaiting).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await vi.waitFor(() => expect(workbox.messageSkipWaiting).toHaveBeenCalledTimes(1));
    // This window reloads once the new version controls it, not before.
    expect(container.addEventListener).toHaveBeenCalledWith(
      'controllerchange',
      expect.any(Function),
      { once: true },
    );
  });

  it('looks for a new version when the app comes back to the foreground', () => {
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { addEventListener: vi.fn() } });
    registerServiceWorker();
    workbox.update.mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(workbox.update).toHaveBeenCalled();
  });
});
