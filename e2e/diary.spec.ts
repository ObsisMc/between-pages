import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';

// Kernel phase 3 through the real stack in Chromium, Firefox and WebKit: the diary screen,
// IndexedDB journal, Web Lock sender and sync socket against the API and PostgreSQL.
// Failures are made at the socket with routeWebSocket; everything behind it is real.
// Names carry the browser and a per-run suffix, so projects running at once and reruns
// against one database stay independent.
const run = Date.now().toString(36);

async function devLogin(page: Page, name: string) {
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function writeToday(page: Page) {
  await page.getByRole('button', { name: '写今天' }).click();
  await expect(page).toHaveURL(/\/diaries\/[0-9a-f-]{36}$/);
  await expect(editor(page)).toBeVisible();
  return page.url().split('/').at(-1)!;
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

/** The committed text as the server holds it, decoded here rather than trusted from the page. */
async function serverText(page: Page, diaryId: string): Promise<string> {
  const state = await page.evaluate(async (id) => {
    const res = await fetch(`/api/diaries/${id}`);
    return ((await res.json()) as { diary: { state: string } }).diary.state;
  }, diaryId);
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Buffer.from(state, 'base64'));
  return doc.getText('body').toString();
}

async function signedInPage(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await devLogin(page, name);
  return page;
}

type Filter = (message: string, ws: WebSocketRoute) => boolean;
const pass: Filter = () => true;

/** Puts a switch between the page and the real sync socket. */
async function socketSwitch(page: Page) {
  const open = new Set<WebSocketRoute>();
  const control = {
    online: true,
    /** Called with each server message; returning false drops it. */
    fromServer: pass,
    /** Called with each client message; returning false keeps it from the server. */
    fromClient: pass,
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
    ws.onMessage((message) => {
      if (control.fromClient(String(message), ws)) server.send(message);
    });
    server.onMessage((message) => {
      if (control.fromServer(String(message), ws)) ws.send(message);
    });
    ws.onClose(() => open.delete(ws));
  });
  return control;
}

test('SAVE-01 DATE-02 writes today, saves to the server and finds it again', async ({
  page,
  browserName,
}) => {
  await devLogin(page, `writer-${browserName}-${run}`);
  const diaryId = await writeToday(page);
  await typeAtEnd(page, '今天很累，但是想到你就开心了。');
  await saved(page);
  expect(await serverText(page, diaryId)).toBe('今天很累，但是想到你就开心了。');

  await page.reload();
  await expect(editor(page)).toHaveText('今天很累，但是想到你就开心了。');
  await page.getByRole('link', { name: '← 返回' }).click();
  expect(await writeToday(page)).toBe(diaryId);
});

test('DATE-06 opens a past date as its own diary', async ({ page, browserName }) => {
  await devLogin(page, `backfill-${browserName}-${run}`);
  const today = await writeToday(page);
  await page.getByRole('link', { name: '← 返回' }).click();
  await page.getByLabel('打开或补写过去的日期').fill('2026-10-05');
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page).toHaveURL(/\/diaries\/[0-9a-f-]{36}$/);
  expect(page.url()).not.toContain(today);
  await typeAtEnd(page, '补写');
  await saved(page);
});

test('SYNC-04 two devices of one account edit together without overwriting', async ({
  browser,
  browserName,
}) => {
  const name = `devices-${browserName}-${run}`;
  const a1 = await signedInPage(browser, name);
  const diaryId = await writeToday(a1);
  const a2 = await signedInPage(browser, name);
  await a2.goto(`/diaries/${diaryId}`);
  await expect(editor(a2)).toBeVisible();

  for (const [i, ch] of [...'甲乙丙'].entries()) {
    await typeAtEnd(a1, ch);
    await typeAtEnd(a2, String(i + 1));
  }
  await saved(a1);
  await saved(a2);
  await expect
    .poll(() => serverText(a1, diaryId), { timeout: 15_000 })
    .toHaveLength('甲乙丙123'.length);
  const text = await serverText(a1, diaryId);
  expect([...text].sort()).toEqual([...'甲乙丙123'].sort());
  await expect(editor(a1)).toHaveText(text);
  await expect(editor(a2)).toHaveText(text);
});

test('SAVE-02 keeps input written while disconnected across a reload and sends it later', async ({
  page,
  browserName,
}) => {
  await devLogin(page, `offline-${browserName}-${run}`);
  const sync = await socketSwitch(page);
  const diaryId = await writeToday(page);
  await saved(page);
  sync.disconnect();
  await typeAtEnd(page, '断网时写的');
  await expect(status(page)).toHaveText('暂时无法同步，已保存在本机');

  await page.reload();
  await expect(editor(page)).toHaveText('断网时写的');
  expect(await serverText(page, diaryId)).toBe('');
  sync.online = true;
  await saved(page);
  expect(await serverText(page, diaryId)).toBe('断网时写的');
});

test('SAVE-03 resends a batch whose ACK was lost and commits it once', async ({
  page,
  browserName,
}) => {
  await devLogin(page, `ack-${browserName}-${run}`);
  const sync = await socketSwitch(page);
  const diaryId = await writeToday(page);
  await saved(page);
  let dropped = false;
  sync.fromServer = (message, ws) => {
    if (dropped || !message.includes('"type":"ack"')) return true;
    dropped = true;
    void ws.close(); // committed on the server, but the answer never arrives
    return false;
  };

  await typeAtEnd(page, '只一次');
  await saved(page);
  expect(dropped).toBe(true);
  expect(await serverText(page, diaryId)).toBe('只一次');
});

test('SAVE-07 SAVE-11 keeps a refused batch as a recovery draft, never as text', async ({
  page,
  browserName,
}) => {
  await devLogin(page, `refused-${browserName}-${run}`);
  const sync = await socketSwitch(page);
  const diaryId = await writeToday(page);
  await saved(page);
  let refused = false;
  sync.fromClient = (message, ws) => {
    if (refused || !message.includes('"type":"submit"')) return true;
    refused = true;
    const { diaryId: diary, batchId } = JSON.parse(message) as Record<string, string>;
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'error',
        code: 'EDIT_REJECTED',
        message: 'Batch not committed',
        diaryId: diary,
        batchId,
      }),
    );
    return false;
  };

  await typeAtEnd(page, '被拒');
  const drafts = page.getByRole('region', { name: '恢复草稿' });
  await expect(drafts).toContainText('服务器没有接受这段输入');
  await expect(drafts).toContainText('被拒');
  await expect(editor(page)).toHaveText('');
  await typeAtEnd(page, '重写');
  await saved(page);
  expect(await serverText(page, diaryId)).toBe('重写');

  await page.reload();
  await expect(drafts).toContainText('被拒');
  await drafts.getByRole('button', { name: '删除草稿' }).click();
  await drafts.getByRole('button', { name: '确认删除这条草稿' }).click();
  await expect(drafts).toHaveCount(0);
});

test('stays read-only in a browser without Web Locks', async ({ page, browserName }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined });
  });
  await devLogin(page, `readonly-${browserName}-${run}`);
  await writeToday(page);
  await expect(status(page)).toHaveText('只读：这个浏览器无法安全保存，请升级浏览器');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
});

test('EDIT-16 previews the own history read-only and returns to the current text', async ({
  page,
  browserName,
}) => {
  // A history point closes once the server sees no commit for HISTORY_IDLE_MS (3 s here,
  // two minutes in production, kernel D6); the test polls the API rather than sleeping.
  await devLogin(page, `history-${browserName}-${run}`);
  const diaryId = await writeToday(page);
  const points = () =>
    page.evaluate(async (id) => {
      const res = await fetch(`/api/diaries/${id}/history`);
      return ((await res.json()) as { points: unknown[] }).points.length;
    }, diaryId);
  const closed = (n: number) =>
    expect.poll(points, { timeout: 15_000, intervals: [1_000] }).toBe(n);

  await typeAtEnd(page, '早上写的');
  await saved(page);
  await closed(1);
  await typeAtEnd(page, '，下午补的');
  await saved(page);
  await closed(2);

  await page.getByRole('button', { name: '历史' }).click();
  const panel = page.getByRole('complementary', { name: '历史版本' });
  // Newest first: the last entry is the morning version.
  await expect(panel.getByRole('button')).toHaveCount(2);
  await panel.getByRole('button').last().click();
  const preview = page.getByRole('region', { name: '历史版本预览' });
  await expect(preview.locator('.history-text')).toHaveText('早上写的');
  await expect(preview).toContainText('只读');
  await expect(page.getByRole('button', { name: /恢复|回滚/ })).toHaveCount(0);
  await expect(editor(page)).toBeHidden();

  await preview.getByRole('button', { name: '返回当前正文' }).click();
  await expect(editor(page)).toHaveText('早上写的，下午补的');
  expect(await serverText(page, diaryId)).toBe('早上写的，下午补的');
});
