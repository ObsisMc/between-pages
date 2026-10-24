import { chromium } from 'playwright';
import { performance } from 'node:perf_hooks';
import { startHarness } from '../browser/server.mjs';
import { ROOT } from '../model.mjs';
import { PostgresAuthority } from '../postgres.mjs';
const engine = process.env.COLLAB_ENGINE ?? 'legacy';
const sizes = process.env.COLLAB_PERF_SIZES?.split(',').map(Number) ?? [10000, 100000];
const chunkSize = Number(process.env.COLLAB_PERF_CHUNK_SIZE ?? 4000);
if (sizes.some(size => !Number.isSafeInteger(size) || size < 1 || size > 100000)) throw new Error('INVALID_PERF_SIZES');
if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 4096) throw new Error('INVALID_PERF_CHUNK_SIZE');
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const pool = process.env.COLLAB_TEST_DATABASE_URL ? PostgresAuthority.pool(process.env.COLLAB_TEST_DATABASE_URL) : null;
if (pool && engine === 'legacy') await PostgresAuthority.migrate(pool);
const harness = await startHarness({ engine, pool }), browser = await chromium.launch({ headless: true });
try {
  const result = [];
  for (const size of sizes) {
    const id = `perf-${size}`, server = await harness.authority(id);
    for (let offset = 0; offset < size; offset += chunkSize) {
      await server.submit('A', { id: `seed-${offset}`, kind: 'edit', clock: offset / chunkSize + 1,
        after: ROOT, text: '文'.repeat(Math.min(chunkSize, size - offset)), deleteIds: [] });
    }
    const context = await browser.newContext(); const page = await context.newPage();
    const started = performance.now(); await page.goto(`${harness.url}/?doc=${id}&actor=A&engine=${engine}`);
    await page.waitForFunction(size => window.probeReady && probe.state().text.length === size, size);
    const loadMs = performance.now() - started;
    await page.evaluate(size => {
      probe.freeze(true); probe.setSelection(size); probe.metrics.editing.length = 0;
      window.localCommitSamples = [];
      const write = probe.journal.write.bind(probe.journal);
      probe.journal.write = async value => {
        const started = performance.now(); await write(value);
        window.localCommitSamples.push(performance.now() - started);
      };
    }, size);
    await page.keyboard.type('abcdefghijklmnopqrst', { delay: 100 }); await page.evaluate(() => probe.persist());
    const samples = await page.evaluate(() => [...probe.metrics.editing]);
    const localSamples = await page.evaluate(() => window.localCommitSamples);
    const retained = await page.evaluate(size => probe.state().text.length === size + 20 && probe.state().text.endsWith('abcdefghijklmnopqrst'), size);
    const syncStarted = performance.now();
    await page.evaluate(() => probe.freeze(false));
    await page.waitForFunction(() => probe.state().pending === 0 && probe.state().status === 'server-saved');
    const syncMs = performance.now() - syncStarted;
    const reloadStarted = performance.now(); await page.reload();
    await page.waitForFunction(size => window.probeReady && probe.state().display.length === size + 20, size);
    const reloadMs = performance.now() - reloadStarted;
    const reloadRetained = await page.evaluate(() => probe.state().display.endsWith('abcdefghijklmnopqrst'));
    result.push({ characters: size, seedOperations: Math.ceil(size / chunkSize), loadMs: Math.round(loadMs),
      inputHandlerMs: samples.map(x => Math.round(x)),
      p95InputHandlerMs: Math.round(p95(samples)),
      localCommitMs: localSamples.map(x => Math.round(x)), p95LocalCommitMs: Math.round(p95(localSamples)),
      syncMs: Math.round(syncMs), reloadMs: Math.round(reloadMs), textRetained: retained, reloadRetained });
    await context.close();
  }
  console.log(JSON.stringify({ environment: `Headless Chromium, local ${pool ? 'PostgreSQL' : 'memory'} authority, offline input followed by sync/reload`,
    engine, node: process.version, browser: browser.version(), samplesPerDocument: 20, results: result }, null, 2));
  if (result.some(row => !row.textRetained || !row.reloadRetained)) throw new Error('PERFORMANCE_PROBE_TEXT_LOSS');
} finally { await browser.close(); await harness.close(); await pool?.end(); }
