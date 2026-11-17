import { expect, test, type Browser, type Page } from '@playwright/test';
import { unsubscribeToken } from '../apps/api/src/mail/tokens.ts';

// Email reminder settings and the unsubscribe page through the real stack (email-reminders
// 落地顺序 2, D8): the home notice once, the switches kept by the server, and a mail's
// unsubscribe link opened signed out, which asks before turning its category off. The
// link is signed with the e2e server's MAIL_TOKEN_KEY (playwright.config.ts). Names carry
// the browser and a per-run suffix.
const run = Date.now().toString(36);
const KEY = Buffer.from('ZTJlLW9ubHktbWFpbC10b2tlbi1rZXktMzItYnl0ZXM=', 'base64');

test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

async function signedIn(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('开发登录').fill(name);
  await page.getByRole('button', { name: '开发登录' }).click();
  await expect(page.getByRole('button', { name: `账号：${name}` })).toBeVisible();
  return page;
}

const switchOf = (page: Page, name: string) => page.getByRole('switch', { name });

test('[adr:email-reminders#9] keeps the switches, and a mail’s link unsubscribes one category after asking, signed out', async ({
  browser,
  browserName,
}) => {
  const page = await signedIn(browser, `m${browserName}${run}`);
  const notice = page.getByRole('status').filter({ hasText: '邮件提醒已开启，可在设置里关闭' });
  await expect(notice).toBeVisible();
  await notice.getByRole('link', { name: '邮件提醒设置' }).click();
  await expect(page).toHaveURL(/\/mail$/);
  await expect(page.getByRole('heading', { name: '邮件提醒' })).toBeVisible();

  await expect(switchOf(page, '纪念日')).toHaveAttribute('aria-checked', 'true');
  await switchOf(page, '纪念日').click();
  await expect(switchOf(page, '纪念日')).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(switchOf(page, '纪念日')).toHaveAttribute('aria-checked', 'false');
  await expect(switchOf(page, '有新内容')).toHaveAttribute('aria-checked', 'true');

  const { user } = (await (await page.request.get('/api/me')).json()) as { user: { id: string } };
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`/unsubscribe?token=${unsubscribeToken(KEY, user.id, 'backup')}`);
  await expect(stranger.getByText('不再收到「备份」邮件？')).toBeVisible();
  await stranger.getByRole('button', { name: '不再收到' }).click();
  await expect(stranger.getByRole('status')).toContainText('已退订「备份」邮件。');

  await page.reload();
  await expect(switchOf(page, '备份')).toHaveAttribute('aria-checked', 'false');
  await expect(switchOf(page, '有新内容')).toHaveAttribute('aria-checked', 'true');

  // The home notice, once closed, stays closed.
  await page.getByRole('navigation', { name: '主要' }).getByRole('link', { name: '此刻' }).click();
  await notice.getByRole('button', { name: '不再显示' }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: /^账号：/ })).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test('says a link not signed by this server is invalid', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/unsubscribe?token=not-a-token');
  await expect(page.getByRole('alert')).toContainText('这个退订链接无效');
});
