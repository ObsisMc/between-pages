import { expect, test, type Browser, type Page } from '@playwright/test';

// Wishes and gifts through the real stack (wishes-and-gifts acceptance, space-records D8):
// A wishes, B sees it as new and the entry dot goes out once B has seen it; B prepares a
// gift and writes a card, which A cannot notice; B reveals it and A finds gift and card on
// the wall. Names carry the browser and a per-run suffix, so projects and reruns stay apart.
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

/** The space features are listed under 「一起」 in the site header (digital-paper-interface D1). */
const together = (page: Page) =>
  page.getByRole('navigation', { name: '主要' }).getByRole('button', { name: /^一起/ });

async function openContents(page: Page) {
  await expect(together(page)).toBeVisible();
  if ((await together(page).getAttribute('aria-expanded')) !== 'true') await together(page).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

const entry = (page: Page) => page.getByRole('menuitem', { name: /心愿与礼物/ });
const entryDot = (page: Page) => entry(page).getByRole('img', { name: '有新内容' });

test('[adr:wishes-and-gifts#2] [adr:wishes-and-gifts#4] [adr:wishes-and-gifts#5] a surprise stays hidden until it is revealed with its card', async ({
  browser,
  browserName,
}) => {
  // Two or three accounts through a dozen pages: 19–27 s normally (2026-11-01, Ray chose 60 s).
  test.setTimeout(60_000);
  const name = (who: string) => `${who}${browserName}${run}wish`;
  const a = await signedIn(browser, name('a'));
  // Without a space the header has no 「一起」, so nothing lists the space features.
  await expect(a.getByRole('link', { name: '邀请搭档' })).toBeVisible();
  await expect(
    a.getByRole('navigation', { name: '主要' }).getByRole('button', { name: /^设置/ }),
  ).toBeVisible();
  await expect(together(a)).toHaveCount(0);
  await a.keyboard.press('Escape');
  await a.getByRole('link', { name: '邀请搭档' }).click();
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  await a.getByRole('navigation', { name: '主要' }).getByRole('link', { name: '此刻' }).click();
  const b = await signedIn(browser, name('b'));
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);

  await a.goto('/wishes');
  await a.getByRole('button', { name: '许个愿' }).click();
  const form = a.getByRole('dialog', { name: '许个愿' });
  await form.getByLabel('名称').fill('灰色围巾');
  await form.getByLabel('备注').fill('要羊毛的');
  await form.getByRole('button', { name: '4 颗心' }).click();
  await form.getByRole('button', { name: '许个愿' }).click();
  // Sent: the dialog closes on the caller's own list.
  await expect(a.getByRole('tab', { name: '我的心愿', selected: true })).toBeVisible();
  await expect(a.getByText('灰色围巾')).toBeVisible();

  // [adr:space-records#9] B's entry lights, the wish is new, and seeing it puts the dot out.
  await b.goto('/');
  await openContents(b);
  await expect(entryDot(b)).toBeVisible();
  // Seen once on screen for about a second (SEEN_DWELL_MS): B stays until the server has it.
  const seen = b.waitForResponse((r) => r.url().endsWith('/api/space/seen') && r.ok());
  await entry(b).click();
  const wish = b.locator('li.wish', { hasText: '灰色围巾' });
  await expect(wish.getByText('新')).toBeVisible();
  await seen;
  await b.goto('/');
  await openContents(b);
  await expect(entryDot(b)).toHaveCount(0);

  await b.goto('/wishes');
  await a.reload();
  await a.getByRole('tab', { name: '我的心愿' }).click();
  await expect(a.getByText('灰色围巾')).toBeVisible();
  // Every tab is in the page, hidden or not, so its text covers all four lists.
  const before = await a.locator('main').textContent();
  await wish.getByRole('button', { name: '我在准备' }).click();
  await expect(wish.getByText('你在准备')).toBeVisible();
  await wish.getByRole('button', { name: '写卡片、揭晓' }).click();
  await expect(b.getByRole('tab', { name: '悄悄准备', selected: true })).toBeVisible();
  const preparing = b.locator('li.gift.preparing', { hasText: '灰色围巾' });
  await preparing.getByRole('button', { name: '写卡片' }).click();
  await preparing.getByLabel('卡片').fill('冬天快乐');
  await preparing.getByRole('button', { name: '保存卡片' }).click();
  await expect(preparing.getByText('冬天快乐')).toBeVisible();

  // [adr:wishes-and-gifts#2] A's page and entry are exactly as before.
  await a.reload();
  await a.getByRole('tab', { name: '我的心愿' }).click();
  await expect(a.getByText('灰色围巾')).toBeVisible();
  expect(await a.locator('main').textContent()).toBe(before);
  await a.goto('/');
  await openContents(a);
  await expect(entryDot(a)).toHaveCount(0);

  await preparing.getByRole('button', { name: '揭晓' }).click();
  await expect(b.locator('li.gift.preparing')).toHaveCount(0);

  await a.goto('/');
  await openContents(a);
  await expect(entryDot(a)).toBeVisible();
  await entry(a).click();
  await a.getByRole('tab', { name: /礼物墙/ }).click();
  const gift = a.locator('li.gift', { hasText: '灰色围巾' });
  await expect(gift.getByText(`${name('b')} 送给我`)).toBeVisible();
  await expect(gift.getByText('冬天快乐')).toBeVisible();
  // The wish left A's list for the wall.
  await expect(a.locator('li.wish')).toHaveCount(0);
});
