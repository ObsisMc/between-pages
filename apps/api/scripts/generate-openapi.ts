import { readFile, writeFile } from 'node:fs/promises';
import { renderOpenApi } from '../src/openapi.ts';

// Usage: generate-openapi.ts [--check]
// --check exits 1 when the committed file differs from what the routes produce.
const target = new URL('../openapi.json', import.meta.url);
const next = await renderOpenApi();

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== next) {
    console.error('apps/api/openapi.json is out of date — run: npm run openapi');
    process.exit(1);
  }
} else {
  await writeFile(target, next);
}
