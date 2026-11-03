import { expect, test, type Browser, type Page } from '@playwright/test';

// The redrawn 「一起」 pages through the real stack (digital-paper-interface D3, 落地顺序 4
// and 5): the clocks page, the anniversaries and one anniversary at a wide and two narrow
// widths keep every text and control inside the page and the window, long names included;
// a day is recorded through its dialog, the together day leads the list, and the shared
// changes open under "修改". Names carry the width, the browser and a per-run suffix.
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

/** A invites B and B accepts, so both have the space and its clocks. */
async function pair(browser: Browser, prefix: string, viewport: { width: number; height: number }) {
  const a = await signedIn(browser, `${prefix}a`, viewport);
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, `${prefix}b`, viewport);
  await b.goto(link);
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  return a;
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

const LONG_NAME = 'a'.repeat(30);
const LONG_NOTE = 'b'.repeat(200);

for (const viewport of VIEWPORTS) {
  test(`${viewport.width}px: the clocks and anniversaries pages keep everything inside, forms in place`, async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(120_000);
    const a = await pair(browser, `tg${viewport.width}${browserName}${run}`, viewport);

    await a.goto('/clocks');
    await expect(a.getByRole('heading', { level: 1, name: '两地时间' })).toBeVisible();
    await a.getByLabel('入睡').selectOption({ label: '23:30' });
    await a.getByLabel('起床').selectOption({ label: '7:30' });
    await a.getByRole('button', { name: '保存作息' }).click();
    await expect(a.getByText('你平时 23:30–7:30 睡')).toBeVisible();
    expect(await outside(a), '/clocks').toEqual([]);

    await a.goto('/anniversaries');
    const record = async (fill: (dialog: ReturnType<Page['getByRole']>) => Promise<void>) => {
      await a.getByRole('button', { name: '记下一天' }).click();
      const dialog = a.getByRole('dialog');
      await fill(dialog);
      expect(await outside(a), 'the dialog').toEqual([]);
      await dialog.getByRole('button', { name: '记下', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    };
    await record(async (dialog) => {
      await dialog.getByLabel('种类').selectOption({ label: '其他' });
      await dialog.getByLabel('名称').fill(LONG_NAME);
    });
    await record(async (dialog) => {
      await dialog.getByLabel('种类').selectOption({ label: '在一起的日子' });
      await dialog.getByLabel('日期').fill('2024-01-01');
      await dialog.getByLabel('备注').fill(LONG_NOTE);
    });

    const rows = a.locator('li.anniversary');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('在一起的日子');
    await expect(rows.first()).toContainText(/在一起第 \d+ 天/);
    const fold = rows.nth(1).getByRole('button', { name: '修改' });
    await fold.click();
    await expect(rows.nth(1).getByLabel('日期')).toBeVisible();
    await expect(rows.nth(1).getByRole('button', { name: '编辑' })).toBeVisible();
    expect(await outside(a), '/anniversaries').toEqual([]);

    await rows.first().getByRole('link', { name: '在一起的日子' }).click();
    await expect(a.getByRole('heading', { level: 1 })).toHaveText('在一起的日子');
    await expect(a.getByRole('link', { name: '2025 年 1 月 1 日' })).toBeVisible();
    expect(await outside(a), 'one anniversary').toEqual([]);
  });
}
