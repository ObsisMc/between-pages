import { chromium } from 'playwright';
import { performance } from 'node:perf_hooks';
import { startHarness } from '../browser/server.mjs';
import { ROOT } from '../model.mjs';
const harness = await startHarness(), browser = await chromium.launch({ headless: true });
try {
  const result = [];
  for (const size of [10000, 100000]) {
    const id = `perf-${size}`, server = await harness.authority(id);
    for (let offset = 0; offset < size; offset += 4000) {
      await server.submit('A', { id: `seed-${offset}`, kind: 'edit', clock: offset / 4000 + 1,
        after: ROOT, text: '文'.repeat(Math.min(4000, size - offset)), deleteIds: [] });
    }
    const context = await browser.newContext(); const page = await context.newPage();
    const started = performance.now(); await page.goto(`${harness.url}/?doc=${id}&actor=A`);
    await page.waitForFunction(size => window.probeReady && probe.state().text.length === size, size);
    const loadMs = performance.now() - started;
    await page.evaluate(size => { probe.freeze(true); probe.setSelection(size); probe.metrics.editing.length = 0; }, size);
    await page.keyboard.type('abcdefghijklmnopqrst', { delay: 100 }); await page.evaluate(() => probe.persist());
    const samples = await page.evaluate(() => [...probe.metrics.editing]);
    result.push({ characters: size, loadMs: Math.round(loadMs),
      inputHandlerMs: samples.map(x => Math.round(x)),
      p95InputHandlerMs: Math.round([...samples].sort((a,b) => a-b)[Math.ceil(samples.length * .95) - 1]),
      textRetained: await page.evaluate(size => probe.state().text.length === size + 20 && probe.state().text.endsWith('abcdefghijklmnopqrst'), size) });
    await context.close();
  }
  console.log(JSON.stringify({ environment: 'Headless Chromium, local memory authority, offline input', results: result }, null, 2));
} finally { await browser.close(); await harness.close(); }
