import { cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';

// Two production builds of the web app for the PWA browser tests (installable-pwa 自主实现约定):
// `a` is served first; a test deploys `b` over it to see the update bar. They differ only by a
// marker in index.html, which changes the worker's precache list as any release would.
const root = join(tmpdir(), 'between-pages-pwa-e2e');
export const BUILD = { a: join(root, 'a'), b: join(root, 'b'), served: join(root, 'served') };

/** Replaces what the preview serves with build `name`, as a deploy replaces the site. */
export async function deploy(name: 'a' | 'b') {
  await rm(BUILD.served, { recursive: true, force: true });
  await cp(BUILD[name], BUILD.served, { recursive: true });
}

const marker = (name: string): Plugin => ({
  name: 'e2e-build-marker',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'e2e-build', content: name } }],
});

if (import.meta.main) {
  const { build } = await import('vite');
  for (const name of ['a', 'b'] as const)
    await build({
      root: 'apps/web',
      logLevel: 'warn',
      plugins: [marker(name)],
      build: { outDir: BUILD[name], emptyOutDir: true },
    });
  await deploy('a');
}
