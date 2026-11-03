import { expect, test, type Browser, type Page } from '@playwright/test';

// The diary workspace through the real stack (book-frontend-workspace D3, D6): choosing a
// date in the feed edits it in the left page while the feed keeps its place, back brings
// both again, a deep link opens its date at once, and the narrow window's single pages.
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

test('[adr:book-frontend-workspace#3] a chosen date opens in the left page while the feed keeps its place; back brings both again', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, `ws${browserName}${run}`);
  await createDiaries(page);
  await page.goto('/days');
  await expect(page.getByText('从右页选一天')).toBeVisible();
  await expect(dateIn(page, DATES[14]!)).toBeVisible();

  await scrollFeedTo(page, DATES[4]!);
  const kept = await feedTop(page);
  expect(kept?.scrollTop).toBeGreaterThan(0);

  // The left page edits the chosen date; the feed stays where it was, the date marked.
  await chooseDate(page, DATES[6]!);
  await expect(page).toHaveURL(new RegExp(`/days/${DATES[6]}$`));
  await expect(editor(page)).toBeVisible();
  await expect(dateIn(page, DATES[6]!).getByText('在左页', { exact: true })).toBeVisible();
  await expect(dateIn(page, DATES[6]!).getByText('正在左页编辑')).toBeVisible();
  expect(await feedTop(page)).toEqual(kept);

  await chooseDate(page, DATES[7]!);
  await expect(page).toHaveURL(new RegExp(`/days/${DATES[7]}$`));
  await expect(dateIn(page, DATES[7]!).getByText('在左页', { exact: true })).toBeVisible();
  await expect(dateIn(page, DATES[6]!).getByText('在左页', { exact: true })).toHaveCount(0);
  expect(await feedTop(page)).toEqual(kept);

  // The left page scrolls on its own; the feed does not move with it.
  await page.evaluate(() => {
    document.querySelector('.workspace-left')!.scrollTop = 200;
  });
  expect(await feedTop(page)).toEqual(kept);

  // Read elsewhere in the feed, then back: the previous date, and the feed where it was then.
  await scrollFeedTo(page, DATES[0]!);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/days/${DATES[6]}$`));
  await expect(dateIn(page, DATES[6]!).getByText('在左页', { exact: true })).toBeVisible();
  await expect.poll(() => feedTop(page)).toEqual(kept);
  await page.goBack();
  await expect(page).toHaveURL(/\/days$/);
  await expect(page.getByText('从右页选一天')).toBeVisible();
  await expect.poll(() => feedTop(page)).toEqual(kept);
});

test('[adr:book-frontend-workspace#4] a deep link opens its date in the left page and the feed beside it, newer and older dates still in reach', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, `wd${browserName}${run}`);
  await createDiaries(page);
  await page.goto(`/days/${DATES[9]}`);
  await expect(editor(page)).toBeVisible();
  await expect(dateIn(page, DATES[9]!).getByText('在左页', { exact: true })).toBeVisible();
  await expect.poll(async () => (await feedTop(page))?.date).toBe(DATES[9]);

  // Older dates follow below, newer ones load above.
  await expect(dateIn(page, DATES[14]!)).toBeAttached();
  await feed(page)
    .locator('.day-feed-scroll')
    .evaluate((box) => (box.scrollTop = 0));
  await expect(dateIn(page, DATES[0]!)).toBeAttached({ timeout: 10_000 });

  // A date nobody wrote opens empty and creates nothing.
  await page.goto('/days/2026-08-20');
  await expect(page.getByRole('button', { name: '写这天' })).toBeVisible();
  await expect(dateIn(page, '2026-08-20')).toContainText('这一天没有可以读的日记');
  const day = await page.evaluate(
    async () => ((await (await fetch('/api/days/2026-08-20')).json()) as { day: unknown }).day,
  );
  expect(day).toMatchObject({ mine: null });
});

test('[adr:book-frontend-workspace#6] narrow: the feed and the day are one page each, and back finds the feed where it was', async ({
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
  await expect(page.getByText('从右页选一天')).toHaveCount(0);
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

  await page.getByRole('link', { name: '← 所有日记' }).click();
  await expect(page).toHaveURL(/\/days$/);
  await expect.poll(() => feedTop(page)).toEqual(kept);
  await expect(page.getByLabel('跳到日期')).toBeInViewport();
  await navigationOnScreen();
});
