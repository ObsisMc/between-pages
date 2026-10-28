import { defineConfig } from 'vitest/config';

// Formal modules only; prototypes keep their own node:test suites (npm run test:prototypes).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'contracts', root: 'packages/contracts', environment: 'node' } },
      { test: { name: 'collab', root: 'packages/collab', environment: 'node' } },
      {
        test: {
          name: 'api',
          root: 'apps/api',
          environment: 'node',
          globalSetup: ['test/global-setup.ts'],
        },
      },
      { test: { name: 'web', root: 'apps/web', environment: 'jsdom' } },
      // Tests of the checks themselves; outside the coverage include on purpose.
      { test: { name: 'checks', root: 'checks', environment: 'node' } },
      // The server backup scripts; their Docker cycle runs only under `npm run test:backup`.
      { test: { name: 'ops', root: 'ops/backup', environment: 'node' } },
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
