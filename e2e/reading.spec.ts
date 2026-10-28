import { expect, test, type Browser, type Page } from '@playwright/test';

// Stage 2 reading through the real stack (unread-and-day-page): the merged day list and
// its unread dot (D2, D3). The API runs with HISTORY_IDLE_MS=3000, so a history point, and
// with it the list's unread, closes seconds after the last commit instead of two minutes.
const run = Date.now().toString(36);

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

const editor = (page: Page) => page.getByRole('textbox');
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

test('READ-01 the day list lights once A’s text is in a history point and goes out after B reads it', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  const prefix = `rd${browserName}${run}`;
  const { a, b } = await pair(browser, prefix);

  await a.goto('/');
  await a.getByRole('button', { name: '写今天' }).click();
  await expect(a).toHaveURL(/\/diaries\/[0-9a-f-]{36}$/);
  await editor(a).click();
  await a.keyboard.type('A写的新内容');
  await synced(a);

  // B's list shows the date with A's initial; the dot appears once the point closes.
  const list = b.getByRole('region', { name: '日记', exact: true });
  const dot = list.getByLabel('有新内容');
  await b.goto('/');
  await expect(list.getByRole('img', { name: `${prefix}a` })).toHaveText(prefix[0]!.toUpperCase());
  await expect(async () => {
    await b.reload();
    await expect(dot).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  // B reads the text on screen for about a second; back home, the dot is gone.
  const reported = b.waitForResponse(
    (res) => res.url().endsWith('/read') && res.request().method() === 'POST',
  );
  await list.getByRole('link', { name: /A写的新内容/ }).click();
  await expect(editor(b)).toHaveText('A写的新内容');
  await reported;
  await b.getByRole('link', { name: '← 返回' }).click();
  await expect(list.getByRole('link', { name: /A写的新内容/ })).toBeVisible();
  await expect(dot).toHaveCount(0);
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
  await a.goto('/');
  await a.getByRole('button', { name: '写今天' }).click();
  await expect(a).toHaveURL(/\/diaries\/[0-9a-f-]{36}$/);
  await editor(a).click();
  await paste(a, lines(1, 120));
  await synced(a);

  // Opening leaves the page at the top and offers the unread; nothing scrolls by itself.
  await b.goto('/');
  await b.getByRole('region', { name: '日记', exact: true }).getByRole('link').click();
  await expect(b.getByText('有 1 处新内容 · 跳到第一处')).toBeVisible();
  await expect(editor(b)).toContainText('第120行');
  expect(await b.evaluate(() => window.scrollY)).toBe(0);
  // What is on screen is read after about a second; the rest lies below.
  await expect(b.getByText('↓ 下面有新内容')).toBeVisible({ timeout: 10_000 });
  expect(await b.evaluate(() => window.scrollY)).toBe(0);

  // "下一处未读" brings the unread passage about a third down the window, highlighted.
  await b.getByRole('button', { name: '下一处未读' }).click();
  const flash = b.locator('.unread-flash');
  await expect(flash).toBeVisible();
  const [height, flashTop] = await b.evaluate(() => [
    window.innerHeight,
    document.querySelector('.unread-flash')!.getBoundingClientRect().top,
  ]);
  expect(Math.abs(flashTop - height / 3)).toBeLessThan(40);
  await expect(b.getByText('↑ 上面有新内容')).toHaveCount(0);

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
    await b.evaluate((y) => window.scrollBy(0, y - window.innerHeight / 2), top);
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
