import { expect, test, type Browser, type Page } from '@playwright/test';

// Anniversaries through the real stack, each person in a browser of their own zone
// (anniversaries D3, partner-local-dates D1, D4): A is at UTC−11, B at UTC+14, so B's today
// is always a day or two ahead of A's. A records B's birthday on B's today; A's home strip
// says it is today on B's side, and a gift B gets is dated on B's side and can be filed
// under that birthday. Names carry the browser and a per-run suffix.
const run = Date.now().toString(36);

// Contexts opened with browser.newContext() outlive the test on the worker's browser, and
// their pages keep polling into every later test; each test closes the ones it opened.
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});
const BEHIND = 'Pacific/Pago_Pago';
const AHEAD = 'Pacific/Kiritimati';

async function signedIn(browser: Browser, name: string, timezoneId: string): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId })).newPage();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

const todayIn = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format();

test('[adr:partner-local-dates#1] [adr:partner-local-dates#5] the partner’s birthday is today on their side, and their gift is dated there', async ({
  browser,
  browserName,
}) => {
  // Two accounts through several pages: 29–31 s on the dev machine (2026-11-08), over the
  // default budget before the invitation moved; 60 s as the wishes test has.
  test.setTimeout(60_000);
  const name = (who: string) => `${who}${browserName}${run}day`;
  const a = await signedIn(browser, name('a'), BEHIND);
  await a.getByRole('link', { name: '邀请搭档' }).click();
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  await a.getByRole('navigation', { name: '主要' }).getByRole('link', { name: '此刻' }).click();
  const b = await signedIn(browser, name('b'), AHEAD);
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  // Opening home reports each browser's zone.
  await b.goto('/');
  await expect(b.getByText(/TA 那边/).first()).toBeVisible();

  await a.goto('/');
  await a.getByRole('navigation', { name: '主要' }).getByRole('button', { name: /^一起/ }).click();
  await a.getByRole('menuitem', { name: /纪念日/ }).click();
  await a.getByRole('button', { name: '记下一天' }).click();
  await a.getByRole('dialog').getByLabel('日期').fill(todayIn(AHEAD));
  await a.getByRole('button', { name: '记下', exact: true }).click();
  await expect(a.getByRole('dialog')).toHaveCount(0);
  await expect(a.locator('li.anniversary')).toContainText(`${name('b')} 的生日`);
  await expect(a.locator('li.anniversary')).toContainText('就是今天 · 按 TA 那边的日期');

  await a.goto('/');
  await expect(a.getByRole('link', { name: '今天是 TA 的生日（按 TA 那边的日期）' })).toBeVisible();
  await expect(a.getByRole('link', { name: '看看 TA 的心愿' })).toBeVisible();

  // A surprise from A reaches B dated on B's side, filed under B's birthday.
  await a.goto('/wishes');
  await a.getByRole('tab', { name: '悄悄准备' }).click();
  await a.getByRole('button', { name: '准备一份惊喜' }).click();
  await a.getByRole('dialog').getByLabel('名称').fill('围巾');
  await a.getByRole('dialog').getByRole('button', { name: '悄悄准备' }).click();
  await a.locator('li.gift.preparing').getByRole('button', { name: '揭晓' }).click();
  await expect(a.locator('li.gift.preparing')).toHaveCount(0);
  await a.getByRole('tab', { name: /礼物墙/ }).click();
  const gift = a.locator('li.gift', { hasText: '围巾' });
  await expect(gift).toContainText(todayIn(AHEAD));
  await gift.getByRole('button', { name: '修改' }).click();
  await gift.getByLabel('场合').selectOption({ label: `${name('b')} 的生日` });
  await expect(gift.getByRole('link', { name: `${name('b')} 的生日` })).toBeVisible();

  await gift.getByRole('link', { name: `${name('b')} 的生日` }).click();
  await expect(a.getByRole('heading', { level: 1 })).toHaveText(`${name('b')} 的生日`);
  await expect(a.getByText(`围巾 · 我送的`)).toBeVisible();
});
