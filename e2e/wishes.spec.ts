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
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

/** The space features are listed in the 「目录」 (book-frontend-workspace D2). */
async function openContents(page: Page) {
  const bookmark = page.getByRole('button', { name: '目录', exact: true });
  // Going to the same address keeps the history state, so the contents may still be open.
  if ((await bookmark.getAttribute('aria-expanded')) !== 'true') await bookmark.click();
  await expect(page.getByRole('dialog', { name: '目录' })).toBeVisible();
}

const entry = (page: Page) => page.getByRole('link', { name: /心愿与礼物/ });
const entryDot = (page: Page) => entry(page).getByRole('img', { name: '有新内容' });

test('[adr:wishes-and-gifts#2] [adr:wishes-and-gifts#4] [adr:wishes-and-gifts#5] a surprise stays hidden until it is revealed with its card', async ({
  browser,
  browserName,
}) => {
  const name = (who: string) => `${who}${browserName}${run}wish`;
  const a = await signedIn(browser, name('a'));
  // Never bound: no space features at all.
  await openContents(a);
  await expect(entry(a)).toHaveCount(0);
  await a.keyboard.press('Escape');
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, name('b'));
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);

  await a.goto('/wishes');
  await a.getByLabel('名称').first().fill('灰色围巾');
  await a.getByLabel('备注').fill('要羊毛的');
  await a.getByRole('button', { name: '4 颗心' }).click();
  await a.getByRole('button', { name: '许个愿' }).click();
  await expect(a.getByText('灰色围巾')).toBeVisible();

  // [adr:space-records#9] B's entry lights, the wish is new, and seeing it puts the dot out.
  await b.goto('/');
  await openContents(b);
  await expect(entryDot(b)).toBeVisible();
  await entry(b).click();
  const wish = b.locator('li.wish', { hasText: '灰色围巾' });
  await expect(wish.getByText('新')).toBeVisible();
  await b.goto('/');
  await openContents(b);
  await expect(entryDot(b)).toHaveCount(0);

  await b.goto('/wishes');
  await a.reload();
  await expect(a.getByText('灰色围巾')).toBeVisible();
  const before = await a.locator('main').innerText();
  await wish.getByRole('button', { name: '我在准备' }).click();
  await expect(wish.getByText('你在准备')).toBeVisible();
  const preparing = b.locator('li.gift.preparing', { hasText: '灰色围巾' });
  await preparing.getByRole('button', { name: '写卡片' }).click();
  await preparing.getByLabel('卡片').fill('冬天快乐');
  await preparing.getByRole('button', { name: '保存卡片' }).click();
  await expect(preparing.getByText('冬天快乐')).toBeVisible();

  // [adr:wishes-and-gifts#2] A's page and entry are exactly as before.
  await a.reload();
  await expect(a.getByText('灰色围巾')).toBeVisible();
  expect(await a.locator('main').innerText()).toBe(before);
  await a.goto('/');
  await openContents(a);
  await expect(entryDot(a)).toHaveCount(0);

  await preparing.getByRole('button', { name: '揭晓' }).click();
  await expect(b.locator('li.gift.preparing')).toHaveCount(0);

  await a.goto('/');
  await openContents(a);
  await expect(entryDot(a)).toBeVisible();
  await entry(a).click();
  const gift = a.locator('li.gift', { hasText: '灰色围巾' });
  await expect(gift.getByText(`${name('b')} 送给我`)).toBeVisible();
  await expect(gift.getByText('冬天快乐')).toBeVisible();
  // The wish left A's list for the wall.
  await expect(a.locator('li.wish')).toHaveCount(0);
});
