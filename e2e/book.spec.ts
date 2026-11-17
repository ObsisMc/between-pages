import { expect, test, type Browser, type Page } from '@playwright/test';

// Browser acceptance of the diary frontend (book-frontend-workspace 落地顺序 step 4,
// opening-book-home, digital-paper-interface D2): the diary page's layout at a wide and at
// narrow widths, long text, the site header by keyboard, the home and navigation per relationship state, both people writing
// across days, a frozen share, an empty list, failures in the feed, keyboard use of the
// feed, the narrow window's round unread buttons and save state that only the server sets.
// Names carry the browser and a per-run suffix, so projects and reruns stay independent.
// The API runs with HISTORY_IDLE_MS=3000, so "正在写" ends seconds after the last commit.
const run = Date.now().toString(36);

// Contexts opened with browser.newContext() outlive the test on the worker's browser, and
// their pages keep polling into every later test; each test closes the ones it opened.
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

/** Unfolds the range editor on the space page, folded while the range is confirmed. */
async function editRange(page: Page) {
  const fold = page.getByRole('button', { name: '调整共享日期' });
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
}

const WIDE = { width: 1280, height: 800 };
const NARROW = [
  { width: 375, height: 740 },
  { width: 320, height: 640 },
];

async function signedIn(
  browser: Browser,
  name: string,
  viewport: { width: number; height: number } = WIDE,
): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

/** A invites B; B accepts with the default range, so each shares every date with the other. */
async function pair(browser: Browser, prefix: string, viewport = WIDE) {
  const a = await signedIn(browser, `${prefix}a`, viewport);
  await a.getByRole('link', { name: '邀请搭档' }).click();
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  await a.getByRole('navigation', { name: '主要' }).getByRole('link', { name: '此刻' }).click();
  const b = await signedIn(browser, `${prefix}b`, viewport);
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  return { a, b, space: new URL(b.url()).pathname };
}

/** Creates the caller's diaries of `dates` through the API, as "写这天" would. */
const createDiaries = (page: Page, dates: readonly string[]) =>
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

/** `count` dates from `first` on, oldest first. */
const datesFrom = (first: string, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const day = new Date(`${first}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });

const feed = (page: Page) => page.getByRole('region', { name: '所有日记' });
const dateIn = (page: Page, date: string) => feed(page).locator(`[data-date="${date}"]`);
const editor = (page: Page) => page.locator('.diary-editor').getByRole('textbox');
const navigation = (page: Page) => page.getByRole('navigation', { name: '主要' });
const menuButton = (page: Page, name: string) =>
  navigation(page).getByRole('button', { name: new RegExp(`^${name}`) });

/**
 * Opens `path` until the feed shows `text` in `date`: a diary written seconds ago is
 * "正在写" until its history point closes, and the feed reads again on entry.
 */
async function untilRead(page: Page, path: string, date: string, text: string) {
  await expect(async () => {
    await page.goto(path);
    await expect(dateIn(page, date)).toContainText(text, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Writes `text` at the end of the caller's own diary of `date`, and waits for the server. */
async function write(page: Page, date: string, text: string, shared = true) {
  await page.goto(`/days/${date}`);
  const own = page.getByRole('region', { name: '我的日记' }).locator('.diary-editor');
  await own.getByRole('textbox').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
  // A shared diary already says "已同步" before the last keystroke is sent, so the server's
  // own text says when it is in (its excerpt holds these short texts whole).
  await expect
    .poll(
      () =>
        page.evaluate(async (day) => {
          const res = await fetch(`/api/days/${day}`);
          return ((await res.json()) as { day: { mine: { excerpt: string } | null } }).day.mine
            ?.excerpt;
        }, date),
      { timeout: 15_000 },
    )
    .toContain(text);
  await expect(page.locator('.save-status').first()).toHaveText(
    shared ? '已同步 · 对方可以看到' : '已保存到服务器',
    { timeout: 15_000 },
  );
}

/** Pastes `text` into the caller's own diary of `date` in one operation, and waits. */
async function paste(page: Page, date: string, text: string) {
  await page.goto(`/days/${date}`);
  await editor(page).click();
  await editor(page).evaluate((box, pasted) => {
    // Firefox ignores clipboardData in the event's init; the editor reads only getData.
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? pasted : '') },
    });
    box.dispatchEvent(event);
  }, text);
  await expect(page.locator('.save-status')).toHaveText('已保存到服务器', { timeout: 30_000 });
}

/** Long text: many lines, a 400-letter word and a long link, none with a place to break. */
const LONG_WORD = 'a'.repeat(400);
const LONG_TEXT = [
  ...Array.from({ length: 60 }, (_, i) => `第${i + 1}行：今天的风很轻，我们沿着河边走了很久。`),
  LONG_WORD,
  `https://example.com/${'path/'.repeat(60)}end`,
  '最后一行',
].join('\n');

/**
 * What lies outside the box it belongs to: the text and elements of each region of the page
 * (the children of `main`: the date index, the main area) outside that region (by more than
 * a pixel, for rounding), and the window's sideways scroll. Text is measured by its own
 * boxes, so a word running out of its block counts, clipped or not.
 */
const outside = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width) found.push('the window scrolls sideways');
    const check = (what: string, rect: DOMRect, box: { left: number; right: number }) => {
      if (rect.width === 0 && rect.height === 0) return;
      if (rect.left < box.left - 1 || rect.right > box.right + 1)
        found.push(`${what}: ${Math.round(rect.left)}–${Math.round(rect.right)}`);
    };
    for (const sheet of document.querySelectorAll<HTMLElement>('main > *')) {
      const page = sheet.getBoundingClientRect();
      if (page.width === 0) continue;
      const box = { left: Math.max(page.left, 0), right: Math.min(page.right, width) };
      for (const el of sheet.querySelectorAll<HTMLElement>('*'))
        check(
          `<${el.tagName.toLowerCase()} class="${el.className}">`,
          el.getBoundingClientRect(),
          box,
        );
      const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        range.selectNodeContents(node);
        for (const rect of range.getClientRects())
          check(`text "${node.textContent.slice(0, 20)}"`, rect, box);
      }
    }
    return found;
  });

/** Whether the site navigation lies wholly inside the window. */
const navigationOnScreen = async (page: Page) => {
  const box = await navigation(page).boundingBox();
  const { width, height } = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
};

test('[adr:book-frontend-workspace#1] wide: no text or control leaves the index or the main area, nor the window’s foot, long text included', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, `bw${browserName}${run}`);
  const [older, longDay] = ['2026-09-01', '2026-09-02'];
  await createDiaries(page, [older, longDay]);
  await paste(page, longDay, LONG_TEXT);

  for (const path of ['/', '/days', `/days/${longDay}`]) {
    if (path === '/days') await untilRead(page, path, longDay, '最后一行');
    else await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (path !== '/')
      await expect(page.getByRole('navigation', { name: '日期索引' })).toBeVisible();
    if (path === `/days/${longDay}`) await expect(editor(page)).toContainText('最后一行');
    expect(await outside(page), path).toEqual([]);
    await navigationOnScreen(page);
    if (path === '/') continue;
    // The diary page is the window's height: the index and the main area scroll inside it.
    const foot = await page.evaluate(() => ({
      window: document.documentElement.scrollHeight <= window.innerHeight,
      regions: [...document.querySelectorAll('main > *')].every(
        (p) => p.getBoundingClientRect().bottom <= window.innerHeight + 1,
      ),
    }));
    expect(foot, path).toEqual({ window: true, regions: true });
  }

  // The feed shows the long diary whole: its box is as tall as its text, and the list's
  // end is reachable below it.
  await untilRead(page, '/days', longDay, '最后一行');
  const diary = dateIn(page, longDay).locator('.feed-diary');
  await expect(diary).toContainText(LONG_WORD);
  expect(await diary.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await feed(page)
    .locator('.day-feed-scroll')
    .evaluate((box) => (box.scrollTop = box.scrollHeight));
  await expect(feed(page).getByText('已经是最早的一天')).toBeInViewport();
});

for (const viewport of NARROW) {
  test(`[adr:opening-book-home#4] [adr:book-frontend-workspace#1] [adr:book-frontend-workspace#6] ${viewport.width}px: one column with the navigation and the date picker on screen and no sideways scroll`, async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(120_000);
    const page = await signedIn(browser, `bn${viewport.width}${browserName}${run}`, viewport);
    const [older, longDay] = ['2026-09-01', '2026-09-02'];
    await createDiaries(page, [older, longDay]);
    await paste(page, longDay, LONG_TEXT);

    for (const path of ['/', '/days', `/days/${longDay}`]) {
      if (path === '/days') await untilRead(page, path, longDay, '最后一行');
      else await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (path === `/days/${longDay}`) await expect(editor(page)).toContainText('最后一行');
      expect(await outside(page), path).toEqual([]);
      await navigationOnScreen(page);
      if (path !== '/') {
        // The index folded into the date picker opens inside the window.
        await page.getByRole('button', { name: '日期', exact: true }).click();
        const index = page.getByRole('navigation', { name: '日期索引' });
        await expect(index.getByRole('link', { name: /^9 月 2 日/ })).toBeInViewport();
        expect(await outside(page), `${path} picking`).toEqual([]);
        await page.getByRole('button', { name: '日期', exact: true }).click();
        await expect(index).toHaveCount(0);
      }
      // Scrolled to the end of the page, the navigation is still there.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await navigationOnScreen(page);
      expect(await outside(page), `${path} scrolled`).toEqual([]);
    }

    // A menu opens by keyboard inside the window too.
    await page.goto('/');
    await menuButton(page, '设置').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: '备份' })).toBeInViewport();
    expect(await outside(page)).toEqual([]);
    await navigationOnScreen(page);
  });
}

test('[adr:opening-book-home#1] [adr:digital-paper-interface#9] the home shows no diary text; the site header works by keyboard', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  const page = await signedIn(browser, `bk${browserName}${run}`);
  const today = await page.evaluate(async () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await fetch('/api/diaries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timezone }),
    });
    return ((await res.json()) as { diary: { diaryDate: string } }).diary.diaryDate;
  });
  await write(page, today, '只给自己看的一句', false);

  // The home lists the date it was written on, reads no diary and shows no diary text
  // (digital-paper-interface D2, invariant 9).
  const asked: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (/^\/api\/diaries/.test(pathname)) asked.push(pathname);
  });
  await page.goto('/');
  await expect(page.getByRole('link', { name: '继续写今天' })).toBeVisible();
  await expect(page.getByRole('link', { name: '所有日记', exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: '最近的几页' }).getByRole('link', { name: /今天/ }),
  ).toContainText('你写了');
  await expect(page.locator('body')).not.toContainText('只给自己看的一句');
  expect(asked).toEqual([]);

  // Tab reaches the 设置 menu; Enter opens it with the focus inside, Escape closes it.
  let tabs = 0;
  while (!(await menuButton(page, '设置').evaluate((el) => el === document.activeElement))) {
    await page.keyboard.press('Tab');
    expect(++tabs).toBeLessThan(40);
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(menuButton(page, '设置')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.getByRole('menu').evaluate((el) => el.contains(document.activeElement))).toBe(
    true,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(menuButton(page, '设置')).toBeFocused();

  // An entry by keyboard leads on (the first is 搭档, since this account is unbound; the
  // arrow keys move), and the menu holding the page showing is marked current.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: '搭档' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '备份' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/backup$/);
  await expect(menuButton(page, '设置')).toHaveAttribute('aria-current', 'page');
  await navigation(page).getByRole('link', { name: '日记' }).click();
  await expect(page).toHaveURL(/\/days$/);
  await expect(navigation(page).getByRole('link', { name: '日记' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(dateIn(page, today)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/backup$/);
});

test('[adr:opening-book-home#5] [adr:book-frontend-workspace#7] home and navigation per relationship: never bound, bound without a sleep schedule, unbound with history', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(150_000);
  const prefix = `br${browserName}${run}`;
  // The pages the header's menus list, 一起 first when there is one.
  const entries = async (page: Page) => {
    const names: string[] = [];
    for (const menu of ['一起', '设置']) {
      if (!(await menuButton(page, menu).count())) continue;
      await menuButton(page, menu).click();
      await expect(page.getByRole('menu')).toBeVisible();
      names.push(...(await page.getByRole('menuitem').allTextContents()));
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
    return names;
  };

  // Never bound: the own clock, the invitation, and only the diaries and backup.
  const alone = await signedIn(browser, `${prefix}n`);
  await expect(alone.getByRole('heading', { name: '此刻' })).toBeVisible();
  await expect(alone.getByText('TA 那边')).toHaveCount(0);
  await expect(alone.getByText(/共同醒着|按作息推算/)).toHaveCount(0);
  await expect(alone.getByText('还没有搭档')).toBeVisible();
  await expect(alone.getByRole('link', { name: '邀请搭档' })).toBeVisible();
  await expect(alone.getByRole('button', { name: '生成邀请链接' })).toHaveCount(0);
  expect(await entries(alone)).toEqual(['搭档', '备份', '邮件提醒']);

  // Bound, neither has a sleep schedule: both clocks, an entry to set one, no made-up hours.
  const { a, b, space } = await pair(browser, prefix);
  await b.goto('/');
  await expect(b.locator('.clock-face', { hasText: 'TA 那边' })).toBeVisible();
  await a.reload();
  await expect(a.getByRole('heading', { name: '两地时间' })).toBeVisible();
  await expect(a.locator('.clock-face', { hasText: 'TA 那边' })).toBeVisible();
  await expect(a.getByRole('link', { name: '设置作息' })).toBeVisible();
  await expect(a.getByText(/共同醒着/)).toHaveCount(0);
  expect(await entries(a)).toEqual([
    '两地时间',
    '心愿与礼物',
    '纪念日',
    '共享页面',
    '双人空间',
    '备份',
    '邮件提醒',
  ]);

  // A writes a shared diary, then unbinds; B keeps it read-only and nothing of A's later.
  const date = '2026-09-10';
  await createDiaries(a, [date]);
  await write(a, date, '绑定时写的');
  await a.goto(space);
  await a.getByRole('button', { name: '解除绑定' }).click();
  await a.getByRole('button', { name: '确认解除绑定' }).click();
  await expect(a.getByText('已解绑，只能与原搭档恢复')).toBeVisible();
  await write(a, date, '解绑后写的', false);

  for (const page of [a, b]) {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '此刻' })).toBeVisible();
    await expect(page.getByText('TA 那边')).toHaveCount(0);
    await expect(page.getByText(/共同醒着|按作息推算|设置作息/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^与 .+ 的空间（已解绑）$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: '邀请搭档' })).toBeVisible();
    // The archived space and its records stay reachable; the clocks do not.
    expect(await entries(page)).toEqual([
      '心愿与礼物',
      '纪念日',
      '共享页面',
      '双人空间',
      '搭档',
      '备份',
      '邮件提醒',
    ]);
  }
  await untilRead(b, '/days', date, '绑定时写的');
  await expect(dateIn(b, date)).toContainText('已停止共享');
  await expect(dateIn(b, date)).not.toContainText('解绑后写的');
});

test('[adr:book-frontend-workspace#7] both people writing across days read in one feed; a frozen share stays as it was', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const { a, b, space } = await pair(browser, `bx${browserName}${run}`);
  const [d1, d2, d3] = ['2026-09-01', '2026-09-02', '2026-09-03'];
  await createDiaries(a, [d1, d2]);
  await createDiaries(b, [d2, d3]);
  await write(a, d1, 'A一号');
  await write(a, d2, 'A二号');
  await write(b, d2, 'B二号');
  await write(b, d3, 'B三号');

  // Once the history points close, B reads every date in full, newest first, both diaries
  // of the shared date each under its writer's name.
  await untilRead(b, '/days', d3, 'B三号');
  await expect(dateIn(b, d1)).toContainText('A一号');
  await expect(dateIn(b, d2)).toContainText('A二号');
  await expect(dateIn(b, d2)).toContainText('B二号');
  await expect(dateIn(b, d3)).toContainText('B三号');
  await expect(dateIn(b, d2).locator('.feed-diary-who')).toHaveCount(2);
  const order = await feed(b)
    .locator('[data-date]')
    .evaluateAll((all) => all.map((el) => (el as HTMLElement).dataset.date));
  expect(order).toEqual([d3, d2, d1]);

  // A's own feed shows B's shared diaries as well.
  await untilRead(a, '/days', d3, 'B三号');

  // A stops sharing: B keeps what was shared, marked, and never sees what A writes after.
  await a.goto(space);
  await editRange(a);
  await a.getByLabel('自选日期').check();
  await a.getByRole('button', { name: '保存范围' }).click();
  await a.getByRole('button', { name: '确认保存' }).click();
  await expect(a.getByText(/（已为本次绑定确认，正在共享）/)).toBeVisible();
  await write(a, d1, '之后的私话', false);
  await untilRead(b, '/days', d1, 'A一号');
  await expect(dateIn(b, d1)).toContainText('已停止共享');
  await expect(dateIn(b, d2)).toContainText('B二号');
  await expect(feed(b)).not.toContainText('之后的私话');
});

test('[adr:book-frontend-workspace#4] an empty list says so, and a jump to a date nobody wrote creates nothing', async ({
  browser,
  browserName,
}) => {
  const page = await signedIn(browser, `be${browserName}${run}`);
  await page.goto('/days');
  await expect(feed(page).getByText('还没有日记，从今天开始写吧')).toBeVisible();
  await expect(feed(page).getByText('已经是最早的一天')).toHaveCount(0);
  await expect(feed(page).getByRole('button', { name: /一处未读/ })).toHaveCount(0);

  await page.getByLabel('跳到日期').fill('2026-08-20');
  await page.getByRole('button', { name: '跳转' }).click();
  await expect(dateIn(page, '2026-08-20')).toContainText('这一天没有可以读的日记');
  await dateIn(page, '2026-08-20').getByRole('link').first().click();
  await expect(page).toHaveURL(/\/days\/2026-08-20$/);
  await expect(page.getByRole('button', { name: '写这天' })).toBeVisible();
  const days = await page.evaluate(
    async () => ((await (await fetch('/api/days')).json()) as { days: unknown[] }).days,
  );
  expect(days).toEqual([]);
});

test('[adr:book-frontend-workspace#5] the feed says when it cannot read, keeps what it shows, drops an unread mark it cannot confirm, and retries', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(150_000);
  const { a, b } = await pair(browser, `bf${browserName}${run}`);
  // A writes on the oldest of 20 dates; B's 19 empty diaries put it more than a screen
  // below the top of the list, so its dot is the list's, its text not yet read.
  const dates = datesFrom('2026-09-01', 20);
  const [oldest, middle, newest] = [dates[0]!, dates[10]!, dates[19]!];
  await createDiaries(a, [oldest]);
  await write(a, oldest, 'A写给B');
  await createDiaries(b, dates.slice(1));
  const context = b.context();

  // Offline from the start: the failure row and its retry, nothing else claimed.
  await b.goto('/');
  // The home renders after its own requests, which going offline first would fail.
  const allDiaries = b.getByRole('link', { name: '所有日记', exact: true });
  await expect(allDiaries).toBeVisible();
  await context.setOffline(true);
  await allDiaries.click();
  await expect(feed(b).getByRole('alert')).toHaveText('离线时无法读取日记，联网后再试');
  await expect(feed(b).locator('[data-date]')).toHaveCount(0);
  await context.setOffline(false);
  await feed(b).getByRole('button', { name: '重试' }).click();
  await expect(feed(b).getByRole('alert')).toHaveCount(0);
  await expect(dateIn(b, newest)).toBeVisible();

  // The list unread lights once A's history point closes; ↓ leads to it.
  const dot = dateIn(b, oldest).getByLabel('有新内容');
  const down = feed(b).getByRole('button', { name: '下一处未读' });
  await expect(async () => {
    await b.reload();
    await expect(dot).toBeAttached({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(down).toBeVisible();
  await expect(dateIn(b, oldest)).not.toContainText('A写给B');

  // The API failing: shown dates stay and the error says so; the list's unread mark and
  // the ↓ built on it go out, never a "no unread"; the retry brings them back.
  let failing = true;
  await b.route('**/api/days?**', (route) =>
    failing
      ? route.fulfill({
          status: 500,
          json: { error: { code: 'INTERNAL', message: 'Internal error' } },
        })
      : route.fallback(),
  );
  await b.getByLabel('跳到日期').fill(middle);
  await b.getByRole('button', { name: '跳转' }).click();
  await expect(feed(b).getByRole('alert')).toHaveText('日记读取失败，请稍后再试');
  await expect(dateIn(b, newest)).toBeVisible();
  await expect(dot).toHaveCount(0);
  await expect(down).toHaveCount(0);
  await expect(feed(b)).not.toContainText('没有未读');
  failing = false;
  await feed(b).getByRole('button', { name: '重试' }).click();
  await expect(feed(b).getByRole('alert')).toHaveCount(0);
  await expect(dateIn(b, middle)).toBeVisible();
  await expect(dot).toBeAttached();
  await expect(down).toBeVisible();

  // A diary's text failing: that diary says so with its own retry.
  let textFails = true;
  await b.route('**/api/diaries/*/shares/*', (route) =>
    textFails
      ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'x' } } })
      : route.fallback(),
  );
  await b.goto('/days');
  await b.getByLabel('跳到日期').fill(oldest);
  await b.getByRole('button', { name: '跳转' }).click();
  const broken = dateIn(b, oldest);
  await expect(broken.getByRole('alert')).toContainText('这篇暂时无法读取');
  textFails = false;
  await broken.getByRole('button', { name: '重试' }).click();
  await expect(broken).toContainText('A写给B');
});

test('[adr:book-frontend-workspace#3] [adr:book-frontend-workspace#4] the feed and its date jump work by keyboard alone', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  const page = await signedIn(browser, `bj${browserName}${run}`);
  // The first page holds the newest 20; the target is the next one down, so the jump's
  // newer page is all 20 above it and no further page can load in between.
  const dates = datesFrom('2026-07-01', 45);
  await createDiaries(page, dates);
  const target = dates[24]!;
  await page.goto('/days');
  await expect(dateIn(page, dates[44]!)).toBeVisible();
  await expect(dateIn(page, target)).toHaveCount(0);

  // The date index comes first, a link per loaded date, so the bound covers all 45.
  const focusBy = async (locator: ReturnType<Page['locator']>) => {
    let tabs = 0;
    while (!(await locator.evaluate((el) => el === document.activeElement))) {
      await page.keyboard.press('Tab');
      expect(++tabs).toBeLessThan(160);
    }
  };
  // The date input's segments differ by engine; the value is set, the rest is keys.
  await focusBy(page.getByLabel('跳到日期'));
  await page.getByLabel('跳到日期').fill(target);
  await page.keyboard.press('Enter');
  await expect(dateIn(page, target)).toBeVisible();

  // Tab moves on from the jump through the dates above it (two links each) to the date;
  // Enter opens it in the main area, and the index marks it.
  await focusBy(dateIn(page, target).getByRole('link').first());
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/days/${target}$`));
  await expect(
    page.getByRole('navigation', { name: '日期索引' }).locator(`[data-date="${target}"] a`),
  ).toHaveAttribute('aria-current', 'page');

  // Back to the feed; "编辑" by keyboard hands the focus to the day's own diary.
  await page.goBack();
  await expect(page).toHaveURL(/\/days$/);
  await expect(dateIn(page, target)).toBeVisible();
  await focusBy(dateIn(page, dates[23]!).getByRole('link', { name: '编辑' }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/days/${dates[23]}$`));
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('用键盘写');
  await expect(page.locator('.save-status')).toHaveText('已保存到服务器', { timeout: 15_000 });
});

test('[adr:book-frontend-workspace#5] [adr:book-frontend-workspace#6] narrow: the round ↓ and ↑ stay on screen and reach unread dates not loaded', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  const viewport = NARROW[0]!;
  const { a, b } = await pair(browser, `bu${browserName}${run}`, viewport);
  // B's own diaries on 101 dates; A writes on the oldest and the newest only. Jumped to the
  // middle, the feed loads about 20 dates each way, so neither is loaded.
  const dates = datesFrom('2026-04-22', 101);
  const [oldest, middle, newest] = [dates[0]!, dates[50]!, dates[100]!];
  await createDiaries(a, [oldest, newest]);
  await write(a, oldest, 'A的旧日记');
  await write(a, newest, 'A的新日记');
  await createDiaries(b, dates);

  const down = feed(b).getByRole('button', { name: '下一处未读' });
  const up = feed(b).getByRole('button', { name: '上一处未读' });
  const toMiddle = async () => {
    await b.goto('/days');
    await b.getByLabel('跳到日期').fill(middle);
    await b.getByRole('button', { name: '跳转' }).click();
    await expect(dateIn(b, middle)).toBeVisible();
  };
  await expect(async () => {
    await toMiddle();
    await expect(down).toBeVisible({ timeout: 2_000 });
    await expect(up).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 40_000 });
  await expect(dateIn(b, oldest)).toHaveCount(0);
  await expect(dateIn(b, newest)).toHaveCount(0);
  for (const button of [up, down]) {
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
  expect(await outside(b)).toEqual([]);
  await navigationOnScreen(b);

  await down.click();
  await expect(dateIn(b, oldest)).toContainText('A的旧日记');
  await expect(feed(b).locator('.unread-flash')).toHaveText('A的旧日记');
  await expect(feed(b).locator('.unread-flash')).toBeInViewport();
  await expect(dateIn(b, oldest).getByLabel('有新内容')).toHaveCount(0, { timeout: 10_000 });
  await expect(down).toHaveCount(0);

  await up.click();
  await expect(dateIn(b, newest)).toContainText('A的新日记');
  await expect(feed(b).locator('.unread-flash')).toHaveText('A的新日记');
  await expect(feed(b).locator('.unread-flash')).toBeInViewport();
  await expect(dateIn(b, newest).getByLabel('有新内容')).toHaveCount(0, { timeout: 10_000 });
  await expect(up).toHaveCount(0);
  await navigationOnScreen(b);
});

test('[adr:book-frontend-workspace#8] offline, the day says the text waits on this device and the feed claims nothing of it', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  const page = await signedIn(browser, `bo${browserName}${run}`);
  const date = '2026-09-05';
  await createDiaries(page, [date]);
  let online = true;
  const sockets = new Set<{ close: () => Promise<void> }>();
  await page.routeWebSocket(/\/api\/sync$/, (ws) => {
    if (!online) return void ws.close();
    sockets.add(ws);
    ws.connectToServer();
    ws.onClose(() => sockets.delete(ws));
  });
  await write(page, date, '联网时写的', false);
  await expect(page.locator('.share-state')).toHaveText('仅自己可见');

  online = false;
  for (const ws of sockets) await ws.close();
  await page.keyboard.type('断网时写的');
  await expect(page.locator('.save-status')).toHaveText('暂时无法同步，已保存在本机');
  await expect(page.locator('body')).not.toContainText('已保存到服务器');
  // The feed reads only the server: it shows nothing of the text waiting on this device.
  await page.getByRole('link', { name: '连续读' }).click();
  await expect(dateIn(page, date)).toBeVisible();
  await expect(feed(page)).not.toContainText('断网时写的');

  online = true;
  await page.goBack();
  await expect(page.locator('.save-status')).toHaveText('已保存到服务器', { timeout: 30_000 });
  await untilRead(page, '/days', date, '联网时写的断网时写的');
});
