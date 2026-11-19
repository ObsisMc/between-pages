import { expect, test, type Browser, type Page } from '@playwright/test';

// The diary page through the real stack (digital-paper-interface D2, invariant 10;
// book-frontend-workspace D3, D6): the date index beside one main area, where a date chosen
// in the feed or the index replaces the feed and going back finds the feed where it was; a
// deep link opens its date at once; the narrow window folds the index into a date picker.
const run = Date.now().toString(36);

// Contexts opened with browser.newContext() outlive the test on the worker's browser, and
// their pages keep polling into every later test; each test closes the ones it opened.
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

async function signedIn(
  browser: Browser,
  name: string,
  viewport?: { width: number; height: number },
) {
  const page = await (await browser.newContext(viewport ? { viewport } : {})).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

/** Fifteen past dates of the caller's own diary, newest 2026-09-15, oldest 2026-09-01. */
const DATES = Array.from({ length: 15 }, (_, i) => `2026-09-${String(15 - i).padStart(2, '0')}`);

/** Creates the caller's diaries of `DATES` through the API, as "写这天" would. */
const createDiaries = (page: Page) =>
  page.evaluate(async (dates) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const date of dates) {
      const res = await fetch('/api/diaries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timezone, date }),
      });
      if (!res.ok) throw new Error(`could not create ${date}: ${res.status}`);
    }
  }, DATES);

const feed = (page: Page) => page.getByRole('region', { name: '所有日记' });
// The diary editors; the feed's date jump is a textbox too.
const editor = (page: Page) => page.locator('.diary-editor').getByRole('textbox');
const dateIn = (page: Page, date: string) => feed(page).locator(`[data-date="${date}"]`);

/** Which date is at the top of the feed's box, how far below its top, and the box's scroll. */
const feedTop = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('.day-feed-scroll')!;
    const top = box.getBoundingClientRect().top;
    const first = [...box.querySelectorAll<HTMLElement>('[data-date]')].find(
      // A pixel's slack: engines round the boundary differently.
      (el) => el.getBoundingClientRect().bottom > top + 1,
    );
    // Not laid out yet: nothing at the top to tell.
    if (!first) return null;
    return {
      date: first.dataset.date,
      offset: Math.round(first.getBoundingClientRect().top - top),
      scrollTop: Math.round(box.scrollTop),
    };
  });

/** Scrolls the feed so `date` is at its top, and waits for the feed to report its place. */
async function scrollFeedTo(page: Page, date: string) {
  await page.evaluate((day) => {
    const box = document.querySelector<HTMLElement>('.day-feed-scroll')!;
    const section = box.querySelector<HTMLElement>(`[data-date="${day}"]`)!;
    // Two pixels into the date, so a fraction of the one above never counts as on top.
    box.scrollTop += section.getBoundingClientRect().top - box.getBoundingClientRect().top + 2;
  }, date);
  await expect.poll(async () => (await feedTop(page))?.date).toBe(date);
  // The position reaches the history entry once the list has rested (POSITION_MS, 0.4 s).
  await expect
    .poll(() =>
      page.evaluate(() => (history.state as { usr?: { feed?: { date: string } } }).usr?.feed?.date),
    )
    .toBe(date);
}

const chooseDate = (page: Page, date: string) =>
  dateIn(page, date).getByRole('link').first().click();
const dateIndex = (page: Page) => page.getByRole('navigation', { name: '日期索引' });
const indexRow = (page: Page, date: string) => dateIndex(page).locator(`[data-date="${date}"]`);

test('[adr:digital-paper-interface#10] a date opens in the one main area, and the feed comes back where it was', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, `ws${browserName}${run}`);
  await createDiaries(page);
  await page.goto('/days');
  await expect(dateIn(page, DATES[14]!)).toBeVisible();
  await expect(indexRow(page, DATES[0]!)).toBeVisible();

  await scrollFeedTo(page, DATES[4]!);
  const kept = await feedTop(page);
  expect(kept?.scrollTop).toBeGreaterThan(0);

  // From the feed: the day takes the main area, the index marks it, the address holds no place.
  await chooseDate(page, DATES[6]!);
  await expect(page).toHaveURL(new RegExp(`/days/${DATES[6]}$`));
  await expect(editor(page)).toBeVisible();
  await expect(feed(page)).toHaveCount(0);
  await expect(indexRow(page, DATES[6]!).getByRole('link')).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: '连续读' }).click();
  await expect(page).toHaveURL(/\/days$/);
  await expect.poll(() => feedTop(page)).toEqual(kept);

  // From the index, and the browser's back.
  await indexRow(page, DATES[8]!).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/days/${DATES[8]}$`));
  await expect(editor(page)).toBeVisible();
  // The day scrolls inside the main area; the index stays beside it.
  await page.getByRole('heading', { level: 1 }).evaluate((h) => {
    h.closest<HTMLElement>('.day-scroll')!.scrollTop = 200;
  });
  await expect(indexRow(page, DATES[8]!)).toBeInViewport();
  await page.goBack();
  await expect(page).toHaveURL(/\/days$/);
  await expect.poll(() => feedTop(page)).toEqual(kept);

  // "这一天" opens the date the feed is read at, and 连续读 returns.
  await page.getByRole('link', { name: '这一天' }).click();
  await expect(page).toHaveURL(new RegExp(`/days/${DATES[4]}$`));
  await expect(editor(page)).toBeVisible();
  await page.getByRole('link', { name: '连续读' }).click();
  await expect(page).toHaveURL(/\/days$/);
  await expect.poll(() => feedTop(page)).toEqual(kept);
});

test('[adr:book-frontend-workspace#4] a deep link opens its date at once with the index around it, newer and older dates still in reach', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, `wd${browserName}${run}`);
  await createDiaries(page);
  await page.goto(`/days/${DATES[9]}`);
  await expect(editor(page)).toBeVisible();
  await expect(indexRow(page, DATES[9]!).getByRole('link')).toHaveAttribute('aria-current', 'page');
  await expect(indexRow(page, DATES[9]!)).toBeInViewport();

  // Older dates follow below, newer ones load above.
  await expect(indexRow(page, DATES[14]!)).toBeAttached();
  await dateIndex(page)
    .locator('[data-date]')
    .first()
    .evaluate((row) => row.closest('nav > div')!.scrollTo(0, 0));
  await expect(indexRow(page, DATES[0]!)).toBeAttached({ timeout: 10_000 });

  // A date nobody wrote opens empty and creates nothing.
  await page.goto('/days/2026-08-20');
  await expect(page.getByRole('button', { name: '写这天' })).toBeVisible();
  await expect(indexRow(page, '2026-08-20')).toContainText('没有可以读的日记');
  const day = await page.evaluate(
    async () => ((await (await fetch('/api/days/2026-08-20')).json()) as { day: unknown }).day,
  );
  expect(day).toMatchObject({ mine: null });
});

test('[adr:book-frontend-workspace#6] narrow: the index folds into a date picker, the feed and the day are one page each, and back finds the feed where it was', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, `wn${browserName}${run}`, { width: 375, height: 740 });
  await createDiaries(page);
  const noSidewaysScroll = () =>
    expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  const navigationOnScreen = async () => {
    const box = (await page.getByRole('navigation', { name: '主要' }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + box.height).toBeLessThanOrEqual(740);
  };

  await page.goto('/days');
  await expect(dateIn(page, DATES[14]!)).toBeAttached();
  await expect(dateIndex(page)).toHaveCount(0);
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByLabel('跳到日期')).toBeInViewport();
  await navigationOnScreen();
  await noSidewaysScroll();
  await scrollFeedTo(page, DATES[5]!);
  const kept = await feedTop(page);

  // "编辑" opens the date alone, its diary taking the focus.
  await dateIn(page, DATES[7]!).getByRole('link', { name: '编辑' }).click();
  await expect(page).toHaveURL(new RegExp(`/days/${DATES[7]}$`));
  await expect(editor(page)).toBeFocused();
  await expect(feed(page)).toHaveCount(0);
  await navigationOnScreen();
  await noSidewaysScroll();

  await page.getByRole('link', { name: '连续读' }).click();
  await expect(page).toHaveURL(/\/days$/);
  await expect.poll(() => feedTop(page)).toEqual(kept);
  await expect(page.getByLabel('跳到日期')).toBeInViewport();

  // The date picker: the index opens over the feed, and choosing a date closes it.
  await page.getByRole('button', { name: '日期', exact: true }).click();
  await indexRow(page, DATES[9]!).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/days/${DATES[9]}$`));
  await expect(dateIndex(page)).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
  await noSidewaysScroll();
  await page.goBack();
  await expect(page).toHaveURL(/\/days$/);
  await expect.poll(() => feedTop(page)).toEqual(kept);
  await navigationOnScreen();
});

test('DATE-06 [adr:book-frontend-workspace#4] 补写… opens a past day for writing, and the feed’s jump offers 写这天 without creating anything', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, `wb${browserName}${run}`);
  await page.goto('/days');
  // Yesterday and tomorrow in the device's zone, as the calendar's days.
  const [yesterday, today, tomorrow] = await page.evaluate(() =>
    [-1, 0, 1].map((shift) => {
      const at = new Date();
      at.setDate(at.getDate() + shift);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    }),
  );
  const calendar = page.getByRole('dialog', { name: '补写哪一天' });
  const dayButton = (day: string) => calendar.locator(`[data-day="${day}"]`).getByRole('button');

  // Two steps: "补写…", then the day.
  await page.getByRole('button', { name: '补写…' }).click();
  await expect(calendar).toBeVisible();
  if (tomorrow!.slice(0, 7) === today!.slice(0, 7))
    await expect(dayButton(tomorrow!)).toBeDisabled();
  if (yesterday!.slice(0, 7) !== today!.slice(0, 7))
    await calendar.getByRole('button', { name: '上个月' }).click();
  await dayButton(yesterday!).click();
  await expect(page).toHaveURL(new RegExp(`/days/${yesterday}$`));
  await expect(calendar).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('补写昨天');
  await expect(page.locator('.save-status')).toHaveText('已保存到服务器', { timeout: 15_000 });
  await expect(editor(page)).toContainText('补写昨天');

  // The feed's jump to a day without the own diary creates nothing; its 写这天 does.
  await page.getByRole('link', { name: '连续读' }).click();
  await page.getByLabel('跳到日期').fill('2026-08-20');
  await page.getByRole('button', { name: '跳转' }).click();
  const jumped = dateIn(page, '2026-08-20');
  await expect(jumped).toContainText('这一天没有可以读的日记');
  const mineOn = () =>
    page.evaluate(
      async () =>
        ((await (await fetch('/api/days/2026-08-20')).json()) as { day: { mine: unknown } }).day
          .mine,
    );
  expect(await mineOn()).toBeNull();
  await jumped.getByRole('button', { name: '写这天' }).click();
  await expect(page).toHaveURL(/\/days\/2026-08-20$/);
  await expect(editor(page)).toBeFocused();
  expect(await mineOn()).not.toBeNull();
});
