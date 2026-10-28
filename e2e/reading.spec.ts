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
