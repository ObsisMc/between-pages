import { expect, test, type Browser, type Page } from '@playwright/test';

// Browser acceptance of the book frontend (book-frontend-workspace 落地顺序 step 4,
// opening-book-home, book-surface, contents-spread): the book's layout at a wide and at
// narrow widths on every page, long text, the 「目录」 by keyboard and what it keeps of the
// page below, the home and contents per relationship state, both people writing
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
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

/** A invites B; B accepts with the default range, so each shares every date with the other. */
async function pair(browser: Browser, prefix: string, viewport = WIDE) {
  const a = await signedIn(browser, `${prefix}a`, viewport);
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
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
const bookmark = (page: Page) => page.getByRole('button', { name: '目录', exact: true });
const contents = (page: Page) => page.getByRole('main', { name: '目录' });

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
  const own = page.locator('.workspace-left .diary-editor, .narrow-day .diary-editor').first();
  await own.getByRole('textbox').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
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
 * What lies outside the box it belongs to: each `.book-page`'s text and elements outside
 * that page (by more than a pixel, for rounding), and the window's sideways scroll. Text is
 * measured by its own boxes, so a word running out of its block counts, clipped or not.
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
    for (const sheet of document.querySelectorAll<HTMLElement>('.book-page')) {
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

/** Whether the bookmark lies wholly inside the window. */
const bookmarkOnScreen = async (page: Page) => {
  const box = await bookmark(page).boundingBox();
  const { width, height } = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
};

/**
 * Whether the bookmark is drawn on the book being shown: inside that book's element and
 * its box. With the contents open, that is the contents' book; the page below is hidden.
 */
const bookmarkOnBook = async (page: Page) => {
  const placed = await bookmark(page).evaluate((mark) => {
    const shown = [...document.querySelectorAll('.book')].filter((book) =>
      book.checkVisibility({ visibilityProperty: true }),
    );
    const book = mark.closest('.book');
    const [b, m] = [book?.getBoundingClientRect(), mark.getBoundingClientRect()];
    return {
      books: shown.length,
      onShownBook: !!book && shown.includes(book),
      inside:
        !!b &&
        m.left >= b.left - 1 &&
        m.right <= b.right + 1 &&
        m.top >= b.top - 1 &&
        m.bottom <= b.bottom + 1,
    };
  });
  expect(placed).toEqual({ books: 1, onShownBook: true, inside: true });
};

/**
 * Records, from the first frame on, whether a bookmark was ever on the page outside a book
 * (`window.strayBookmark`).
 */
const watchBookmark = (page: Page) =>
  page.addInitScript(() => {
    const seen = window as unknown as { strayBookmark: boolean };
    seen.strayBookmark = false;
    new MutationObserver(() => {
      for (const mark of document.querySelectorAll('.bookmark'))
        if (!mark.closest('.book')) seen.strayBookmark = true;
    }).observe(document, { childList: true, subtree: true });
  });
const strayBookmark = (page: Page) =>
  page.evaluate(() => (window as unknown as { strayBookmark: boolean }).strayBookmark);

/** Holds every request matching `url` until the returned function is called, then lets them pass. */
async function hold(page: Page, url: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(url, async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

const PAPER = 'rgb(248, 242, 232)';

test('[adr:book-frontend-workspace#1] [adr:book-surface#1] [adr:book-surface#3] wide: no text or control crosses the gutter or the foot of the book, long text included', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, `bw${browserName}${run}`);
  const [older, longDay] = ['2026-09-01', '2026-09-02'];
  await createDiaries(page, [older, longDay]);
  await paste(page, longDay, LONG_TEXT);

  for (const path of ['/', '/days', `/days/${longDay}`, '/clocks', '/backup', 'contents']) {
    if (path === '/days') await untilRead(page, path, longDay, '最后一行');
    else if (path === 'contents') await bookmark(page).click();
    else await page.goto(path);
    // With the contents open, the page below is there but hidden.
    await expect(
      path === 'contents' ? contents(page) : page.locator('.book-page').first(),
    ).toBeVisible();
    if (path.startsWith('/days'))
      await expect(editor(page).or(page.getByText('从右页选一天'))).toBeVisible();
    if (path === `/days/${longDay}`) await expect(editor(page)).toContainText('最后一行');
    if (path === '/clocks')
      await expect(page.getByRole('heading', { name: '两地时间' })).toBeVisible();
    if (path === '/backup') await expect(page.getByRole('heading', { name: '备份' })).toBeVisible();
    if (path === 'contents') await expect(contents(page)).toBeVisible();
    expect(await outside(page), path).toEqual([]);
    await bookmarkOnScreen(page);
    await bookmarkOnBook(page);
    if (path === '/') continue;
    // Every book but the home is the window's height: the pages scroll inside, never past
    // the book.
    const foot = await page.evaluate(() => ({
      window: document.documentElement.scrollHeight <= window.innerHeight,
      pages: [...document.querySelectorAll('.book-page')].every(
        (p) => p.getBoundingClientRect().bottom <= window.innerHeight,
      ),
    }));
    expect(foot, path).toEqual({ window: true, pages: true });
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
  test(`[adr:opening-book-home#4] [adr:book-frontend-workspace#1] [adr:book-frontend-workspace#6] [adr:book-surface#3] [adr:contents-spread#5] ${viewport.width}px: one sheet with the bookmark on screen and no sideways scroll`, async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(120_000);
    const page = await signedIn(browser, `bn${viewport.width}${browserName}${run}`, viewport);
    const [older, longDay] = ['2026-09-01', '2026-09-02'];
    await createDiaries(page, [older, longDay]);
    await paste(page, longDay, LONG_TEXT);

    for (const path of ['/', '/days', `/days/${longDay}`, '/clocks', '/backup']) {
      if (path === '/days') await untilRead(page, path, longDay, '最后一行');
      else await page.goto(path);
      await expect(page.locator('.book-page').first()).toBeVisible();
      if (path === `/days/${longDay}`) await expect(editor(page)).toContainText('最后一行');
      expect(await outside(page), path).toEqual([]);
      await bookmarkOnScreen(page);
      await bookmarkOnBook(page);
      // Down the sheet and at its end, the bookmark is still on screen, on the sheet.
      for (const at of [0.5, 1]) {
        await page.evaluate(
          (share) => window.scrollTo(0, document.documentElement.scrollHeight * share),
          at,
        );
        await bookmarkOnScreen(page);
        await bookmarkOnBook(page);
      }
      expect(await outside(page), `${path} scrolled`).toEqual([]);
    }

    // The bookmark opens by keyboard; the contents is one page inside the window too.
    await page.goto('/');
    await bookmark(page).focus();
    await page.keyboard.press('Enter');
    await expect(contents(page)).toBeVisible();
    expect(await outside(page)).toEqual([]);
    await bookmarkOnScreen(page);
    await bookmarkOnBook(page);
    await contents(page).evaluate((box) => (box.scrollTop = box.scrollHeight));
    await bookmarkOnScreen(page);
    await bookmarkOnBook(page);
    await expect(contents(page).getByRole('link', { name: /所有日记/ })).toBeInViewport();
  });
}

test('[adr:opening-book-home#1] [adr:book-frontend-workspace#2] [adr:book-surface#2] [adr:contents-spread#2] [adr:contents-spread#3] the home shows no diary text; the 目录 opens over it, keeps Tab off the page below and closes by keyboard and back', async ({
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

  // The home asks for no diary and shows no diary text.
  const asked: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (/^\/api\/(days|diaries)/.test(pathname)) asked.push(pathname);
  });
  await page.goto('/');
  await expect(page.getByRole('link', { name: '打开今天的日记' })).toBeVisible();
  await expect(page.getByRole('link', { name: '浏览所有日记' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('只给自己看的一句');
  expect(asked).toEqual([]);

  // Tab reaches the bookmark; Enter opens the contents, a page and not a dialog, with the
  // focus on its title.
  let tabs = 0;
  while (!(await bookmark(page).evaluate((el) => el === document.activeElement))) {
    await page.keyboard.press('Tab');
    expect(++tabs).toBeLessThan(40);
  }
  await page.keyboard.press('Enter');
  await expect(contents(page)).toBeVisible();
  await expect(bookmark(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(contents(page).getByRole('heading', { name: '目录' })).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '浏览所有日记' })).toBeHidden();
  await expect(contents(page).getByRole('link', { name: /今天的日记/ })).toBeVisible();
  await expect(contents(page).getByRole('link', { name: /所有日记/ })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('只给自己看的一句');

  // Tab goes through the contents and the bookmark, never into the home below it.
  const count = await contents(page).locator('a[href], button').count();
  for (let i = 0; i <= count; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => !document.activeElement?.closest('.contents-origin')),
      `Tab ${i + 1}`,
    ).toBe(true);
  }

  // Escape closes it where it was opened, the focus back on the bookmark.
  await page.keyboard.press('Escape');
  await expect(contents(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(bookmark(page)).toBeFocused();

  // The browser's back closes it too, without leaving the page.
  await page.keyboard.press('Enter');
  await expect(contents(page)).toBeVisible();
  await page.goBack();
  await expect(contents(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: '浏览所有日记' })).toBeVisible();

  // An entry by keyboard leads on; back returns to the page it was opened on, closed.
  await bookmark(page).focus();
  await page.keyboard.press('Enter');
  await contents(page)
    .getByRole('link', { name: /所有日记/ })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/days$/);
  await expect(contents(page)).toHaveCount(0);
  await expect(dateIn(page, today)).toBeVisible();
  // The page showing is marked current in the contents.
  await bookmark(page).click();
  await expect(contents(page).getByRole('link', { name: /所有日记/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.keyboard.press('Escape');
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(contents(page)).toHaveCount(0);
});

test('[adr:book-fit-and-bookmark#1] [adr:book-fit-and-bookmark#2] the home book fits the window, and the bookmark is drawn on the book shown', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  const page = await signedIn(browser, `bf${browserName}${run}`);
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 800 },
    { width: 1920, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByRole('link', { name: '浏览所有日记' })).toBeVisible();
    const fit = await page.evaluate(() => {
      const book = document.querySelector('.book')!.getBoundingClientRect();
      return {
        scrolls: document.documentElement.scrollHeight > window.innerHeight,
        inWindow: book.top >= 0 && book.bottom <= window.innerHeight,
        ratio: Math.round((book.width / book.height) * 100) / 100,
      };
    });
    expect(fit, `${size.width}×${size.height}`).toEqual({
      scrolls: false,
      inWindow: true,
      ratio: 1.5,
    });
    await bookmarkOnBook(page);
    // Were the window to scroll, the bookmark goes with the book.
    await page.evaluate(() => window.scrollTo(0, 200));
    await bookmarkOnBook(page);
  }

  // The window-high books and the contents carry it too, one at a time.
  await page.setViewportSize(WIDE);
  for (const path of ['/days', '/clocks']) {
    await page.goto(path);
    await expect(page.locator('.book-page').first()).toBeVisible();
    await bookmarkOnBook(page);
  }
  await bookmark(page).click();
  await expect(contents(page)).toBeVisible();
  await expect(page.locator('.bookmark')).toHaveCount(1);
  await expect(bookmark(page)).toHaveAttribute('aria-expanded', 'true');
  await bookmarkOnBook(page);
  await page.keyboard.press('Escape');
  await expect(contents(page)).toHaveCount(0);
  await expect(page.locator('.bookmark')).toHaveCount(1);
  await expect(bookmark(page)).toBeFocused();
  await bookmarkOnBook(page);
});

test('[adr:book-fit-and-bookmark#2] [adr:book-fit-and-bookmark#4] while the session, a page or the app itself loads, the window shows the book and no bookmark off it', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(90_000);
  const page = await signedIn(browser, `bl${browserName}${run}`);
  await watchBookmark(page);

  // Before the app's script runs, the window is already paper.
  let release = await hold(page, '**/src/main.tsx');
  await page.goto('/', { waitUntil: 'commit' });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe(PAPER);
  await expect(page.locator('#root')).toBeEmpty();
  release();
  await expect(page.getByRole('link', { name: '浏览所有日记' })).toBeVisible();

  // Asking who is signed in: a book with the message, no bookmark yet.
  release = await hold(page, '**/api/me');
  await page.goto('/');
  await expect(page.locator('.book').getByText('正在打开…')).toBeVisible();
  await expect(page.locator('.book')).toBeVisible();
  await expect(bookmark(page)).toHaveCount(0);
  release();
  await expect(page.getByRole('link', { name: '浏览所有日记' })).toBeVisible();
  await bookmarkOnBook(page);

  // The space page waits for its data on a book, with the bookmark on it.
  release = await hold(page, '**/api/spaces/**');
  await page.goto(`/spaces/${crypto.randomUUID()}`);
  await expect(page.locator('.book')).toBeVisible();
  await expect(bookmark(page)).toBeVisible();
  await bookmarkOnBook(page);
  release();
  await expect(page.locator('.book').getByRole('alert')).toBeVisible();
  await bookmarkOnBook(page);
  expect(await strayBookmark(page)).toBe(false);
});

test('[adr:opening-book-home#5] [adr:book-frontend-workspace#7] [adr:contents-spread#4] home and 目录 per relationship: never bound, bound without a sleep schedule, unbound with history', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(150_000);
  const prefix = `br${browserName}${run}`;
  const entries = async (page: Page) => {
    await bookmark(page).click();
    await expect(contents(page)).toBeVisible();
    const names = await contents(page).locator('.contents-label').allTextContents();
    await page.keyboard.press('Escape');
    await expect(contents(page)).toHaveCount(0);
    return names;
  };

  // Never bound: the own clock, the invitation, and only the diaries and backup.
  const alone = await signedIn(browser, `${prefix}n`);
  await expect(alone.getByRole('heading', { name: '此刻' })).toBeVisible();
  await expect(alone.getByText('TA 那边')).toHaveCount(0);
  await expect(alone.getByText(/共同醒着|按作息推算/)).toHaveCount(0);
  await expect(alone.getByRole('button', { name: '生成邀请链接' })).toBeVisible();
  expect(await entries(alone)).toEqual(['今天的日记', '所有日记', '备份']);

  // Bound, neither has a sleep schedule: both clocks, an entry to set one, no made-up hours.
  const { a, b, space } = await pair(browser, prefix);
  await b.goto('/');
  await expect(b.locator('.clock-face', { hasText: 'TA 那边' })).toBeVisible();
  await a.reload();
  await expect(a.getByRole('heading', { name: '两地时间' })).toBeVisible();
  await expect(a.locator('.clock-face', { hasText: 'TA 那边' })).toBeVisible();
  await expect(a.getByRole('link', { name: '设置作息' })).toBeVisible();
  await expect(a.getByText(/共同醒着/)).toHaveCount(0);
  // The left page holds 「日记」 and 「管理」, the right 「一起」 (contents-spread D3).
  expect(await entries(a)).toEqual([
    '今天的日记',
    '所有日记',
    '双人空间',
    '备份',
    '两地时间',
    '心愿与礼物',
    '纪念日',
  ]);
  // The features' pages are books inside the window too.
  for (const path of ['/wishes', '/anniversaries', space]) {
    await a.goto(path);
    await expect(a.locator('.book-page h1').first()).toBeVisible();
    expect(await outside(a), path).toEqual([]);
    await bookmarkOnScreen(a);
  }

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
    await expect(page.getByRole('heading', { name: '邀请原搭档恢复关系' })).toBeVisible();
    // The archived space and its records stay reachable; the clocks do not.
    expect(await entries(page)).toEqual([
      '今天的日记',
      '所有日记',
      '双人空间',
      '备份',
      '心愿与礼物',
      '纪念日',
    ]);
  }
  await untilRead(b, '/days', date, '绑定时写的');
  await expect(dateIn(b, date)).toContainText('已停止共享');
  await expect(dateIn(b, date)).not.toContainText('解绑后写的');
});

test('[adr:contents-spread#1] the 目录 gives back the page below as it was: a half-written form, unsent text and the feed’s place', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const { a } = await pair(browser, `bs${browserName}${run}`);

  // A wish half written stays in its field across the contents.
  await a.goto('/wishes');
  const wish = a.getByLabel('名称').first();
  await wish.fill('写到一半的心愿');
  await bookmark(a).click();
  await expect(contents(a)).toBeVisible();
  await contents(a).getByRole('button', { name: '合上目录' }).click();
  await expect(contents(a)).toHaveCount(0);
  await expect(wish).toHaveValue('写到一半的心愿');
  await expect(bookmark(a)).toBeFocused();

  // Text just typed on the left page and the place in the feed on the right stay too.
  const dates = datesFrom('2026-08-01', 12);
  await createDiaries(a, dates);
  await a.goto(`/days/${dates[11]}`);
  await expect(dateIn(a, dates[0]!)).toBeAttached();
  await editor(a).click();
  await a.keyboard.type('还没离开');
  const box = feed(a).locator('.day-feed-scroll');
  await box.evaluate((el) => (el.scrollTop = 300));
  const kept = await box.evaluate((el) => el.scrollTop);
  expect(kept).toBeGreaterThan(0);
  await bookmark(a).click();
  await expect(contents(a)).toBeVisible();
  await a.keyboard.press('Escape');
  await expect(contents(a)).toHaveCount(0);
  await expect(editor(a)).toContainText('还没离开');
  expect(await box.evaluate((el) => el.scrollTop)).toBe(kept);
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
  const allDiaries = b.getByRole('link', { name: '浏览所有日记' });
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
  await b.goto(`/days/${newest}`);
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

  const focusBy = async (locator: ReturnType<Page['locator']>) => {
    let tabs = 0;
    while (!(await locator.evaluate((el) => el === document.activeElement))) {
      await page.keyboard.press('Tab');
      expect(++tabs).toBeLessThan(80);
    }
  };
  // The date input's segments differ by engine; the value is set, the rest is keys.
  await focusBy(page.getByLabel('跳到日期'));
  await page.getByLabel('跳到日期').fill(target);
  await page.keyboard.press('Enter');
  await expect(dateIn(page, target)).toBeVisible();

  // Tab moves on from the jump through the dates above it (two links each) to the date;
  // Enter opens it in the left page.
  await focusBy(dateIn(page, target).getByRole('link').first());
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/days/${target}$`));
  await expect(dateIn(page, target).getByText('在左页', { exact: true })).toBeVisible();

  // "编辑" by keyboard hands the focus to the left page's diary.
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
  await bookmarkOnScreen(b);

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
  await bookmarkOnScreen(b);
});

test('[adr:book-frontend-workspace#8] offline, the left page says the text waits on this device and the feed claims nothing of it', async ({
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
  // The feed reads only the server: the open diary stays collapsed, nothing claims saved.
  await expect(dateIn(page, date)).toContainText('正在左页编辑');
  await expect(feed(page)).not.toContainText('断网时写的');
  await expect(page.locator('body')).not.toContainText('已保存到服务器');

  online = true;
  await expect(page.locator('.save-status')).toHaveText('已保存到服务器', { timeout: 30_000 });
  await untilRead(page, '/days', date, '联网时写的断网时写的');
});
