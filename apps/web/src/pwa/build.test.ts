import { describe, expect, it } from 'vitest';
import { pwa } from '../../vite.config.ts';

// installable-pwa invariant 1, as far as the build's configuration decides it: navigations
// to /api/ never get the cached page, and the only request cached at run time is a font.
type Match = { url: URL; sameOrigin: boolean };
const at = (path: string, sameOrigin = true): Match => ({
  url: new URL(path, 'https://example.test'),
  sameOrigin,
});

describe('the service worker build', () => {
  it('[adr:installable-pwa#1] answers no /api/ navigation from the cache', () => {
    const denied = (path: string) =>
      pwa.workbox!.navigateFallbackDenylist!.some((pattern) => pattern.test(path));
    expect(denied('/api/me')).toBe(true);
    expect(denied('/api/sync')).toBe(true);
    expect(denied('/days/2026-11-18')).toBe(false);
  });

  it('[adr:installable-pwa#1] caches only font slices at run time', () => {
    const cached = (options: Match) =>
      pwa.workbox!.runtimeCaching!.some(({ urlPattern }) =>
        typeof urlPattern === 'function'
          ? (urlPattern as (options: Match) => boolean)(options)
          : false,
      );
    expect(cached(at('/fonts/between-serif-12.woff2'))).toBe(true);
    for (const path of ['/api/days', '/api/diaries/x', '/api/me', '/index.html', '/days'])
      expect(cached(at(path))).toBe(false);
    expect(cached(at('/fonts/a.woff2', false))).toBe(false);
  });
});
