import { defineConfig, devices } from '@playwright/test';

// End-to-end tests for the formal app (authentication-and-sessions acceptance E1-E6, the
// kernel phase-3 diary screen) in the three engines the kernel ADR requires. Locally
// `npm run test:e2e` runs Chromium and WebKit; CI runs all three (`test:e2e:all`).
// Starts the mock issuer, the API and the web dev server on their own ports, so it never
// talks to a developer's running servers. Needs TEST_DATABASE_URL: `npm run test:e2e:db`
// locally, the PostgreSQL service in CI.
const database = process.env.TEST_DATABASE_URL;
if (!database) throw new Error('TEST_DATABASE_URL is required (run: npm run test:e2e:db)');

const WEB = 'http://localhost:5174';
const API_PORT = '3101';
const ISSUER = 'http://127.0.0.1:4011';
const env = {
  DATABASE_URL: database,
  PORT: API_PORT,
  PUBLIC_ORIGIN: WEB,
  BETTER_AUTH_SECRET: 'e2e-only-secret-never-used-outside-tests-0000',
  AUTH_PROVIDER: 'dev',
  DEV_OIDC_ISSUER: ISSUER,
  // History points close after 3 s instead of two minutes, so EDIT-16 needs no long wait.
  HISTORY_IDLE_MS: '3000',
};

export default defineConfig({
  testDir: 'e2e',
  // WebKit runs about a quarter slower, and the longest default-budget specs neared 30 s.
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: WEB, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'npm run dev:oidc',
      url: `${ISSUER}/.well-known/openid-configuration`,
      env,
      reuseExistingServer: false,
    },
    {
      command: 'npm run db:migrate && npm start -w @between-pages/api',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env,
      reuseExistingServer: false,
    },
    {
      // The Vite proxy reads PORT, so /api reaches the API started above.
      command: 'npm run dev -w @between-pages/web -- --port 5174 --strictPort',
      url: WEB,
      env,
      reuseExistingServer: false,
    },
  ],
});
