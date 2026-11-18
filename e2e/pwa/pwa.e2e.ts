import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { deploy } from './builds.ts';

// installable-pwa through the built app and its service worker (验收标准): offline opening,
// the offline notice, the update bar and what Cache Storage holds. Chromium only, since
// Playwright cannot be an iPhone home-screen app (D7).
const run = Date.now().toString(36);
const NOTICE =
  '现在离线。日记和共享页面里写下的字先存在这台设备上，联网后自动发出；其他修改要联网后再做。';

test.beforeEach(() => deploy('a'));

/**
 * Signs in through the mock issuer. A production build has no development login on the page,
 * so the page asks Better Auth for the provider URL itself, as the login button would.
 */
async function signIn(page: Page, name: string) {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: '使用 Google 登录' })).toBeVisible();
  const url = await page.evaluate(async (hint) => {
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'dev',
        loginHint: hint,
        callbackURL: `${location.origin}/`,
        errorCallbackURL: `${location.origin}/login`,
        disableRedirect: true,
      }),
    });
    return ((await res.json()) as { url: string }).url;
  }, name);
  await page.goto(url);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
}

/** Waits for the worker to be active, then reloads, so the page is served by it. */
async function installed(page: Page) {
  await page.evaluate(async () => void (await navigator.serviceWorker.ready));
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

const build = (page: Page) => page.locator('meta[name="e2e-build"]').getAttribute('content');
const editor = (page: Page) => page.locator('.diary-editor').getByRole('textbox');
const status = (page: Page) => page.locator('.save-status');

async function writeToday(page: Page, text: string) {
  await page.getByRole('navigation', { name: '主要' }).getByRole('link', { name: '日记' }).click();
  await page.getByRole('button', { name: '写今天' }).click();
  await expect(page).toHaveURL(/\/days\/\d{4}-\d{2}-\d{2}$/);
  await editor(page).click();
  await page.keyboard.type(text);
  await expect(status(page)).toHaveText('已保存到服务器', { timeout: 15_000 });
}

/** Cuts the sync socket on demand, as diary.spec.ts does. */
async function socketSwitch(page: Page) {
  const open = new Set<WebSocketRoute>();
  const control = {
    online: true,
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
    server.onMessage((message) => ws.send(message));
    ws.onClose(() => open.delete(ws));
  });
  return control;
}

test('[adr:installable-pwa#1] [adr:installable-pwa#2] opens offline to the offline page, opens by itself once online, and caches only page files and fonts', async ({
  page,
  context,
}) => {
  await signIn(page, `offline-open-${run}`);
  await installed(page);
  await writeToday(page, '离线前写的');

  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    return urls.map((url) => new URL(url).pathname);
  });
  expect(cached).toContain('/index.html');
  for (const path of cached)
    expect(path).toMatch(
      /^\/(index\.html|assets\/[\w-]+\.(js|css)|favicon\.(svg|ico)|apple-touch-icon\.png|icon-\d+\.png|manifest\.webmanifest|fonts\/[\w-]+\.woff2)$/,
    );

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('现在离线，联网后会自动打开')).toBeVisible();
  await expect(page.getByText('服务暂不可用，请稍后再试')).toHaveCount(0);
  await expect(page.getByText('离线前写的')).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.getByRole('button', { name: `账号：offline-open-${run}` })).toBeVisible();
  await expect(page.getByText('现在离线，联网后会自动打开')).toHaveCount(0);
});

test('[adr:installable-pwa#4] says offline on every page while the connection is gone, never that it saved', async ({
  page,
  context,
}) => {
  await signIn(page, `offline-notice-${run}`);
  await installed(page);
  await writeToday(page, '在线写的');

  await context.setOffline(true);
  await expect(page.getByText(NOTICE)).toBeVisible();
  await page.getByRole('navigation', { name: '主要' }).getByRole('link', { name: '此刻' }).click();
  await expect(page.getByText(NOTICE)).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText(NOTICE)).toHaveCount(0, { timeout: 15_000 });
});

test('[adr:installable-pwa#5] [adr:installable-pwa#6] shows 有新版本 · 刷新 for a new build, changes nothing until asked, then loads it keeping unsent text', async ({
  page,
}) => {
  await signIn(page, `update-${run}`);
  await installed(page);
  const sync = await socketSwitch(page);
  await writeToday(page, '第一版写的');
  sync.disconnect();
  await page.keyboard.type('，没发出的字');
  await expect(status(page)).toHaveText('暂时无法同步，已保存在本机');
  expect(await build(page)).toBe('a');
  await page.evaluate(() => ((window as { stillHere?: boolean }).stillHere = true));

  await deploy('b');
  // Coming back to the foreground is when an open app looks for a new version.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('有新版本')).toBeVisible({ timeout: 15_000 });
  // The new version waits; nothing took over or reloaded the page.
  expect(
    await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting),
  ).toBe(true);
  expect(await page.evaluate(() => (window as { stillHere?: boolean }).stillHere)).toBe(true);
  expect(await build(page)).toBe('a');

  await page.getByRole('button', { name: '刷新' }).click();
  await expect.poll(() => build(page)).toBe('b');
  expect(await page.evaluate(() => (window as { stillHere?: boolean }).stillHere)).toBeUndefined();
  await expect(editor(page)).toHaveText('第一版写的，没发出的字');
  await expect(page.getByText('有新版本')).toHaveCount(0);
  sync.online = true;
  await expect(status(page)).toHaveText('已保存到服务器', { timeout: 15_000 });
});
