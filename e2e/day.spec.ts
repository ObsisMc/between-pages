import { expect, test, type Browser, type Page } from '@playwright/test';

// The day page through the real stack (unread-and-day-page D6, D7): both diaries of a date
// stacked, each its own session, the view switch, "写这天", and author protection between
// the two editors. A shares every date with B; B shares nothing.
const run = Date.now().toString(36);

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

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

const mine = (page: Page) => page.getByRole('region', { name: '我的日记' });
const theirs = (page: Page) => page.getByRole('region', { name: 'TA 的日记' });
const editorIn = (region: ReturnType<typeof mine>) => region.getByRole('textbox');

test('[adr:unread-and-day-page#9] [adr:unread-and-day-page#11] DATE-03 both diaries of a day stacked and written in place, each its own session', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const { a, b } = await pair(browser, `dy${browserName}${run}`);
  await a.goto('/');
  await a.getByRole('button', { name: '写今天' }).click();
  await expect(a).toHaveURL(/\/diaries\/[0-9a-f-]{36}$/);
  await a.getByRole('textbox').click();
  await a.keyboard.type('A的今天');
  await expect(a.locator('.save-status')).toHaveText('已同步 · 对方可以看到', { timeout: 15_000 });

  // B's card for the day opens the day page; B has no diary there yet.
  await b.goto('/');
  await b.getByRole('region', { name: '日记', exact: true }).getByRole('link').click();
  await expect(b).toHaveURL(/\/days\/\d{4}-\d{2}-\d{2}$/);
  await expect(editorIn(theirs(b))).toHaveText('A的今天');
  await mine(b).getByRole('button', { name: '写这天' }).click();
  await expect(editorIn(mine(b))).toBeVisible();
  await expect(b).toHaveURL(/\/days\/\d{4}-\d{2}-\d{2}$/);
  // B shares nothing: B's own diary is marked as private.
  await expect(mine(b).getByText('仅自己可见')).toBeVisible();
  await expect(theirs(b).getByText('仅自己可见')).toHaveCount(0);

  // Writing in one diary changes only that one; A sees B's line in A's own diary.
  await editorIn(mine(b)).click();
  await b.keyboard.type('B自己的');
  await expect(mine(b).locator('.save-status')).toHaveText('已保存到服务器', { timeout: 15_000 });
  await editorIn(theirs(b)).click();
  await b.keyboard.press('ControlOrMeta+End');
  await b.keyboard.type('，B回');
  await expect(theirs(b).locator('.save-status')).toHaveText('已同步 · 对方可以看到', {
    timeout: 15_000,
  });
  await expect(a.getByRole('textbox')).toHaveText('A的今天，B回');
  await expect(editorIn(mine(b))).toHaveText('B自己的');

  // Undo acts on the focused diary only. (How much of B's own typing one step takes back
  // depends on Yjs's 500 ms capture groups, so only "甲" is checked.)
  await editorIn(mine(b)).click();
  await b.keyboard.press('ControlOrMeta+End');
  await b.keyboard.type('甲');
  await expect(editorIn(mine(b))).toHaveText('B自己的甲');
  await b.keyboard.press('ControlOrMeta+z');
  await expect(editorIn(mine(b))).not.toContainText('甲');
  await expect(editorIn(theirs(b))).toHaveText('A的今天，B回');
  await expect(a.getByRole('textbox')).toHaveText('A的今天，B回');

  // A's page did not turn into a day page by itself; it offers it, A chooses.
  await expect(a.getByText(/TA 也写了这天/)).toHaveCount(0);
  await expect(a.getByRole('textbox')).toHaveCount(1);
});

test('[adr:unread-and-day-page#7] [adr:unread-and-day-page#9] D7 the two editors protect each other: a selection dragged across changes nothing, pasted text is the writer’s, hidden text is not read', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const { a, b } = await pair(browser, `dz${browserName}${run}`);
  await a.goto('/');
  await a.getByRole('button', { name: '写今天' }).click();
  await expect(a).toHaveURL(/\/diaries\/[0-9a-f-]{36}$/);
  const aDiary = a.url().split('/').at(-1)!;
  await a.getByRole('textbox').click();
  await a.keyboard.type('A写的字');
  await expect(a.locator('.save-status')).toHaveText('已同步 · 对方可以看到', { timeout: 15_000 });

  await b.goto('/');
  await b.getByRole('region', { name: '日记', exact: true }).getByRole('link').click();
  await mine(b).getByRole('button', { name: '写这天' }).click();
  await editorIn(mine(b)).click();
  await b.keyboard.type('B写的字');
  await expect(mine(b).locator('.save-status')).toHaveText('已保存到服务器', { timeout: 15_000 });
  await expect(editorIn(theirs(b))).toHaveText('A写的字');

  // A selection dragged from one diary into the other stays in the one it started in (all
  // three engines keep a drag inside its editing host): from A's text it holds only A's
  // characters, which B cannot delete or replace; dragged from the heading across both, it
  // is in no editor and edits nothing. Either way neither diary changes.
  const middle = async (locator: ReturnType<typeof editorIn>) => {
    const box = (await locator.boundingBox())!;
    return { x: box.x + 8, y: box.y + box.height / 2 };
  };
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await b.mouse.move(from.x, from.y);
    await b.mouse.down();
    await b.mouse.move(to.x, to.y, { steps: 12 });
    await b.mouse.up();
  };
  // From inside A's text, so a drag up or down selects some of it whichever diary is first.
  const fromTheirs = () =>
    b.evaluate(() => {
      const box = document.querySelector('section[aria-label="TA 的日记"] [role="textbox"]')!;
      const text = document.createTreeWalker(box, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.setStart(text, 2);
      range.setEnd(text, 2);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    });
  const fromHeading = async () => {
    const box = (await b.locator('.day-date').boundingBox())!;
    return { x: box.x + 2, y: box.y + box.height / 2 };
  };
  for (const from of [fromTheirs, fromHeading])
    for (const act of [
      () => b.keyboard.press('Backspace'),
      () => b.keyboard.press('Delete'),
      () => b.keyboard.type('x'),
      () => b.keyboard.press('ControlOrMeta+x'),
    ]) {
      // A refusal notice shifts the text while it shows; drags start once it has gone.
      await expect(b.locator('.refusal')).toHaveCount(0, { timeout: 10_000 });
      await drag(await from(), await middle(editorIn(mine(b))));
      expect(await b.evaluate(() => document.getSelection()!.toString())).not.toBe('');
      await act();
      await expect(editorIn(mine(b))).toHaveText('B写的字');
      await expect(editorIn(theirs(b))).toHaveText('A写的字');
    }
  await expect(a.getByRole('textbox')).toHaveText('A写的字');

  // Copied from A's diary and pasted into B's own: B's plain text.
  await editorIn(mine(b)).click();
  await b.keyboard.press('ControlOrMeta+End');
  await b.evaluate(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? 'A写的' : '') },
    });
    document.activeElement!.dispatchEvent(event);
  });
  await expect(editorIn(mine(b))).toHaveText('B写的字A写的');
  const slots = await editorIn(mine(b))
    .locator('[class*="author-slot"]')
    .evaluateAll((spans) => [...new Set(spans.map((s) => s.className))]);
  expect(slots).toHaveLength(1);

  // "我的" hides A's diary without unmounting it; text A writes meanwhile is not read.
  await b.getByRole('group', { name: '视图' }).getByRole('button', { name: '我的' }).click();
  await expect(theirs(b)).toBeHidden();
  await a.getByRole('textbox').click();
  await a.keyboard.press('ControlOrMeta+End');
  await a.keyboard.type('，后来的');
  await expect(a.locator('.save-status')).toHaveText('已同步 · 对方可以看到', { timeout: 15_000 });
  const reads = () =>
    b.evaluate(
      async (id) =>
        ((await (await fetch(`/api/diaries/${id}/read`)).json()) as { ranges: unknown[] }).ranges,
      aDiary,
    );
  const before = await reads();
  await b.waitForTimeout(3_000);
  expect(await reads()).toEqual(before);
  await b.getByRole('group', { name: '视图' }).getByRole('button', { name: '双人' }).click();
  await expect(editorIn(theirs(b))).toHaveText('A写的字，后来的');
});
