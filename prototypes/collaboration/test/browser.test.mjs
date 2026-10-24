import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, firefox, webkit } from 'playwright';
import { startHarness } from '../browser/server.mjs';
import { PostgresAuthority } from '../postgres.mjs';

let harness, pool;
const browsers = new Map();
test.before(async () => {
  if (process.env.COLLAB_TEST_DATABASE_URL) {
    pool = PostgresAuthority.pool(process.env.COLLAB_TEST_DATABASE_URL); await PostgresAuthority.migrate(pool);
  }
  harness = await startHarness({ pool, engine: process.env.COLLAB_ENGINE ?? 'legacy' });
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit }))
    browsers.set(name, await engine.launch({ headless: true }));
  console.log(`BROWSER_ENVIRONMENT ${JSON.stringify({ node: process.version, postgres: Boolean(pool), engines: Object.fromEntries([...browsers].map(([name,browser])=>[name,browser.version()])) })}`);
});
test.after(async () => {
  for (const browser of browsers.values()) await browser.close();
  await harness?.close(); await pool?.end();
});
async function fixture(t, engine, mobile = false) {
  const browser = browsers.get(engine), context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 800 },
    ...(mobile && engine !== 'firefox' ? { hasTouch: true, isMobile: true } : {}) });
  const doc = randomUUID(); const errors = [];
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  const open = async actor => {
    const page = await context.newPage(); page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
    await page.goto(`${harness.url}/?actor=${actor}&doc=${doc}&engine=${process.env.COLLAB_ENGINE ?? 'legacy'}`);
    await page.waitForFunction(() => window.probeReady && navigator.serviceWorker.controller);
    return page;
  };
  return { context, doc, open, a: await open('A'), b: await open('B') };
}
const state = page => page.evaluate(() => probe.state());
const settled = page => page.waitForFunction(() => probe.state().pending === 0 && probe.state().status === 'server-saved');
async function type(page, text, at = null) {
  if (at !== null) await page.evaluate(at => probe.setSelection(at), at);
  else await page.locator('.ProseMirror').click();
  await page.keyboard.insertText(text);
  await page.evaluate(() => probe.persist());
}
async function contains(page, text) { await page.waitForFunction(text => probe.state().text.includes(text), text); }
async function seed(a, b) { await type(a, '甲乙'); await settled(a); await contains(b, '甲乙'); }

for (const engine of ['chromium', 'firefox', 'webkit']) {
  test(`${engine}: native typing, inline provenance and synthetic plain paste`, { timeout: 20000 }, async t => {
    const { a, b } = await fixture(t, engine); await seed(a, b);
    await type(b, '抱抱', 1); await settled(b); await contains(a, '抱抱');
    assert.equal((await state(a)).text, '甲抱抱乙');
    const colors = await a.locator('.diary-text > span[data-author]:not(.peer-caret)').evaluateAll(nodes => nodes.map(x => {
      const clone = x.cloneNode(true); clone.querySelectorAll('.peer-caret').forEach(x => x.remove());
      return [x.dataset.author, clone.textContent];
    }));
    assert.deepEqual(colors, [['A', '甲'], ['B', '抱抱'], ['A', '乙']]);
    await b.evaluate(() => { probe.setSelection(3); const data = new DataTransfer(); data.setData('text/plain', '<猫>'); data.setData('text/html', '<b data-author="A">evil</b>');
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      // Firefox intentionally strips data from an untrusted ClipboardEvent constructor.
      // Inject a fixture for the handler test; this is not an OS clipboard test.
      Object.defineProperty(event, 'clipboardData', { value: data }); probe.view.dom.dispatchEvent(event); });
    await contains(a, '<猫>'); assert.equal(await b.locator('b').count(), 0);
  });
  test(`${engine}: foreign deletion jumps; mixed replacement/cut denied`, async t => {
    const { a, b } = await fixture(t, engine); await seed(a, b);
    await type(b, '猫', 1); await settled(b); await contains(a, '猫');
    await a.evaluate(() => probe.setSelection(2)); await a.keyboard.press('Backspace');
    assert.deepEqual((await state(a)).selection, [1, 1]); assert.equal((await state(a)).text, '甲猫乙');
    await a.keyboard.press('Backspace'); assert.equal((await state(a)).text, '猫乙');
    await settled(a); await contains(b, '猫乙');
    await a.evaluate(() => probe.setSelection(0, 2)); await a.keyboard.insertText('不可替换');
    assert.equal((await state(a)).text, '猫乙');
    await a.evaluate(() => { const data = new DataTransfer(); probe.view.dom.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: data })); });
    assert.equal((await state(a)).text, '猫乙');
  });
  test(`${engine}: virtual-keyboard deletion, hold guard and forward jump`, async t => {
    const { a, b } = await fixture(t, engine, true); await seed(a, b); await type(b, '猫', 1); await settled(b); await contains(a, '猫');
    await a.evaluate(() => { probe.setSelection(2); probe.view.dom.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true })); });
    assert.deepEqual((await state(a)).selection, [1, 1]); assert.equal((await state(a)).text, '甲猫乙');
    await a.evaluate(() => { probe.setSelection(1); probe.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      probe.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', repeat: true, bubbles: true, cancelable: true })); });
    assert.deepEqual((await state(a)).selection, [2, 2]); assert.equal((await state(a)).text, '甲猫乙');
  });
  test(`${engine}: offline reload restores IndexedDB and merges remote edits`, { timeout: 30000 }, async t => {
    const { a, b, context } = await fixture(t, engine); await seed(a, b);
    // Freeze only A's actual network requests; SW still supplies its static shell on reload.
    await context.route('**/api/**', route => route.request().frame().page() === a ? route.abort('internetdisconnected') : route.continue());
    await a.evaluate(() => probe.freeze(true)); await type(a, '离线', 2);
    await a.reload(); await a.waitForFunction(() => window.probeReady); assert.equal((await state(a)).text, '甲乙离线');
    await type(b, '远端', 0); await settled(b);
    await context.unroute('**/api/**'); await a.evaluate(() => probe.freeze(false));
    await settled(a); await contains(b, '离线'); await contains(a, '远端');
    assert.equal((await state(a)).text, (await state(b)).text);
    assert.equal((await state(a)).display, (await state(a)).text);
  });
  test(`${engine}: real context offline refresh uses cached shell and local draft`, { timeout: 30000 }, async t => {
    const { a, context } = await fixture(t, engine); await type(a, '已同步'); await settled(a);
    await context.setOffline(true); await type(a, '离线草稿', 3); await a.reload();
    await a.waitForFunction(() => window.probeReady); assert.equal((await state(a)).text, '已同步离线草稿');
    assert.equal((await state(a)).pending, 1);
    await context.setOffline(false); await a.evaluate(() => probe.freeze(false)); await settled(a);
  });
  test(`${engine}: same-account tabs cannot overwrite each other's local journal`, { timeout: 30000 }, async t => {
    const { a, open } = await fixture(t, engine); const a2 = await open('A');
    await a.evaluate(() => probe.freeze(true)); await a2.evaluate(() => probe.freeze(true));
    await Promise.all([type(a, '手机', 0), type(a2, '电脑', 0)]);
    await a.reload(); await a.waitForFunction(() => window.probeReady);
    await contains(a, '手机'); await contains(a, '电脑');
    await settled(a); await a2.evaluate(() => probe.freeze(false)); await settled(a2);
    assert.equal((await state(a)).text, (await state(a2)).text);
  });
  test(`${engine}: personal undo preserves peer's nested text`, async t => {
    const { a, b } = await fixture(t, engine); await seed(a, b); await type(b, '抱抱', 1); await settled(b); await contains(a, '抱抱');
    await a.evaluate(() => probe.history(false)); await settled(a); await contains(b, '抱抱');
    assert.equal((await state(a)).text, '抱抱');
    await a.evaluate(() => probe.history(true)); await settled(a); assert.equal((await state(a)).text, '甲抱抱乙');
  });
  test(`${engine}: peer caret stays anchored after insertion and vanishes on disconnect`, async t => {
    const { a, b } = await fixture(t, engine); await seed(a, b);
    await b.evaluate(() => probe.setSelection(1));
    await a.waitForFunction(() => probe.resolvedPeers().some(x => x.actor === 'B' && x.at === 1));
    await type(a, '前', 0); await settled(a);
    await a.waitForFunction(() => probe.resolvedPeers().some(x => x.actor === 'B' && x.at === 2));
    await b.close(); await a.waitForFunction(() => probe.state().peers.length === 0);
  });
  test(`${engine}: whole-text grapheme grouping across operations prevents broken deletion`, async t => {
    const { a } = await fixture(t, engine); await type(a, 'e'); await type(a, '\u0301', 1);
    await a.keyboard.press('Backspace'); assert.equal((await state(a)).text, '');
    await type(a, '👨‍👩‍👧‍👦👍🏽🇨🇳'); await a.keyboard.press('Backspace'); assert.equal((await state(a)).text, '👨‍👩‍👧‍👦👍🏽');
    await a.keyboard.press('Backspace'); assert.equal((await state(a)).text, '👨‍👩‍👧‍👦');
  });
  test(`${engine}: storage failure stays visible and is not reported saved`, async t => {
    const { a } = await fixture(t, engine); await a.evaluate(() => { probe.freeze(true); probe.journal.fail = true; });
    await a.locator('.ProseMirror').click(); await a.keyboard.insertText('保留我');
    await a.waitForFunction(() => probe.state().status === 'local-save-failed'); assert.equal((await state(a)).display, '保留我');
    await a.evaluate(async () => { probe.journal.fail = false; await probe.client.persist(); probe.freeze(false); }); await settled(a);
    await a.reload(); await a.waitForFunction(() => window.probeReady); assert.equal((await state(a)).text, '保留我');
  });
}

test('chromium CDP: real composition input stays private, survives concurrent peer insert, commits once', { timeout: 30000 }, async t => {
  const { a, b, context } = await fixture(t, 'chromium'); await seed(a, b);
  await a.evaluate(() => probe.setSelection(2)); const cdp = await context.newCDPSession(a);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await a.waitForFunction(() => probe.state().composing);
  assert.equal((await state(b)).text, '甲乙'); assert.equal((await state(a)).text, '甲乙');
  await type(b, '对方', 0); await settled(b); await contains(a, '对方');
  assert.ok((await state(a)).display.endsWith('ni'));
  await cdp.send('Input.insertText', { text: '你好' });
  await a.waitForFunction(() => !probe.state().composing && probe.state().text.includes('你好'));
  await settled(a); await contains(b, '你好');
  assert.equal((await state(a)).text, '对方甲乙你好'); assert.equal((await state(b)).text, '对方甲乙你好');
});

test('chromium: additional 250ms per API request while typing does not steal selection or roll back text', { timeout: 30000 }, async t => {
  const { a, b, context } = await fixture(t, 'chromium'); await seed(a, b);
  await context.route('**/api/**', async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
  await a.evaluate(() => probe.setSelection(2));
  await Promise.all([a.keyboard.type('abcdefghij', { delay: 60 }), type(b, '远端', 0)]);
  await settled(a); await settled(b); await contains(a, '远端'); await contains(b, 'abcdefghij');
  assert.equal((await state(a)).text, '远端甲乙abcdefghij'); assert.deepEqual((await state(a)).selection, [14, 14]);
});

test('chromium CDP: canceled composition does not duplicate prefix or create shared phantom text', async t => {
  const { a, b, context } = await fixture(t, 'chromium'); await seed(a, b);
  const before = await a.evaluate(() => probe.records().length);
  await a.evaluate(() => probe.setSelection(0)); const cdp = await context.newCDPSession(a);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await a.waitForFunction(() => !probe.state().composing); await a.evaluate(() => probe.flush());
  assert.equal((await state(a)).text, '甲乙'); assert.equal((await state(a)).display, '甲乙');
  assert.equal((await state(b)).text, '甲乙'); assert.equal(await a.evaluate(() => probe.records().length), before);
});
test('chromium CDP: composing over foreign selection never edits shared foreign text', async t => {
  const { a, b, context } = await fixture(t, 'chromium'); await seed(a, b);
  await b.evaluate(() => probe.setSelection(0, 1)); const cdp = await context.newCDPSession(b);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '你' });
  await b.waitForFunction(() => !probe.state().composing && probe.state().error === 'FOREIGN_TEXT');
  assert.equal((await state(b)).text, '甲乙'); assert.equal((await state(b)).display, '甲乙');
  assert.equal((await state(a)).text, '甲乙');
});
test('chromium: batch sync bounds remote latency with 250ms extra HTTP request delay', { timeout: 30000 }, async t => {
  const { a, b, context } = await fixture(t, 'chromium'); await seed(a, b);
  const letters = 'abcdefghijklmnopqrst';
  await a.evaluate(letters => {
    window.arrivals = {};
    new MutationObserver(() => {
      const text = probe.state().text;
      for (const letter of letters) if (text.includes(letter) && !window.arrivals[letter]) window.arrivals[letter] = Date.now();
    }).observe(probe.view.dom, { childList: true, subtree: true, characterData: true });
  }, letters);
  await context.route('**/api/**', async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
  await b.evaluate(() => { probe.setSelection(2); probe.metrics.writes.length = 0; });
  await b.keyboard.type(letters, { delay: 50 }); await settled(b); await contains(a, letters);
  const arrivals = await a.evaluate(() => window.arrivals), writes = await b.evaluate(() => probe.metrics.writes);
  const delays = writes.map(x => arrivals[x.text] - x.at).sort((a,b) => a-b);
  const p95 = delays[Math.ceil(delays.length * .95) - 1];
  assert.equal(delays.length, 20); assert.ok(delays.every(x => x >= 0)); assert.ok(p95 < 2000, JSON.stringify(delays));
  console.log(`REMOTE_DELAY_METRIC ${JSON.stringify({ extraHttpRequestDelayMs: 250, samples: delays.length, p95Ms: p95, maxMs: Math.max(...delays) })}`);
});

test('chromium: native system clipboard paste strips author metadata; copy excludes peer widgets', async t => {
  const { a, b, context } = await fixture(t, 'chromium'); await seed(a, b);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await b.evaluate(async () => {
    probe.setSelection(1);
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob(['新内容'], { type: 'text/plain' }),
      'text/html': new Blob(['<span data-author="A">新内容</span>'], { type: 'text/html' })
    })]);
  });
  await b.keyboard.press('Control+v'); await contains(a, '新内容');
  assert.equal(await b.evaluate(() => probe.client.document().text('B')), '新内容');
  await a.evaluate(() => probe.setSelection(0, 5)); await a.keyboard.press('Control+c');
  assert.equal(await a.evaluate(() => navigator.clipboard.readText()), '甲新内容乙');
  await a.keyboard.press('Control+x'); assert.equal((await state(a)).text, '甲新内容乙');
});

if (process.env.COLLAB_ENGINE === 'yjs') {
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    test(`Yjs ${engine}: reload with committed response in flight restores pending without duplication`, { timeout: 30000 }, async t => {
      const { a, b, doc } = await fixture(t, engine); await seed(a, b);
      await a.evaluate(() => probe.freeze(true)); await type(a, '刷新仍保留', 2);
      let release, committed;
      const holding = new Promise(resolve => { release = resolve; });
      const reachedCommit = new Promise(resolve => { committed = resolve; });
      const authority = await harness.authority(doc), previousHook = authority.afterCommit;
      // Server-side barrier works across all browser engines and Service Workers;
      // it does not depend on Playwright intercepting a worker-controlled request.
      authority.afterCommit = async () => { committed(); await holding; };
      try {
        await a.evaluate(() => probe.freeze(false));
        await Promise.race([reachedCommit, new Promise((_, reject) => {
          const timeout = setTimeout(() => reject(new Error('COMMIT_NOT_REACHED')), 10000); timeout.unref();
        })]);
        assert.equal((await state(a)).pending, 1);
        await a.reload(); release(); await a.waitForFunction(() => window.probeReady);
        await settled(a); await contains(b, '刷新仍保留');
        assert.equal((await state(a)).display, '甲乙刷新仍保留');
        const records = await (await harness.authority(doc)).read('A');
        assert.equal(records.filter(record => record.op.text === '刷新仍保留').length, 1);
        // Handler-level BFCache lifecycle fixture, not a claim of native BFCache coverage.
        await a.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        await type(a, '恢复后续写', 7); await settled(a); await contains(b, '恢复后续写');
      } finally { release(); authority.afterCommit = previousHook; }
    });
  }
  test('Yjs browser: every optimistic character remains visible through stale pulls and lost ACK', { timeout: 30000 }, async t => {
    const { a, b, context, doc } = await fixture(t, 'chromium'); await seed(a, b);
    const stale = await a.evaluate(() => probe.records());
    await a.evaluate(() => {
      probe.freeze(true); window.lostCharacters = [];
      new MutationObserver(() => {
        const visible = probe.view.state.doc.textContent;
        for (const entry of probe.metrics.writes) {
          if (entry.text && !visible.includes(entry.text)) window.lostCharacters.push(entry.text);
        }
      }).observe(probe.view.dom, { childList: true, subtree: true, characterData: true });
    });
    await type(a, 'abcdefghij', 2);
    await type(b, '远端', 0); await settled(b);
    await a.evaluate(stale => probe.receiveOld(stale), stale);
    assert.equal((await state(a)).display, '甲乙abcdefghij');
    // Drop the actual HTTP response after the backend commits the operation batch.
    let dropped = false;
    await context.route('**/batch', async route => {
      if (route.request().frame().page() === a && !dropped) {
        dropped = true; await route.fetch(); await route.abort('connectionreset');
      } else await route.continue();
    });
    await a.evaluate(() => probe.freeze(false)); await settled(a); await contains(b, 'abcdefghij');
    assert.ok(dropped); assert.deepEqual(await a.evaluate(() => window.lostCharacters), []);
    assert.equal((await state(a)).display, '远端甲乙abcdefghij');
    const records = await (await harness.authority(doc)).read('A');
    assert.equal(records.filter(record => record.op.text === 'abcdefghij').length, 1);
    assert.ok(records.every(record => typeof record.update === 'string'));
  });

  test('Yjs HTTP: authenticated attacker cannot upload binary changes or delete peer text', async t => {
    const { a, b, doc } = await fixture(t, 'chromium'); await seed(a, b);
    const target = await a.evaluate(() => probe.client.document().visible()[0].id);
    for (const operation of [
      { kind: 'edit', id: randomUUID(), clock: 2, after: '^', text: '', deleteIds: [target] },
      { kind: 'edit', id: randomUUID(), clock: 2, after: '^', text: '伪造', deleteIds: [], actor: 'A' },
      { kind: 'edit', id: randomUUID(), clock: 2, after: '^', text: '伪造', deleteIds: [], update: 'AA==' }
    ]) {
      const response = await fetch(`${harness.url}/api/${doc}/batch`, { method: 'POST',
        headers: { authorization: 'Bearer probe-B', 'content-type': 'application/json' },
        body: JSON.stringify({ operations: [operation] }) });
      assert.ok([403, 409].includes(response.status));
    }
    assert.equal((await (await harness.authority(doc)).read('A')).length, 1);
    assert.equal((await state(a)).display, '甲乙'); assert.equal((await state(b)).display, '甲乙');
  });
}
