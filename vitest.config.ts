import { defineConfig } from 'vitest/config';

// Formal modules only; prototypes keep their own node:test suites (npm run test:prototypes).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'contracts', root: 'packages/contracts', environment: 'node' } },
      { test: { name: 'api', root: 'apps/api', environment: 'node' } },
      { test: { name: 'web', root: 'apps/web', environment: 'jsdom' } },
    ],
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**', 'packages/*/src/**'],
      // Process entry points only wire modules together; their behavior is covered
      // through buildApp() and <App /> instead.
      exclude: ['**/*.test.{ts,tsx}', 'apps/api/src/server.ts', 'apps/web/src/main.tsx'],
      thresholds: { lines: 80 },
    },
  },
});
