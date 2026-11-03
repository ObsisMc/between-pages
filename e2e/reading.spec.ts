import { expect, test, type Browser, type Page } from '@playwright/test';

// Stage 2 reading through the real stack (unread-and-day-page): the merged list of days, now
// the workspace's feed, and its unread dot (D2, D3, book-frontend-workspace D5); the day
// page as the workspace's left page, which scrolls inside its own box. The API runs with
// HISTORY_IDLE_MS=3000, so a history point, and with it the list's unread, closes seconds
// after the last commit instead of two minutes.
const run = Date.now().toString(36);

// Contexts opened with browser.newContext() outlive the test on the worker's browser, and
// their pages keep polling into every later test; each test closes the ones it opened.
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

// The diary editors; the feed's date jump is a textbox too.
const editor = (page: Page) => page.locator('.diary-editor').getByRole('textbox');
const feed = (page: Page) => page.getByRole('region', { name: '所有日记' });

/** "写今天" in the diary workspace; returns the date the server chose. */
async function writeToday(page: Page) {
  await page.goto('/days');
  await page.getByRole('button', { name: '写今天' }).click();
  await expect(page).toHaveURL(/\/days\/\d{4}-\d{2}-\d{2}$/);
  return page.url().split('/').at(-1)!;
}

/** Chooses `date` in the feed; the left page opens it. */
async function chooseInFeed(page: Page, date: string) {
  await feed(page).locator(`[data-date="${date}"]`).getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/days/${date}$`));
}
const synced = (page: Page) =>
  expect(page.locator('.save-status')).toHaveText('已同步 · 对方可以看到', { timeout: 15_000 });

/** A shares every date with B (the invitation default); B shares nothing. */
async function pair(browser: Browser, prefix: string) {
  const a = await signedIn(browser, `${prefix}a`);
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, `${prefix}b`);
  await b.goto(link);
  await b.getByLabel('暂不设置').check();
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  return { a, b };
}

test('READ-01 the feed lights once A’s text is in a history point and goes out after B reads it', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  const prefix = `rd${browserName}${run}`;
  const { a, b } = await pair(browser, prefix);

  const date = await writeToday(a);
  await editor(a).click();
  await a.keyboard.type('A写的新内容');
  await synced(a);

  // B's feed shows the date with A's initial; the dot appears once the point closes.
  const day = feed(b).locator(`[data-date="${date}"]`);
  const dot = day.getByLabel('有新内容');
  await b.goto('/days');
  await expect(day.getByRole('img', { name: `${prefix}a` })).toHaveText(prefix[0]!.toUpperCase());
  // The feed shows the text in full once the point closes; B reads it there for about a
  // second, and the dot goes out.
  const reported = b.waitForResponse(
    (res) => res.url().endsWith('/read') && res.request().method() === 'POST',
  );
  await expect(async () => {
    await b.reload();
    await expect(dot).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(day).toContainText('A写的新内容');
  await reported;
  await expect(dot).toHaveCount(0);

  // Read for good: the list says so after a reload, and the day opens with the text.
  await b.reload();
  await expect(day).toContainText('A写的新内容');
  await expect(dot).toHaveCount(0);
  await chooseInFeed(b, date);
  await expect(editor(b)).toHaveText('A写的新内容');
  await b.goBack();
  await expect(day).toContainText('A写的新内容');
  await expect(dot).toHaveCount(0);
});

/** B's day page scrolls inside the workspace's left page: its box, and its scroll. */
const leftPage = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.workspace-left')!;
    const rect = box.getBoundingClientRect();
    return {
      top: Math.max(rect.top, 0),
      bottom: Math.min(rect.bottom, window.innerHeight),
      scrollTop: box.scrollTop,
    };
  });

/** Pastes `text` at the caret of the page's editor, as the clipboard would. */
async function paste(page: Page, text: string) {
  await page.evaluate((content) => {
    // Firefox ignores clipboardData in the event's init; the editor reads only getData.
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? content : '') },
    });
    document.querySelector('[role="textbox"]')!.dispatchEvent(event);
  }, text);
}

/** Where `marker` starts in the window, from the editor's text nodes; null when absent. */
const topOf = (page: Page, marker: string) =>
  page.evaluate((needle) => {
    const walker = document.createTreeWalker(
      document.querySelector('[role="textbox"]')!,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      return range.getBoundingClientRect().top;
    }
    return null;
  }, marker);

const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `第${from + i}行：今天也写了一点。`).join('\n');

test('[adr:unread-and-day-page#6] [adr:unread-and-day-page#8] READ-01 SYNC-06 opens at the top, jumps to unread a third down, and keeps the reading position', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const prefix = `rp${browserName}${run}`;
  const { a, b } = await pair(browser, prefix);
  const date = await writeToday(a);
  await editor(a).click();
  await paste(a, lines(1, 120));
  await synced(a);

  // Opening leaves the page at the top and offers the unread; nothing scrolls by itself.
  await b.goto('/days');
  await chooseInFeed(b, date);
  await expect(b.getByText('有 1 处新内容 · 跳到第一处')).toBeVisible();
  await expect(editor(b)).toContainText('第120行');
  expect(await b.evaluate(() => window.scrollY)).toBe(0);
  expect((await leftPage(b)).scrollTop).toBe(0);
  // What is on screen is read after about a second; the rest lies below.
  await expect(b.getByText('↓ 下面有新内容')).toBeVisible({ timeout: 10_000 });
  expect(await b.evaluate(() => window.scrollY)).toBe(0);
  expect((await leftPage(b)).scrollTop).toBe(0);

  // "下一处未读" brings the unread passage about a third down the page, highlighted.
  await b.locator('.workspace-left').getByRole('button', { name: '下一处未读' }).click();
  const flash = b.locator('.unread-flash');
  await expect(flash).toBeVisible();
  const page = await leftPage(b);
  const flashTop = await b.evaluate(
    () => document.querySelector('.unread-flash')!.getBoundingClientRect().top,
  );
  expect(Math.abs(flashTop - (page.top + (page.bottom - page.top) / 3))).toBeLessThan(40);
  await expect(b.getByText('↑ 上面有新内容')).toHaveCount(0);

  // The notice keeps its line once used (D5): idle, it is as tall as while it offered the
  // jump, so nothing below it moves under the reader.
  const banner = b.locator('.workspace-left .unread-banner');
  const offered = (await banner.boundingBox())!.height;
  await b.getByRole('button', { name: '跳到第一处' }).click();
  await expect(b.getByText('有 1 处新内容 · 跳到第一处')).toHaveCount(0);
  expect((await banner.boundingBox())!.height).toBe(offered);

  // B writes a block of their own between lines 60 and 61, then reads around line 60.
  const next = (await b.evaluate(() => {
    const walker = document.createTreeWalker(
      document.querySelector('[role="textbox"]')!,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf('第61行');
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      range.startContainer.parentElement!.scrollIntoView({ block: 'center' });
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }
    return null;
  }))!;
  await b.mouse.click(next.x, next.y);
  await paste(
    b,
    `${Array.from({ length: 40 }, (_, i) => `B的第${i + 1}行，我也在写。`).join('\n')}\n`,
  );
  await expect(b.locator('.save-status')).toHaveText('已同步 · 对方可以看到', { timeout: 15_000 });
  await expect(editor(a)).toContainText('B的第40行');
  await b.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const lineHeight = await b.evaluate(
    () =>
      parseFloat(getComputedStyle(document.querySelector('[role="textbox"]')!).lineHeight) || 24,
  );
  const scrollToLine = async (marker: string) => {
    const top = (await topOf(b, marker))!;
    await b.evaluate((y) => {
      const box = document.querySelector('.workspace-left')!;
      const rect = box.getBoundingClientRect();
      box.scrollTop += y - (rect.top + rect.height / 2);
    }, top);
  };
  await scrollToLine('第60行');
  const before = (await topOf(b, '第60行'))!;

  // A writes a long passage at the very top: B's line 60 does not move.
  await editor(a).click();
  await a.keyboard.press('ControlOrMeta+Home');
  await paste(a, `${lines(1001, 1040)}\n`);
  await expect(editor(b)).toContainText('第1040行');
  expect(Math.abs((await topOf(b, '第60行'))! - before)).toBeLessThanOrEqual(lineHeight);

  // The own-text-only filter keeps B's own text where it was, on and off.
  await scrollToLine('B的第20行');
  const own = (await topOf(b, 'B的第20行'))!;
  // Clicked where it is: Playwright's own click would scroll the page up to the control.
  const filter = b.getByLabel('只看我的文字');
  await filter.dispatchEvent('click');
  await expect(filter).toBeChecked();
  expect(Math.abs((await topOf(b, 'B的第20行'))! - own)).toBeLessThanOrEqual(lineHeight);
  await filter.dispatchEvent('click');
  await expect(filter).not.toBeChecked();
  expect(Math.abs((await topOf(b, 'B的第20行'))! - own)).toBeLessThanOrEqual(lineHeight);

  // While B types, the caret's line is the anchor, and focus stays with B.
  await scrollToLine('B的第30行');
  const spot = (await b.evaluate(() => {
    const walker = document.createTreeWalker(
      document.querySelector('[role="textbox"]')!,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf('B的第30行');
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }
    return null;
  }))!;
  await b.mouse.click(spot.x, spot.y);
  const typing = (await topOf(b, 'B的第30行'))!;
  await editor(a).click();
  await a.keyboard.press('ControlOrMeta+Home');
  await paste(a, `${lines(2001, 2030)}\n`);
  await expect(editor(b)).toContainText('第2030行');
  expect(Math.abs((await topOf(b, 'B的第30行'))! - typing)).toBeLessThanOrEqual(lineHeight);
  await expect(editor(b)).toBeFocused();
});
