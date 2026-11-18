import { defineConfig, devices } from '@playwright/test';
import { BUILD } from './e2e/pwa/builds.ts';

// installable-pwa: the service worker exists only in a production build, so these tests run
// against `vite preview` of two builds (e2e/pwa/builds.ts) rather than the dev server, in
// Chromium only. The API's PUBLIC_ORIGIN must be the address the browser uses, so the preview,
// its API and the mock issuer have ports of their own beside playwright.config.ts's. Needs
// TEST_DATABASE_URL: `npm run test:e2e:pwa:db`.
const database = process.env.TEST_DATABASE_URL;
if (!database) throw new Error('TEST_DATABASE_URL is required (run: npm run test:e2e:pwa:db)');

const WEB = 'http://localhost:4174';
const API_PORT = '3102';
const ISSUER = 'http://127.0.0.1:4012';
const env = {
  DATABASE_URL: database,
  PORT: API_PORT,
  PUBLIC_ORIGIN: WEB,
  BETTER_AUTH_SECRET: 'e2e-only-secret-never-used-outside-tests-0000',
  AUTH_PROVIDER: 'dev',
  DEV_OIDC_ISSUER: ISSUER,
};
const cwd = import.meta.dirname;

export default defineConfig({
  testDir: 'e2e/pwa',
  testMatch: '*.e2e.ts',
  timeout: 60_000,
  // The tests deploy builds over one served directory, so they run one at a time.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: WEB, trace: 'retain-on-failure', serviceWorkers: 'allow' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:oidc',
      url: `${ISSUER}/.well-known/openid-configuration`,
      env,
      cwd,
      reuseExistingServer: false,
    },
    {
      command: 'npm run db:migrate && npm start -w @between-pages/api',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env,
      cwd,
      reuseExistingServer: false,
    },
    {
      // The preview proxies /api like the dev server, to the API on PORT.
      command: `node e2e/pwa/builds.ts && npx vite preview apps/web --outDir ${BUILD.served} --port 4174 --strictPort`,
      url: WEB,
      env,
      cwd,
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
});
