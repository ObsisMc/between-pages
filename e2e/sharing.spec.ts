import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';

// Kernel phase 4 through the real stack: opening a range while another device of the
// same account is offline (K8) and the undo that starts again in the new generation (K7).
// A1 and A2 are two browser contexts of one account, so two devices with their own
// IndexedDB; B is the partner. Failures are made at A1's socket; everything behind is real.
const run = Date.now().toString(36);

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByText(`已登录为 ${name}`)).toBeVisible();
  return page;
}

const editor = (page: Page) => page.getByRole('textbox');
const status = (page: Page) => page.locator('.save-status');
const saved = (page: Page) =>
  expect(status(page)).toHaveText('已保存到服务器', { timeout: 15_000 });

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
  await a1.getByRole('button', { name: '写今天' }).click();
  await expect(a1).toHaveURL(/\/diaries\/[0-9a-f-]{36}$/);
  await expect(editor(a1)).toBeVisible();
  const diaryId = a1.url().split('/').at(-1)!;
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
  await a2.getByRole('link', { name: `与 ${name('b')} 的空间` }).click();
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
  await saved(a1);

  // K7: undo reaches only what was typed in the new generation.
  await typeAtEnd(a1, '丙');
  await saved(a1);
  await editor(a1).press('ControlOrMeta+z');
  await editor(a1).press('ControlOrMeta+z');
  await expect(editor(a1)).toHaveText('公开的字甲');
  await saved(a1);
  expect(await serverText(a1, diaryId)).toBe('公开的字甲');
  expect(await partnerText(b, spaceId)).toBe('公开的字甲');
});
