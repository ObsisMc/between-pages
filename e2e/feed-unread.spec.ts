import { expect, test, type Browser, type Page } from '@playwright/test';

// The feed's round unread buttons through the real stack (book-frontend-workspace D5,
// invariant 5): ↓ and ↑ each reach an unread date the feed has not loaded, by
// `GET /api/days/next-unread`, show its passage and leave the left page's editor focused;
// once it is read and nothing is left in a direction, that button goes. The API runs with
// HISTORY_IDLE_MS=3000, so the list's unread closes seconds after the last commit.
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
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

/** A shares every date with B (the invitation default); B shares nothing. */
async function pair(browser: Browser, prefix: string) {
  const a = await signedIn(browser, `${prefix}a`);
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, `${prefix}b`);
  await b.goto(link);
  await b.getByLabel('暂不设置').check();
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  return { a, b };
}

/** Creates the caller's diaries of `dates` through the API, as "写这天" would. */
const createDiaries = (page: Page, dates: string[]) =>
  page.evaluate(async (all) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const date of all) {
      const res = await fetch('/api/diaries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timezone, date }),
      });
      if (!res.ok) throw new Error(`could not create ${date}: ${res.status}`);
    }
  }, dates);

/** `count` dates from `first` on. */
const datesFrom = (first: string, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const day = new Date(`${first}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });

// B's own empty diaries on 101 dates; A writes on the oldest and the newest only. Opened in
// the middle, the feed loads about 20 dates each way, so neither is loaded.
const DATES = datesFrom('2026-04-22', 101);
const [OLDEST, MIDDLE, NEWEST] = [DATES[0]!, DATES[50]!, DATES[100]!];

const feed = (page: Page) => page.getByRole('region', { name: '所有日记' });
const dateIn = (page: Page, date: string) => feed(page).locator(`[data-date="${date}"]`);

/** A writes `text` in their own diary of `date`, and waits until the server has it. */
async function write(a: Page, date: string, text: string) {
  await a.goto(`/days/${date}`);
  await a.locator('.diary-editor').getByRole('textbox').click();
  await a.keyboard.type(text);
  await expect(a.locator('.save-status')).toHaveText('已同步 · 对方可以看到', {
    timeout: 15_000,
  });
}

/** Whether `el`'s top lies inside the feed's box. */
const inFeedBox = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const box = document.querySelector('.day-feed-scroll')!.getBoundingClientRect();
    const el = document.querySelector(`.day-feed-scroll ${sel}`);
    const top = el?.getBoundingClientRect().top;
    return top !== undefined && top >= box.top && top < box.bottom;
  }, selector);

test('[adr:book-frontend-workspace#5] ↓ and ↑ reach unread dates not loaded, keep the editor’s focus, and go when nothing is left', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(150_000);
  const prefix = `fu${browserName}${run}`;
  const { a, b } = await pair(browser, prefix);
  await createDiaries(a, [OLDEST, NEWEST]);
  await write(a, OLDEST, 'A的旧日记');
  await write(a, NEWEST, 'A的新日记');
  await createDiaries(b, DATES);

  const down = feed(b).getByRole('button', { name: '下一处未读' });
  const up = feed(b).getByRole('button', { name: '上一处未读' });
  // The buttons show once A's history points close and the feed looks again.
  await b.goto(`/days/${MIDDLE}`);
  await expect(async () => {
    await b.reload();
    await expect(down).toBeVisible({ timeout: 2_000 });
    await expect(up).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(dateIn(b, OLDEST)).toHaveCount(0);
  await expect(dateIn(b, NEWEST)).toHaveCount(0);

  // B is writing in the left page; the buttons never take that focus.
  const own = b.locator('.workspace-left .diary-editor').getByRole('textbox');
  await own.click();
  await expect(own).toBeFocused();

  await down.click();
  await expect(dateIn(b, OLDEST)).toContainText('A的旧日记');
  await expect(feed(b).locator('.unread-flash')).toHaveText('A的旧日记');
  expect(await inFeedBox(b, '.unread-flash')).toBe(true);
  await expect(own).toBeFocused();
  // Read there after about a second; nothing older is left.
  await expect(dateIn(b, OLDEST).getByLabel('有新内容')).toHaveCount(0, { timeout: 10_000 });
  await expect(down).toHaveCount(0);

  await expect(dateIn(b, NEWEST)).toHaveCount(0);
  await up.click();
  await expect(dateIn(b, NEWEST)).toContainText('A的新日记');
  await expect(feed(b).locator('.unread-flash')).toHaveText('A的新日记');
  expect(await inFeedBox(b, '.unread-flash')).toBe(true);
  await expect(own).toBeFocused();
  await expect(dateIn(b, NEWEST).getByLabel('有新内容')).toHaveCount(0, { timeout: 10_000 });
  await expect(up).toHaveCount(0);
  await expect(down).toHaveCount(0);
});
