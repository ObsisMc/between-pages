import { expect, test, type Page } from '@playwright/test';

// Acceptance E1-E6 of the authentication-and-sessions ADR, through the development login.
// Names carry the browser and a per-run suffix, so projects running at once and reruns
// against one database stay independent.
const run = Date.now().toString(36);

async function devLogin(page: Page, name: string) {
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
}

test('E1 sends a signed-out visitor from / to /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: '使用 Google 登录' })).toBeVisible();
});

test('E2-E4 signs in, survives a reload and signs out', async ({ page, browserName }) => {
  const name = `alice-${browserName}-${run}`;
  await devLogin(page, name);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();

  await page.getByRole('button', { name: `账号：${name}` }).click();
  await page.getByRole('menuitem', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('E5 refuses a second subject with an email already in use', async ({ page, browserName }) => {
  const name = `carol-${browserName}-${run}`;
  await devLogin(page, name);
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  await page.getByRole('button', { name: `账号：${name}` }).click();
  await page.getByRole('menuitem', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await devLogin(page, `${name}#2`);
  await expect(page).toHaveURL(/\/login\?error=account_not_linked$/);
  await expect(page.getByRole('alert')).toHaveText(
    '这个 Google 账号的邮箱已被另一个账号使用。请换一个 Google 账号登录，或联系我们处理。',
  );
});

test('E6 sends a signed-in user from /login to /', async ({ page, browserName }) => {
  const name = `dave-${browserName}-${run}`;
  await devLogin(page, name);
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
});
