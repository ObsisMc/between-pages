import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';

// Kernel phase 4 through the real stack: opening a range while another device of the
// same account is offline (K8), the undo that starts again in the new generation (K7),
// and the partner's side of a shared diary (EDIT-13, EDIT-14, TIME-03, K11, K14).
// A1 and A2 are two browser contexts of one account, so two devices with their own
// IndexedDB; B is the partner. Failures are made at A1's socket; everything behind is real.
const run = Date.now().toString(36);

/** The space page is under the site header's 「设置」 (digital-paper-interface D1). */
async function openSpace(page: Page) {
  await page
    .getByRole('navigation', { name: '主要' })
    .getByRole('button', { name: /^设置/ })
    .click();
  await page.getByRole('menuitem', { name: '双人空间' }).click();
}

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

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

// The diary editors; the feed's date jump is a textbox too.
const editor = (page: Page) => page.locator('.diary-editor').getByRole('textbox');
const status = (page: Page) => page.locator('.save-status');
const saved = (page: Page) =>
  expect(status(page)).toHaveText('已保存到服务器', { timeout: 15_000 });
/** Saved where the other person can read it: the own diary while shared, or a live share. */
const synced = (page: Page) =>
  expect(status(page)).toHaveText('已同步 · 对方可以看到', { timeout: 15_000 });

/** "写今天" in the diary workspace; returns the diary's ID, as the server lists it. */
async function writeToday(page: Page) {
  await page.goto('/days');
  await page.getByRole('button', { name: '写今天' }).click();
  await expect(page).toHaveURL(/\/days\/\d{4}-\d{2}-\d{2}$/);
  await expect(editor(page)).toBeVisible();
  return page.evaluate(async (date) => {
    const res = await fetch(`/api/days/${date}`);
    return ((await res.json()) as { day: { mine: { diaryId: string } } }).day.mine.diaryId;
  }, page.url().split('/').at(-1)!);
}

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

const textOf = (base64: string) => {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Buffer.from(base64, 'base64'));
  return doc.getText('body').toString();
};

/** The text the server holds for the owner, decoded here rather than trusted from the page. */
async function serverText(page: Page, diaryId: string): Promise<string> {
  const state = await page.evaluate(async (id) => {
    const res = await fetch(`/api/diaries/${id}`);
    return ((await res.json()) as { diary: { state: string } }).diary.state;
  }, diaryId);
  return textOf(state);
}

/** What the partner may read of the owner's one shared diary in the space. */
async function partnerText(page: Page, spaceId: string): Promise<string> {
  const state = await page.evaluate(async (id) => {
    const list = (await (await fetch(`/api/spaces/${id}/shared-diaries`)).json()) as {
      diaries: { diaryId: string; epochId: string }[];
    };
    const { diaryId, epochId } = list.diaries[0]!;
    const res = await fetch(`/api/diaries/${diaryId}/shares/${epochId}`);
    return ((await res.json()) as { diary: { state: string } }).diary.state;
  }, spaceId);
  return textOf(state);
}

/** Puts a switch between the page and the real sync socket. */
async function socketSwitch(page: Page) {
  const open = new Set<WebSocketRoute>();
  const control = {
    online: true,
    /** Called with each server message; returning false drops it. */
    fromServer: (() => true) as (message: string) => boolean,
    disconnect() {
      control.online = false;
      for (const ws of open) void ws.close();
      open.clear();
    },
  };
  await page.routeWebSocket(/\/api\/sync$/, (ws) => {
    if (!control.online) return void ws.close();
    open.add(ws);
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (control.fromServer(String(message))) ws.send(message);
    });
    ws.onClose(() => open.delete(ws));
  });
  return control;
}

test('K8 K7 opening while another device is offline: committed input stays text, the rest becomes a draft, undo starts again', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const name = (who: string) => `${who}${browserName}${run}`;

  // A and B bind without sharing anything yet.
  const a2 = await signedIn(browser, name('a'));
  await a2.getByLabel('暂不设置').check();
  await a2.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a2.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, name('b'));
  await b.goto(link);
  await b.getByLabel('暂不设置').check();
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  const spaceId = new URL(b.url()).pathname.split('/').at(-1)!;

  // A1 writes; the next batch commits but its ACK is lost; then A1 goes offline with more.
  const a1 = await signedIn(browser, name('a'));
  const control = await socketSwitch(a1);
  const diaryId = await writeToday(a1);
  await typeAtEnd(a1, '公开的字');
  await saved(a1);
  control.fromServer = (message) => !message.includes('"type":"ack"');
  await typeAtEnd(a1, '甲');
  await expect.poll(() => serverText(a1, diaryId)).toBe('公开的字甲');
  control.disconnect();
  await typeAtEnd(a1, '乙');
  await expect(status(a1)).toHaveText('暂时无法同步，已保存在本机');

  // A2 opens the range from the space page without waiting for A1.
  await a2.goto('/');
  await openSpace(a2);
  await editRange(a2);
  await a2.getByLabel('全部历史与以后的日期').check();
  await a2.getByRole('button', { name: '保存范围' }).click();
  await expect(a2.getByText(/^将开放：全部历史与以后。/)).toBeVisible();
  await a2.getByRole('button', { name: '确认保存' }).click();
  await expect(a2.getByText(/（已为本次绑定确认，正在共享）/)).toBeVisible();

  // B reads what was committed at the opening: 甲 in, 乙 not.
  expect(await partnerText(b, spaceId)).toBe('公开的字甲');

  // A1 comes back: the batch it never heard of is saved, the offline input is a draft.
  control.fromServer = () => true;
  control.online = true;
  await expect(a1.getByRole('region', { name: '恢复草稿' })).toContainText('乙', {
    timeout: 60_000,
  });
  await expect(editor(a1)).toHaveText('公开的字甲');
  await synced(a1);

  // K7: undo reaches only what was typed in the new generation.
  await typeAtEnd(a1, '丙');
  await synced(a1);
  await editor(a1).press('ControlOrMeta+z');
  await editor(a1).press('ControlOrMeta+z');
  await expect(editor(a1)).toHaveText('公开的字甲');
  await synced(a1);
  expect(await serverText(a1, diaryId)).toBe('公开的字甲');
  expect(await partnerText(b, spaceId)).toBe('公开的字甲');
});

test('EDIT-13 EDIT-14 TIME-03 K11 the partner reads and writes a shared diary in real time, then keeps it read-only once it stops', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  const name = (who: string) => `${who}${browserName}${run}`;

  // A shares every date (the invitation default); B shares nothing.
  const a = await signedIn(browser, name('pa'));
  await a.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  const b = await signedIn(browser, name('pb'));
  await b.goto(link);
  await b.getByLabel('暂不设置').check();
  await b.getByRole('button', { name: '接受邀请' }).click();
  await expect(b).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  const spaceId = new URL(b.url()).pathname.split('/').at(-1)!;

  await writeToday(a);
  const ownDiary = a.url();
  await typeAtEnd(a, 'A的字');
  await synced(a);

  // B finds it among A's shared diaries on the space page; it opens its date in the
  // workspace, where the live share is the one diary B can write in.
  await b.goto(`/spaces/${spaceId}`);
  const shared = b.getByRole('region', { name: `${name('pa')} 共享的日记` });
  await shared.getByRole('link', { name: /A的字/ }).click();
  await expect(b).toHaveURL(new RegExp(`${new URL(ownDiary).pathname}$`));
  await expect(editor(b)).toHaveText('A的字');
  const legend = b.getByLabel('作者');
  await expect(legend).toContainText(name('pa'));
  await expect(legend).toContainText(name('pb'));

  // B writes; A sees it live, each author in their own color.
  await typeAtEnd(b, 'B的字');
  await synced(b);
  await expect(editor(a)).toHaveText('A的字B的字');
  const colorOf = (page: Page, text: string) =>
    page.locator('.diary-editor [class*="author-slot"]', { hasText: text }).getAttribute('class');
  expect(await colorOf(a, 'A的字')).toBe(await colorOf(b, 'A的字'));
  expect(await colorOf(b, 'A的字')).not.toBe(await colorOf(b, 'B的字'));

  // K14: A's caret shows on B's page with A's name, in A's color.
  await editor(a).click();
  await a.keyboard.press('ControlOrMeta+Home');
  await expect(b.locator(`.diary-editor .remote-caret[data-name="${name('pa')}"]`)).toBeVisible();

  // TIME-03: a click names the author and the time written.
  await b.locator('.diary-editor [class*="author-slot"]', { hasText: 'A的字' }).click();
  await expect(b.locator('.author-info')).toContainText(`${name('pa')} 写于`);

  // EDIT-14: only the own text, read-only, then everything again.
  await b.getByLabel('只看我的文字').check();
  await expect(editor(b)).toHaveAttribute('contenteditable', 'false');
  await expect(b.locator('.diary-editor .author-hidden')).toHaveText('A的字');
  await b.getByLabel('只看我的文字').uncheck();
  await expect(editor(b)).toHaveAttribute('contenteditable', 'true');

  // K11: B reads the history it is allowed to.
  await b.getByRole('button', { name: '历史' }).click();
  const points = b.getByRole('complementary', { name: '历史版本' }).getByRole('button');
  await expect(points.first()).toBeVisible({ timeout: 15_000 });
  await points.first().click();
  await expect(
    b.getByRole('region', { name: '历史版本预览' }).locator('.history-text'),
  ).toContainText('A的字');
  await b.getByRole('button', { name: '返回当前正文' }).click();

  // A stops sharing: B keeps the frozen text read-only and hears nothing private after it.
  await a.goto('/');
  await openSpace(a);
  await editRange(a);
  await a.getByLabel('自选日期').check();
  await a.getByRole('button', { name: '保存范围' }).click();
  await expect(a.getByText(/^将停止更新：/)).toBeVisible();
  await a.getByRole('button', { name: '确认保存' }).click();
  await expect(a.getByText(/（已为本次绑定确认，正在共享）/)).toBeVisible();
  await expect(b.getByText('已停止共享，内容不再更新')).toBeVisible({ timeout: 15_000 });
  await expect(editor(b)).toHaveAttribute('contenteditable', 'false');

  await a.goto(ownDiary);
  await expect(editor(a)).toHaveText('A的字B的字');
  await typeAtEnd(a, '私密');
  await saved(a);
  // What B may read is the frozen version, whatever the socket did meanwhile.
  expect(await partnerText(b, spaceId)).toBe('A的字B的字');
  await expect(editor(b)).toHaveText('A的字B的字');
});
