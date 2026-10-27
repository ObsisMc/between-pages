import { expect, test, type Browser, type Page } from '@playwright/test';

// Kernel ADR K17, measured, not asserted: runs only with MEASURE_LATENCY=1, e.g.
//   MEASURE_LATENCY=1 bash scripts/with-test-postgres.sh npx playwright test e2e/latency.spec.ts --project=chromium
// Two accounts in their own contexts share one diary of about 100,000 characters; every
// sync socket of both goes through a proxy that holds each message 250 ms each way, so
// each side has about 500 ms round trip to the server. Prints one JSON line of results.
const run = Date.now().toString(36);
const ONE_WAY_MS = 250;
const SAMPLES = Number(process.env.LATENCY_SAMPLES ?? 100);

test.skip(!process.env.MEASURE_LATENCY, 'measurement only: set MEASURE_LATENCY=1');

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

/** Every sync socket of the page through a proxy delaying each message `ONE_WAY_MS`. */
async function slowSocket(page: Page) {
  await page.routeWebSocket(/\/api\/sync$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => void setTimeout(() => server.send(m), ONE_WAY_MS));
    server.onMessage((m) => void setTimeout(() => ws.send(m), ONE_WAY_MS));
  });
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);
};
const summary = (values: number[]) => ({
  n: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  p99: percentile(values, 99),
  max: Math.round(Math.max(...values)),
});

test('K17 local input, remote text and caret latency at ~500 ms RTT per side', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(20 * 60_000);
  const name = (who: string) => `${who}${browserName}${run}`;
  const a = await signedIn(browser, name('la'));
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, name('lb'));
  await b.goto(link);
  await b.getByLabel('暂不设置').check();
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\//);

  // About 100,000 characters, pasted in one operation.
  await a.goto('/');
  await a.getByRole('button', { name: '写今天' }).click();
  await expect(a).toHaveURL(/\/diaries\/[0-9a-f-]{36}$/);
  const editorA = a.getByRole('textbox');
  await editorA.click();
  await a.evaluate(() => {
    const line = '今天的风很轻，我们沿着河边走了很久，说起小时候的事。\n';
    const text = line.repeat(Math.ceil(100_000 / line.length)).slice(0, 100_000);
    // Firefox ignores clipboardData in the event's init; the editor reads only getData.
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    });
    document.querySelector('[role="textbox"]')!.dispatchEvent(paste);
  });
  await expect(a.locator('.save-status')).toHaveText('已保存到服务器', { timeout: 60_000 });
  const diaryUrl = a.url();

  // Both sides behind the slow proxy from here on.
  await slowSocket(a);
  await slowSocket(b);
  await a.goto(diaryUrl);
  await expect(a.locator('.save-status')).toHaveText('已保存到服务器', { timeout: 60_000 });
  await b.goto('/');
  await b
    .getByRole('region', { name: `${name('la')} 共享的日记` })
    .getByRole('link')
    .click();
  const editorB = b.getByRole('textbox');
  await expect(editorB).toContainText('今天的风很轻', { timeout: 60_000 });
  await expect(b.locator('.save-status')).toHaveText('已保存到服务器', { timeout: 60_000 });

  // B records when its text grows and when A's caret moves, by the shared wall clock.
  await b.evaluate(() => {
    const box = document.querySelector('[role="textbox"]')!;
    const log = { text: [] as [number, number][], caret: [] as [number, string][] };
    (window as unknown as { latencyLog: typeof log }).latencyLog = log;
    let length = box.textContent!.length;
    let caretAt = '';
    new MutationObserver(() => {
      const now = Date.now();
      if (box.textContent!.length !== length) {
        length = box.textContent!.length;
        log.text.push([length, now]);
      }
      const caret = box.querySelector('.remote-caret');
      const at = caret
        ? `${caret.previousSibling?.textContent?.length}:${caret.nextSibling?.textContent?.slice(0, 8)}`
        : '';
      if (at !== caretAt) {
        caretAt = at;
        log.caret.push([0, at]);
        log.caret[log.caret.length - 1]![0] = now;
      }
    }).observe(box, { childList: true, subtree: true, characterData: true });
  });
  const logOf = () =>
    b.evaluate(
      () =>
        (
          window as unknown as {
            latencyLog: { text: [number, number][]; caret: [number, string][] };
          }
        ).latencyLog,
    );

  // A measures its own keystroke-to-paint time on the same document.
  await a.evaluate(() => {
    const box = document.querySelector('[role="textbox"]')!;
    const local: number[] = [];
    (window as unknown as { localLatency: number[] }).localLatency = local;
    let pressed: number | null = null;
    box.addEventListener('keydown', (event) => (pressed = event.timeStamp), true);
    new MutationObserver(() => {
      if (pressed === null) return;
      const from = pressed;
      pressed = null;
      requestAnimationFrame(() => local.push(performance.now() - from));
    }).observe(box, { childList: true, subtree: true, characterData: true });
  });

  await editorA.click();
  await a.keyboard.press('ControlOrMeta+End');
  const remote: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const seen = (await logOf()).text.length;
    const sentAt = Date.now();
    await a.keyboard.type(String(i % 10));
    await expect
      .poll(async () => (await logOf()).text.length, { timeout: 30_000 })
      .toBeGreaterThan(seen);
    remote.push((await logOf()).text[seen]![1] - sentAt);
    await a.waitForTimeout(100); // pacing between samples, not a wait for a result
  }
  const local = await a.evaluate(
    () => (window as unknown as { localLatency: number[] }).localLatency,
  );

  // Caret moves over known text: one character left each time.
  const carets: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const seen = (await logOf()).caret.length;
    const movedAt = Date.now();
    await a.keyboard.press('ArrowLeft');
    await expect
      .poll(async () => (await logOf()).caret.length, { timeout: 30_000 })
      .toBeGreaterThan(seen);
    carets.push((await logOf()).caret[seen]![0] - movedAt);
    await a.waitForTimeout(150); // pacing: the caret is sent at most every 100 ms
  }

  console.log(
    `K17 ${JSON.stringify({
      browser: browserName,
      browserVersion: browser.version(),
      documentCharacters: 100_000 + SAMPLES,
      oneWayDelayMs: ONE_WAY_MS,
      localInputMs: summary(local),
      remoteTextMs: summary(remote),
      remoteCaretMs: summary(carets),
    })}`,
  );
});
