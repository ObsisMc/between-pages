import { expect, test, type Browser, type Page } from '@playwright/test';

// The home's mascots through the real stack (window-mascots ADR): A pokes and pets B's
// mascot, B's home says so once and never again after a reload; playing with one's own
// mascot sends nothing; under reduced motion nothing moves while the bubble still shows.
// Names carry the browser and a per-run suffix.
const run = Date.now().toString(36);

// Contexts opened with browser.newContext() outlive the test on the worker's browser, and
// their pages keep polling into every later test; each test closes the ones it opened.
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

async function signedIn(
  browser: Browser,
  name: string,
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion })).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

async function pair(browser: Browser, prefix: string) {
  const a = await signedIn(browser, `${prefix}a`);
  await a.getByRole('link', { name: '邀请搭档' }).click();
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  await a.getByRole('navigation', { name: '主要' }).getByRole('link', { name: '此刻' }).click();
  const b = await signedIn(browser, `${prefix}b`, 'reduce');
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  return { a, b };
}

test('[adr:window-mascots#1] [adr:window-mascots#4] [adr:window-mascots#7] a poke and a pet reach the partner once; one’s own mascot sends nothing; reduced motion keeps still', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  const name = (who: string) => `mp${browserName}${run}${who}`;
  const { a, b } = await pair(browser, `mp${browserName}${run}`);

  await a.goto('/');
  const sent: string[] = [];
  a.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/pokes')) sent.push(r.postData() ?? '');
  });
  await a.getByRole('button', { name: '戳戳或摸摸自己的团子' }).click();
  await expect(a.getByText(/^(嘿嘿|痒～|在呢|别闹啦)$/)).toBeVisible();
  expect(sent).toEqual([]);

  const theirs = a.getByRole('button', { name: `戳戳或摸摸${name('b')}` });
  const poked = a.waitForResponse(
    (r) => r.url().endsWith('/api/pokes') && r.request().method() === 'POST',
  );
  await theirs.click();
  await expect(a.getByText(`戳了${name('b')}一下`)).toBeVisible();
  await poked;
  // A drag across the partner's mascot is a pet.
  const box = (await theirs.boundingBox())!;
  const petted = a.waitForResponse(
    (r) => r.url().endsWith('/api/pokes') && r.request().method() === 'POST',
  );
  await a.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await a.mouse.down();
  await a.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 });
  await a.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 5 });
  await a.mouse.up();
  await petted;
  expect(sent.map((body) => JSON.parse(body).kind)).toEqual(['poke', 'pet']);

  // B, under reduced motion, hears it on opening the home and confirms it.
  const confirmed = b.waitForResponse((r) => r.url().endsWith('/api/pokes/seen') && r.ok());
  await b.goto('/');
  await expect(b.getByText(new RegExp(`^${name('a')} 在 .* 戳了你一下，摸了摸你$`))).toBeVisible();
  await confirmed;
  const moving = await b.evaluate(() =>
    [...document.querySelectorAll<SVGElement>('.mascot-window g[class^="mascot-"]')].some(
      (g) => getComputedStyle(g).animationName !== 'none',
    ),
  );
  expect(moving).toBe(false);

  await b.reload();
  await expect(b.getByRole('button', { name: '戳戳或摸摸自己的团子' })).toBeVisible();
  // Asked again on opening: nothing waits any more.
  await b.waitForResponse((r) => r.url().endsWith('/api/pokes') && r.request().method() === 'GET');
  await expect(b.getByText(/戳了你/)).toHaveCount(0);
});
