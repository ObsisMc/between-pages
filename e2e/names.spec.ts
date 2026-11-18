import { expect, test, type Browser, type Page } from '@playwright/test';

// Renaming through the real stack (display-name 验收标准): A renames under 设置 → 我的名字
// and sees it at once; B sees the new name after reloading, wherever A's name is shown. Names
// carry the browser and a per-run suffix, so projects running at once and reruns stay apart.
const run = Date.now().toString(36);

// Contexts opened with browser.newContext() outlive the test on the worker's browser, and
// their pages keep polling into every later test; each test closes the ones it opened.
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

const menu = (page: Page, label: RegExp) =>
  page.getByRole('navigation', { name: '主要' }).getByRole('button', { name: label }).click();

test('[adr:display-name#3] a new name shows at once for oneself and after a reload for the partner', async ({
  browser,
  browserName,
}) => {
  // Two accounts through several pages, as the wishes and anniversaries tests.
  test.setTimeout(60_000);
  const name = (who: string) => `${who}${browserName}${run}name`;
  const a = await signedIn(browser, name('a'));
  await a.getByRole('link', { name: '邀请搭档' }).click();
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, name('b'));
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  const spacePath = new URL(b.url()).pathname;

  // B records A's birthday before the rename.
  await b.goto('/anniversaries');
  await b.getByRole('button', { name: '记下一天' }).click();
  await b.getByRole('dialog').getByLabel('日期').fill('2026-05-01');
  await b.getByRole('button', { name: '记下', exact: true }).click();
  await expect(b.locator('li.anniversary')).toContainText(`${name('a')} 的生日`);

  await menu(a, /^设置/);
  await a.getByRole('menuitem', { name: '我的名字' }).click();
  await a.getByLabel('名字').fill('小雨');
  await a.getByRole('button', { name: '保存' }).click();
  await expect(a.getByText('已保存')).toBeVisible();
  await expect(a.getByRole('button', { name: '账号：小雨' })).toBeVisible();

  await b.goto('/');
  await expect(b.getByRole('button', { name: '戳戳或摸摸小雨' })).toBeVisible();
  await b.goto(spacePath);
  await expect(b.getByRole('heading', { level: 1 })).toHaveText('与 小雨 的空间');
  const today = await b.evaluate(() => new Date().toLocaleDateString('en-CA'));
  await b.goto(`/days/${today}`);
  await expect(b.getByLabel('作者').first()).toContainText('小雨');
  await b.goto('/wishes');
  await expect(b.getByRole('tab', { name: /小雨 的心愿/ })).toBeVisible();
  await b.goto('/anniversaries');
  await expect(b.locator('li.anniversary')).toContainText('小雨 的生日');
});
