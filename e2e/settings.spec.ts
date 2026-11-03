import { expect, test, type Browser, type Page } from '@playwright/test';

// The redrawn 「设置」 pages through the real stack (digital-paper-interface D3, 落地顺序 4
// and 5): the space page with its range editor unfolded, the range confirmation and the
// unbinding dialogs, and the backup page, at a wide and two narrow widths, keep every text
// and control inside the page and the window; the confirmations ask before anything is
// sent. Names carry the width, the browser and a per-run suffix.
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

/** A invites B and B accepts; A is left on the home page. */
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

for (const viewport of VIEWPORTS) {
  test(`${viewport.width}px: the space and backup pages keep everything inside, confirmations in dialogs`, async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(120_000);
    const a = await pair(browser, `ts${viewport.width}${browserName}${run}`, viewport);

    // A's header lists the space once it reads the binding again, as on any new page.
    await a.reload();
    await a
      .getByRole('navigation', { name: '主要' })
      .getByRole('button', { name: /^设置/ })
      .click();
    await a.getByRole('menuitem', { name: '双人空间' }).click();
    await expect(a.getByRole('heading', { level: 1 })).toHaveText(/^与 .* 的空间$/);
    await expect(a.getByText(/（已为本次绑定确认，正在共享）/)).toBeVisible();
    expect(await outside(a), 'the space page').toEqual([]);

    // The confirmed range folds its editor; unfolded with two ranges it still fits.
    const fold = a.getByRole('button', { name: '调整共享日期' });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await fold.click();
    await a.getByLabel('自选日期').check();
    await a.getByRole('button', { name: '添加共享日期' }).click();
    const first = a.getByRole('group', { name: '共享第 1 段' });
    await first.getByLabel('开始').fill('2026-10-01');
    await first.getByLabel('以后持续').check();
    await a.getByRole('button', { name: '添加排除日期' }).click();
    const skip = a.getByRole('group', { name: '排除第 1 段' });
    await skip.getByLabel('开始').fill('2026-10-10');
    await skip.getByLabel('结束').fill('2026-10-10');
    expect(await outside(a), 'the range editor').toEqual([]);

    await a.getByRole('button', { name: '保存范围' }).click();
    const confirm = a.getByRole('dialog', { name: '确认共享范围' });
    await expect(confirm.getByText(/^将停止更新：/)).toBeVisible();
    expect(await outside(a), 'the range confirmation').toEqual([]);
    await confirm.getByRole('button', { name: '取消' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(a.getByText(/（已为本次绑定确认，正在共享）/)).toBeVisible();

    await a.getByRole('button', { name: '解除绑定' }).click();
    const unbind = a.getByRole('dialog', { name: '解除绑定' });
    await expect(unbind.getByRole('button', { name: '确认解除绑定' })).toBeVisible();
    expect(await outside(a), 'the unbinding dialog').toEqual([]);
    await unbind.getByRole('button', { name: '取消' }).click();
    await expect(a.getByText('当前绑定中')).toBeVisible();

    await a.goto('/backup');
    await expect(a.getByRole('heading', { level: 1, name: '备份' })).toBeVisible();
    await expect(a.getByText('服务器自动备份')).toBeVisible();
    expect(await outside(a), '/backup').toEqual([]);
  });
}
