import { expect, test, type Browser, type Page } from '@playwright/test';

// Two clocks through the real stack (two-clocks acceptance): each person's browser reports
// its own zone, and the partner's home strip follows it after they travel. Names carry the
// browser and a per-run suffix, so projects running at once and reruns stay independent.
const run = Date.now().toString(36);

async function devLogin(page: Page, name: string) {
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
}

async function signedIn(browser: Browser, name: string, timezoneId: string): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId })).newPage();
  await page.goto('/login');
  await devLogin(page, name);
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

test('[adr:two-clocks#2] shows the partner the zone their browser reports, and follows a trip', async ({
  browser,
  browserName,
}) => {
  const name = (who: string) => `${who}${browserName}${run}clock`;
  const a = await signedIn(browser, name('a'), 'America/Los_Angeles');
  await expect(a.getByText(/TA 那边/)).toHaveCount(0);

  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, name('b'), 'Asia/Tokyo');
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  await b.goto('/');
  await expect(b.getByText(/TA 那边 .* · 北美太平洋时间/)).toBeVisible();

  await a.reload();
  await expect(a.getByText(/TA 那边 .* · 日本标准时间/)).toBeVisible();

  // B travels to London: the same account in a browser set to London time.
  const away = await signedIn(browser, name('b'), 'Europe/London');
  await expect(away.getByText(/TA 那边 .* · 北美太平洋时间/)).toBeVisible();
  await a.reload();
  await expect(a.getByText(/TA 那边 .* · 英国时间/)).toBeVisible();
});
