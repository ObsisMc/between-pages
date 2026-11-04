import { expect, test, type Browser, type Page } from '@playwright/test';

// Shared pages through the real stack (shared-pages ADR): two people in two browsers on one
// page. Names carry the browser and a per-run suffix.
const run = Date.now().toString(36);

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

async function bound(browser: Browser, browserName: string, tag: string) {
  const a = await signedIn(browser, `a${browserName}${run}${tag}`);
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, `b${browserName}${run}${tag}`);
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  return { a, b };
}

const editor = (page: Page) => page.locator('.diary-editor').getByRole('textbox');

async function newPage(page: Page, title: string) {
  await page.goto('/shared-pages');
  await page.getByRole('button', { name: '新建一页' }).click();
  await expect(page).toHaveURL(/\/shared-pages\/[0-9a-f-]{36}$/);
  await page.getByLabel('页面标题').fill(title);
  await page.getByLabel('页面标题').press('Enter');
  await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
  return page.url();
}

test('[adr:shared-pages#1] [adr:shared-pages#9] two people write one page and see each other live, and neither can delete the other’s words', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(60_000);
  const { a, b } = await bound(browser, browserName, 'w');
  const url = await newPage(a, '旅行清单');
  await editor(a).click();
  await a.keyboard.type('机票');
  await expect(a.getByRole('status').filter({ hasText: '已同步 · 对方可以看到' })).toBeVisible();

  await b.goto('/shared-pages');
  await expect(b.getByRole('link', { name: /旅行清单/ })).toContainText('新');
  await b.getByRole('link', { name: /旅行清单/ }).click();
  await expect(editor(b)).toHaveText('机票');

  await editor(b).click();
  await b.keyboard.press('End');
  await b.keyboard.type('酒店');
  await expect(editor(a)).toHaveText('机票酒店');

  // B's own words go; a selection over A's is refused and changes nothing.
  for (let i = 0; i < 2; i += 1) await b.keyboard.press('Backspace');
  await expect(editor(a)).toHaveText('机票');
  // The editor learns of the selection from this event, so Backspace must not overtake it.
  const selected = b.evaluate(
    () =>
      new Promise<void>((resolve) =>
        document.addEventListener('selectionchange', () => resolve(), { once: true }),
      ),
  );
  await b.keyboard.press('ControlOrMeta+a');
  await selected;
  await b.keyboard.press('Backspace');
  await expect(b.getByRole('alert').filter({ hasText: '不能修改或删除对方写的字' })).toBeVisible();
  await expect(editor(a)).toHaveText('机票');

  await b.goto('/shared-pages');
  await expect(b.getByRole('link', { name: /旅行清单/ })).not.toContainText('新');
  expect(a.url()).toBe(url);
});

test('[adr:shared-pages#10] input survives the page being deleted, while open and while offline', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(60_000);
  const { a, b } = await bound(browser, browserName, 'd');

  // Deleted while the writer has it open: the next word comes back as a draft.
  const open = await newPage(a, '开着删');
  await b.goto(open);
  await expect(b.getByRole('button', { name: '删除' })).toBeVisible();
  await b.getByRole('button', { name: '删除' }).click();
  await b.getByRole('button', { name: '确认删除' }).click();
  await expect(b).toHaveURL(/\/shared-pages$/);
  await editor(a).click();
  await a.keyboard.insertText('开着写的字');
  await expect(a.getByRole('status').filter({ hasText: '这一页已被删除' })).toBeVisible();
  await expect(a.getByText('开着写的字').last()).toBeVisible();

  // Deleted while the writer's socket is down: the list gives the words back.
  const away = await newPage(a, '离线删');
  await b.goto(away);
  await expect(b.getByRole('button', { name: '删除' })).toBeVisible();
  await a.routeWebSocket(/\/api\/sync$/, (ws) => void ws.close());
  await a.reload();
  await editor(a).click();
  await a.keyboard.insertText('离线写的字');
  await expect(a.getByRole('status').filter({ hasText: '暂时无法同步' })).toBeVisible();
  await b.getByRole('button', { name: '删除' }).click();
  await b.getByRole('button', { name: '确认删除' }).click();
  await expect(b).toHaveURL(/\/shared-pages$/);
  const context = a.context();
  await a.close();
  const back = await context.newPage();
  await back.goto('/shared-pages');
  const left = back.getByRole('region', { name: '已删除页面里没保存的内容' });
  await expect(left).toContainText('离线写的字');
});
