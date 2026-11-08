import { expect, test, type Browser, type Page } from '@playwright/test';
import { clickDay } from './calendar.ts';

// The redrawn pages before a space (digital-paper-interface D3, D4, 落地顺序 4 and 5): the
// login page, the invitation signed out and signed in with its range editor, and the
// home's invitation panel, at a wide and two narrow widths, keep every text and control
// inside the page and the window, and the page's card comes before the windows on a narrow
// window. Names carry the width, the browser and a per-run suffix.
const run = Date.now().toString(36);

// Contexts opened with browser.newContext() outlive the test on the worker's browser, and
// their pages keep polling into every later test; each test closes the ones it opened.
test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 375, height: 740 },
  { width: 320, height: 640 },
];

async function signedIn(
  browser: Browser,
  name: string,
  viewport: { width: number; height: number },
): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

/**
 * What lies outside the box it belongs to: the text and elements of each region (the
 * children of `main`, and an open dialog) outside that region by more than a pixel, and the
 * window's sideways scroll. Text is measured by its own boxes, so a word running out of its
 * block counts, clipped or not.
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
    for (const region of document.querySelectorAll<HTMLElement>('main > *, [role="dialog"]')) {
      const own = region.getBoundingClientRect();
      if (own.width === 0) continue;
      const box = { left: Math.max(own.left, 0), right: Math.min(own.right, width) };
      check(`<${region.tagName.toLowerCase()}>`, own, { left: 0, right: width });
      for (const el of region.querySelectorAll<HTMLElement>('*'))
        check(
          `<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">`,
          el.getBoundingClientRect(),
          box,
        );
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
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

/** Where the page's card sits against the windows: above them (narrow) or beside them (wide). */
const cardPlace = (page: Page) =>
  page.evaluate(() => {
    const [hero, card] = [...document.querySelectorAll('main > *')].map((el) =>
      el.getBoundingClientRect(),
    );
    if (card!.bottom <= hero!.top) return 'above';
    if (card!.left >= hero!.right) return 'beside';
    return 'overlapping';
  });

for (const viewport of VIEWPORTS) {
  test(`${viewport.width}px: login, the invitation and the home's invitation panel keep everything inside`, async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(120_000);
    const name = (who: string) => `te${viewport.width}${browserName}${run}${who}`;

    const login = await (await browser.newContext({ viewport })).newPage();
    await login.goto('/login');
    await expect(login.getByRole('button', { name: '使用 Google 登录' })).toBeVisible();
    expect(await outside(login), '/login').toEqual([]);
    expect(await cardPlace(login)).toBe(viewport.width < 768 ? 'above' : 'beside');

    // The home keeps only the partner card; the invitation is made under 设置 → 搭档.
    const a = await signedIn(browser, name('a'), viewport);
    const card = a.getByRole('region', { name: '搭档' });
    await expect(card.getByText('还没有搭档')).toBeVisible();
    await expect(a.getByRole('button', { name: '生成邀请链接' })).toHaveCount(0);
    expect(await outside(a), 'the home unbound').toEqual([]);
    await card.getByRole('link', { name: '邀请搭档' }).click();
    await expect(a).toHaveURL(/\/partner$/);
    await expect(a.getByRole('heading', { level: 1, name: '搭档' })).toBeVisible();
    await a.getByLabel('自选日期').check();
    await clickDay(a, '2026-10-01');
    await expect(a.getByRole('button', { name: '从这天起一直共享' })).toBeVisible();
    expect(await outside(a), 'the partner page with the range editor').toEqual([]);
    await a.getByLabel('全部历史与以后的日期').check();
    await a.getByRole('button', { name: '生成邀请链接' }).click();
    const link = await a.getByLabel('邀请链接').inputValue();
    expect(await outside(a), 'the partner page with the link').toEqual([]);
    await a.goto('/');
    await expect(card.getByText(/^已发出邀请，.+ 前有效$/)).toBeVisible();
    expect(await outside(a), 'the home with an invitation out').toEqual([]);

    // B opens the link signed out, then signs in and comes back to it.
    const b = await (await browser.newContext({ viewport })).newPage();
    await b.goto(link);
    await expect(b.getByRole('link', { name: '去登录' })).toBeVisible();
    expect(await outside(b), '/join signed out').toEqual([]);
    await b.getByRole('link', { name: '去登录' }).click();
    await b.getByLabel('开发登录').fill(name('b'));
    await b.getByRole('button', { name: '开发登录' }).click();
    await expect(b.getByRole('button', { name: '接受邀请' })).toBeVisible();
    await b.getByLabel('自选日期').check();
    await clickDay(b, '2026-10-01');
    await clickDay(b, '2026-10-31');
    await b.getByRole('radio', { name: '添加排除' }).click();
    await clickDay(b, '2026-10-10');
    await expect(b.getByRole('list', { name: '已选的日期段' })).toContainText('排除 2026-10-10');
    expect(await outside(b), '/join signed in').toEqual([]);
    expect(await cardPlace(b)).toBe(viewport.width < 768 ? 'above' : 'beside');
  });
}
