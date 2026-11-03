import { expect, test, type Browser, type Page } from '@playwright/test';

// Spaces-and-invitations acceptance R7 through the real stack: independent accounts in their
// own browser contexts, the mock issuer, the API and PostgreSQL. No diary text takes part;
// every screen says each person shares only the dates they confirm. Names carry the test, the
// browser and a per-run suffix, so tests and projects running at once and reruns stay
// independent. Binding, unbinding with an outsider, and restoring are separate tests, and the
// later two sign their accounts in without the login screen: each full load of the dev app
// costs one to four seconds in WebKit under parallel load, and the fifteen loads of the
// combined scenario did not fit one test's budget.
const run = Date.now().toString(36);

// Ray chose 60 s on 2026-11-01 for the combined scenario (19–27 s normally); it still holds
// for each part.
test.describe.configure({ timeout: 60_000 });

// Contexts opened with browser.newContext() outlive the test on the worker's browser, and
// their pages keep polling into every later test; each test closes the ones it opened.
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await devLogin(page, name);
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

/**
 * Signs in through the dev issuer's redirects instead of the login screen, which the first
 * test and auth.spec.ts cover, and opens `path`: one page load instead of three.
 */
async function openSignedIn(browser: Browser, name: string, path: string): Promise<Page> {
  const context = await browser.newContext();
  const start = await context.request.post('/api/auth/sign-in/social', {
    data: { provider: 'dev', callbackURL: '/', disableRedirect: true, loginHint: name },
  });
  const { url } = (await start.json()) as { url: string };
  // Following the issuer back to the callback stores the session cookie in the context.
  expect((await context.request.get(url)).ok()).toBe(true);
  const page = await context.newPage();
  await page.goto(path);
  return page;
}

async function devLogin(page: Page, name: string) {
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
}

/** Generates an invitation from the home page the page is on and returns its link. */
async function inviteLink(page: Page, choose?: (page: Page) => Promise<void>) {
  await choose?.(page);
  await page.getByRole('button', { name: '生成邀请链接' }).click();
  return page.getByLabel('邀请链接').inputValue();
}

/** On the join page: shares 2026-10-05 only and accepts; returns the space's path. */
async function acceptSharingOneDay(page: Page) {
  await page.getByLabel('自选日期').check();
  await page.getByRole('button', { name: '添加共享日期' }).click();
  const day = page.getByRole('group', { name: '共享第 1 段' });
  await day.getByLabel('开始').fill('2026-10-05');
  await day.getByLabel('结束').fill('2026-10-05');
  await page.getByRole('button', { name: '接受邀请' }).click();
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** A keeps the default range, B shares 2026-10-05 only; both end on the space page. */
async function bound(browser: Browser, name: (who: string) => string) {
  const a = await openSignedIn(browser, name('a'), '/');
  const link = await inviteLink(a);
  const b = await openSignedIn(browser, name('b'), link);
  const spaceUrl = await acceptSharingOneDay(b);
  await a.goto(spaceUrl);
  await expect(a.getByText('当前绑定中')).toBeVisible();
  return { a, b, spaceUrl };
}

/** Unbinds alone from the space page, after the second confirmation. */
async function unbind(page: Page) {
  await page.getByRole('button', { name: '解除绑定' }).click();
  await page.getByRole('button', { name: '确认解除绑定' }).click();
  await expect(page.getByText('已解绑，只能与原搭档恢复')).toBeVisible();
}

const ownDatesOnly = (page: Page) =>
  expect(page.getByText('每人只共享自己确认过的日期').first()).toBeVisible();

test('AUTH-02 AUTH-11 SHARE-03 binds a pair through an invitation, each with a private range', async ({
  browser,
  browserName,
}) => {
  const name = (who: string) => `bind${who}${browserName}${run}`;
  const a = await signedIn(browser, name('a'));

  // A keeps the default: all history and later.
  const link = await inviteLink(a);
  expect(link).toMatch(/\/join#token=[A-Za-z0-9_-]{43}$/);
  await ownDatesOnly(a);

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
  await acceptSharingOneDay(b);
  await expect(b.getByText(`与 ${name('a')} 的空间`)).toBeVisible();
  await expect(b.getByText('共享：2026-10-05（已为本次绑定确认，正在共享）')).toBeVisible();
  await ownDatesOnly(b);

  // A sees the space and only A's own range.
  await a.goto('/');
  await a.getByRole('link', { name: `与 ${name('b')} 的空间` }).click();
  await expect(a.getByText('共享：全部历史与以后（已为本次绑定确认，正在共享）')).toBeVisible();
  await expect(a.locator('body')).not.toContainText('2026-10-05');
});

test('AUTH-07 AUTH-08 keeps an outsider out, unbinds alone and keeps the partner fixed', async ({
  browser,
  browserName,
}) => {
  const name = (who: string) => `fixed${who}${browserName}${run}`;
  const { a, b, spaceUrl } = await bound(browser, name);

  // C may not see it.
  const c = await openSignedIn(browser, name('c'), spaceUrl);
  await expect(c.getByRole('alert')).toHaveText('找不到这个空间');

  // A unbinds alone, after a second confirmation; both keep the space and its history.
  await unbind(a);
  await b.reload();
  await expect(b.getByText('已解绑，只能与原搭档恢复')).toBeVisible();
  await expect(b.getByText('共享：2026-10-05')).toBeVisible();

  // The partner stays fixed: A cannot join C.
  await c.getByRole('link', { name: '回到首页' }).click();
  const fromC = await inviteLink(c);
  await a.goto(fromC);
  await expect(a.getByRole('alert')).toHaveText('首版绑定后搭档固定，只能与原搭档恢复关系');
});

test('AUTH-08 AUTH-11 SHARE-03 restores the same space with the former partner without reopening a range', async ({
  browser,
  browserName,
}) => {
  const name = (who: string) => `restore${who}${browserName}${run}`;
  const { a, b, spaceUrl } = await bound(browser, name);
  await unbind(a);

  // B invites A again without setting a range; A restores the same space without one.
  await b.getByRole('link', { name: '← 首页' }).click();
  const again = await inviteLink(b, (page) => page.getByLabel('暂不设置').check());
  await a.goto(again);
  await expect(a.getByText(`接受后恢复你和 ${name('b')} 原来的双人空间。`)).toBeVisible();
  await a.getByLabel('暂不设置').check();
  await a.getByRole('button', { name: '接受邀请' }).click();
  await expect(a).toHaveURL(new RegExp(`${spaceUrl}$`));
  await expect(a.getByText('当前绑定中')).toBeVisible();
  await expect(a.locator('.periods li')).toHaveCount(2);
  await expect(
    a.getByText('共享：全部历史与以后（尚未为本次绑定确认，日记没有共享；之前的设置仅供参考）'),
  ).toBeVisible();
});
