import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';

// installable-pwa D1: the worker caches only the built page files, so Cache Storage never
// holds an API answer or any diary text (invariant 1). The app registers it and asks before
// a new version takes over (D2), and the dev server registers none (invariant 9).
export const pwa: Partial<VitePWAOptions> = {
  strategies: 'generateSW',
  registerType: 'prompt',
  injectRegister: false,
  manifest: false,
  devOptions: { enabled: false },
  workbox: {
    globPatterns: [
      'index.html',
      'assets/**/*.{js,css}',
      'favicon.svg',
      'favicon.ico',
      'apple-touch-icon.png',
      'icon-*.png',
      'manifest.webmanifest',
    ],
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api\//],
    cleanupOutdatedCaches: true,
    // About 6 MB of font slices is too much to fetch up front on a phone: the slices a page
    // used stay readable offline, the others fall back to the system font.
    runtimeCaching: [
      {
        urlPattern: ({ sameOrigin, url }) =>
          sameOrigin && /^\/fonts\/[^/]+\.woff2$/.test(url.pathname),
        handler: 'StaleWhileRevalidate',
        options: { cacheName: 'fonts', expiration: { maxEntries: 200 } },
      },
    ],
  },
};

// Same-origin in development: /api, the sync WebSocket included, is proxied to the API
// process (ADR-0006), whose port comes from the same repo-root .env the API reads.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react(), tailwindcss(), VitePWA(pwa)],
    server: { proxy: { '/api': { target: `http://127.0.0.1:${env.PORT ?? 3000}`, ws: true } } },
  };
});
