import { expect, test, type Browser, type Page } from '@playwright/test';

// Spaces-and-invitations acceptance R7 through the real stack: three independent accounts
// (A, B, C) in their own browser contexts, the mock issuer, the API and PostgreSQL. No
// diary text takes part; every screen says diary sharing is not open yet. Names carry the
// browser and a per-run suffix, so projects running at once and reruns stay independent.
const run = Date.now().toString(36);

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await devLogin(page, name);
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

async function devLogin(page: Page, name: string) {
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
}

/** Generates an invitation on the home page and returns its link. */
async function inviteLink(page: Page, choose?: (page: Page) => Promise<void>) {
  await page.goto('/');
  await choose?.(page);
  await page.getByRole('button', { name: '生成邀请链接' }).click();
  return page.getByLabel('邀请链接').inputValue();
}

const notOpenYet = (page: Page) =>
  expect(page.getByText('范围已设置，日记共享尚未开放').first()).toBeVisible();

test('AUTH-02 AUTH-07 AUTH-08 AUTH-11 SHARE-03 binds, unbinds and restores one fixed pair with private ranges', async ({
  browser,
  browserName,
}) => {
  const name = (who: string) => `${who}${browserName}${run}`;
  const a = await signedIn(browser, name('a'));

  // A keeps the default: all history and later.
  const link = await inviteLink(a);
  expect(link).toMatch(/\/join#token=[A-Za-z0-9_-]{43}$/);
  await notOpenYet(a);

  // B opens the link signed out, signs in, and comes back to it.
  const b = await (await browser.newContext()).newPage();
  await b.goto(link);
  await expect(b).toHaveURL(/\/join$/);
  await b.getByRole('link', { name: '去登录' }).click();
  await devLogin(b, name('b'));
  await expect(b).toHaveURL(/\/join$/);
  await expect(b.getByText(name('a'))).toBeVisible();
  await expect(b.getByText(name('b'))).toBeVisible();
  await expect(b.getByText(/首版绑定后搭档固定/)).toBeVisible();

  // B shares one day only.
  await b.getByLabel('自选日期').check();
  await b.getByRole('button', { name: '添加共享日期' }).click();
  const day = b.getByRole('group', { name: '共享第 1 段' });
  await day.getByLabel('开始').fill('2026-10-05');
  await day.getByLabel('结束').fill('2026-10-05');
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  const spaceUrl = new URL(b.url()).pathname;
  await expect(b.getByText(`与 ${name('a')} 的空间`)).toBeVisible();
  await expect(b.getByText('共享：2026-10-05（已为本次绑定确认）')).toBeVisible();
  await notOpenYet(b);

  // A sees the space and only A's own range.
  await a.goto('/');
  await a.getByRole('link', { name: `与 ${name('b')} 的空间` }).click();
  await expect(a.getByText('共享：全部历史与以后（已为本次绑定确认）')).toBeVisible();
  await expect(a.locator('body')).not.toContainText('2026-10-05');

  // C may not see it.
  const c = await signedIn(browser, name('c'));
  await c.goto(spaceUrl);
  await expect(c.getByRole('alert')).toHaveText('找不到这个空间');

  // A unbinds alone, after a second confirmation; both keep the space and its history.
  await a.getByRole('button', { name: '解除绑定' }).click();
  await a.getByRole('button', { name: '确认解除绑定' }).click();
  await expect(a.getByText('已解绑，只能与原搭档恢复')).toBeVisible();
  await b.reload();
  await expect(b.getByText('已解绑，只能与原搭档恢复')).toBeVisible();
  await expect(b.getByText('共享：2026-10-05')).toBeVisible();

  // The partner stays fixed: A cannot join C.
  const fromC = await inviteLink(c);
  await a.goto(fromC);
  await expect(a.getByRole('alert')).toHaveText('首版绑定后搭档固定，只能与原搭档恢复关系');

  // B invites A again without setting a range; A restores the same space without one.
  const again = await inviteLink(b, (page) => page.getByLabel('暂不设置').check());
  await a.goto(again);
  await expect(a.getByText(`接受后恢复你和 ${name('b')} 原来的双人空间。`)).toBeVisible();
  await a.getByLabel('暂不设置').check();
  await a.getByRole('button', { name: '接受邀请' }).click();
  await expect(a).toHaveURL(new RegExp(`${spaceUrl}$`));
  await expect(a.getByText('当前绑定中')).toBeVisible();
  await expect(a.locator('.periods li')).toHaveCount(2);
  await expect(
    a.getByText('共享：全部历史与以后（尚未为本次绑定确认，之前的设置仅供参考）'),
  ).toBeVisible();
});
