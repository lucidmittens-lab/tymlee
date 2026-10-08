const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [dev, opts] of [['desk', { viewport: { width: 1100, height: 720 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }]]) {
    const ctx = await b.newContext({ ...opts, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await ctx.clock.install({ time: new Date('2026-10-01T09:40:00-04:00') });
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate(() => localStorage.setItem('tymlee.view2', 'pure'));
    await p.reload(); await p.waitForTimeout(700);
    ok(await p.locator('.tl-welcome').isVisible(), `${dev}: first visit shows the welcome`);
    await p.screenshot({ path: `${S}/v17-${dev}-welcome.png` });
    await p.fill('.sb-cat input', 'dev'); await p.fill('.sb-title', 'first thing'); await p.click('.sb-start'); await p.waitForTimeout(400);
    ok(!(await p.locator('.tl-welcome').count()), `${dev}: welcome goes once something is logged`);
    await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(250);
    ok(await p.locator('.gmenu-tile').count() === 3, `${dev}: quick tiles`);
    ok(await p.locator('.gmenu-item', { hasText: 'To-do list' }).isVisible() && !(await p.locator('.gmenu-item', { hasText: 'Categories' }).isVisible()), `${dev}: only To-do open by default`);
    await p.locator('.gmenu-section', { hasText: 'Reports' }).click(); await p.waitForTimeout(100);
    ok(await p.locator('.gmenu-item', { hasText: 'Categories' }).isVisible() && !(await p.locator('.gmenu-item', { hasText: 'To-do list' }).isVisible()), `${dev}: a section opens, the other closes`);
    ok(await p.locator('.gmenu-group.open').count() === 1, `${dev}: one section open at a time`);
    await p.screenshot({ path: `${S}/v17-${dev}-menu.png` });
    await p.locator('.gmenu-tile', { hasText: 'Undo' }).click(); await p.waitForTimeout(400);
    await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(250);
    ok(await p.locator('.gmenu-item', { hasText: 'Categories' }).isVisible(), `${dev}: open sections are remembered`);
    await p.evaluate(() => document.querySelector('.gmenu-item').click()); // keep the sheet; show a toast over it
    await ctx.close();
  }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
