import { expect, test, type Browser, type Page } from '@playwright/test';

// Invitations addressed to a Google email through the real stack (in-app-invitation-by-email
// 验收标准). The dev issuer signs `<name>` in as `<name>@dev.local`, verified. Names carry the
// browser and a per-run suffix, so projects running at once and reruns stay apart.
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

test('[adr:in-app-invitation-by-email#2] [adr:in-app-invitation-by-email#5] invites by email, shows it after sign-in, and binds on accepting; no one else sees it', async ({
  browser,
  browserName,
}) => {
  // Three accounts through several pages, as the wishes and anniversaries tests.
  test.setTimeout(60_000);
  const name = (who: string) => `${who}${browserName}${run}inv`;
  const a = await signedIn(browser, name('a'));
  await a.goto('/partner');
  // Typed with a capital, as a phone keyboard would.
  const typed = `${name('b')}@dev.local`.replace(/^b/, 'B');
  await a.getByLabel('TA 的 Google 邮箱').fill(typed);
  await a.getByRole('button', { name: '发出邀请' }).click();
  await expect(a.getByText('已发出邀请')).toBeVisible();
  await expect(
    a.getByText(`已邀请 ${name('b')}@dev.local，等 TA 登录`, { exact: false }),
  ).toBeVisible();

  // Someone else sees nothing, and the ID gets them nothing.
  const c = await signedIn(browser, name('c'));
  await expect(c.getByText(/邀请你一起写日记/)).toHaveCount(0);
  const b = await signedIn(browser, name('b'));
  const banner = b.getByText(`${name('a')} 邀请你一起写日记`);
  await expect(banner).toBeVisible();
  const href = await b.getByRole('link', { name: '查看' }).getAttribute('href');
  await c.goto(href!);
  await expect(c.getByRole('alert')).toHaveText('这份邀请已经不在了');
  await expect(c.getByText(name('a'))).toHaveCount(0);

  await b.getByRole('link', { name: '查看' }).click();
  await expect(b.getByText(`邀请者：${name('a')}`)).toBeVisible();
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  await expect(b.getByRole('heading', { level: 1 })).toHaveText(`与 ${name('a')} 的空间`);
});

test('[adr:in-app-invitation-by-email#7] 不接受 hides it for the recipient only', async ({
  browser,
  browserName,
}) => {
  const name = (who: string) => `${who}${browserName}${run}no`;
  const b = await signedIn(browser, name('b'));
  const a = await signedIn(browser, name('a'));
  await a.goto('/partner');
  await a.getByLabel('TA 的 Google 邮箱').fill(`${name('b')}@dev.local`);
  await a.getByRole('button', { name: '发出邀请' }).click();
  await expect(a.getByText(/等 TA 登录/)).toBeVisible();

  await b.reload();
  await b.getByRole('link', { name: '查看' }).click();
  await b.getByRole('button', { name: '不接受' }).click();
  await expect(b).toHaveURL(/\/$/);
  await expect(b.getByText(/邀请你一起写日记/)).toHaveCount(0);
  await a.reload();
  await expect(a.getByText(/等 TA 登录/)).toBeVisible();
});
