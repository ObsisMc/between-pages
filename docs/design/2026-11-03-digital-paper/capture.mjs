/* global document, innerWidth */
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const base = fileURLToPath(new URL('.', import.meta.url));
(async () => {
  const report = [];
  for (const [engine, launch] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const b = await launch.launch({ headless: true });
    const page = await b.newPage({ viewport: { width: 1056, height: 1600 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(base + '/index.html').href);
    const f = page.frameLocator('iframe');
    const app = f.locator('[data-app=desktop]');
    await app.locator('h2').waitFor();
    const frame = page.frames().find((f) => f.parentFrame());
    async function go(screen) {
      if (['clocks', 'anniversaries', 'anniversary'].includes(screen))
        await app.locator('.bp-global [data-screen=wishes]').click();
      if (['space', 'backup', 'login', 'invite'].includes(screen))
        await app.locator('.bp-global [data-screen=space]').click();
      if (screen === 'anniversary') {
        await app.locator('.suite-subnav [data-screen=anniversaries]').click();
        await app.locator('[data-screen=anniversary]').first().click();
      } else
        await app
          .locator('[data-screen=' + screen + ']')
          .first()
          .click();
      await app.locator('h2').first().waitFor();
    }
    const routes = [
      'home',
      'diary',
      'wishes',
      'clocks',
      'anniversaries',
      'anniversary',
      'space',
      'backup',
      'login',
      'invite',
    ];
    const overflow = [];
    for (const screen of routes) {
      await go(screen);
      if (engine === 'chromium')
        await app.screenshot({
          path: base + '/screenshots/' + (screen === 'home' ? 'home-desktop' : screen) + '.png',
        });
    }
    await go('diary');
    await app.locator('[data-date="1"]').first().click();
    if (!(await app.locator('h2').filter({ hasText: '11 月 2 日' }).count()))
      throw Error('Date selection failed');
    await app.locator('[data-view="1"]').click();
    if (await app.locator('.partner').isVisible()) throw Error('View filter failed');
    await app.locator('[data-action=history]').first().click();
    await app.locator('.bp-history').waitFor();
    await go('wishes');
    await app.locator('[data-action=newwish]').click();
    await app.locator('input[name=name]').fill('一起去看雪');
    await app.locator('[data-save]').click();
    await app.locator('.bp-wishname').filter({ hasText: '一起去看雪' }).waitFor();
    await app.locator('[data-wishtab="0"]').click();
    await app.locator('[data-prepare="0"]').click();
    if ((await app.locator('[data-wishtab="2"]').getAttribute('aria-pressed')) !== 'true')
      throw Error('Wish preparation tab failed');
    await go('anniversaries');
    await app.locator('[data-extra=new-anniversary]').click();
    await app.locator('input[name=event]').fill('一起看雪的日子');
    await app.locator('[data-save-extra]').click();
    await app.locator('.suite-recordmain').filter({ hasText: '一起看雪的日子' }).waitFor();
    await go('space');
    await app.locator('[data-extra=edit-range]').click();
    await app.locator('[data-save-extra]').click();
    await app.locator('[data-finish]').click();
    await go('backup');
    await app.locator('[data-extra=backup-log]').click();
    await app.locator('.suite-log').waitFor();
    await go('login');
    await app.locator('[data-extra=sign-in]').click();
    await app.locator('h2').filter({ hasText: '小林，晚上好' }).waitFor();
    await go('invite');
    await app.locator('[data-extra=accept-invite]').click();
    await app.locator('h2').filter({ hasText: '我们的空间' }).waitFor();
    for (const width of [380, 352]) {
      await page.setViewportSize({ width, height: 1600 });
      for (const screen of routes) {
        await go(screen);
        const size = await frame.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        if (size.scroll > size.width) overflow.push({ screen, ...size });
      }
    }
    await page.setViewportSize({ width: 1056, height: 1600 });
    await frame.evaluate(() => {
      document
        .querySelectorAll('[data-variant]')
        .forEach((x) => (x.hidden = !x.querySelector('[data-app=mobile]')));
    });
    const mobile = f.locator('[data-app=mobile]');
    if (engine === 'chromium')
      await mobile.screenshot({ path: base + '/screenshots/home-mobile.png' });
    report.push({
      engine,
      routes,
      viewports: [1024, 348, 320],
      overflow,
      errors,
      interactions: [
        'date selection',
        'view filter',
        'history',
        'wish creation',
        'preparation tab',
        'anniversary creation',
        'sharing confirmation',
        'backup log',
        'mock login',
        'mock invitation',
      ],
    });
    if (overflow.length || errors.length) throw Error(JSON.stringify(report));
    await b.close();
  }
  fs.writeFileSync(base + '/capture-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})();
