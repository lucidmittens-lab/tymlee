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
    ok(await p.locator('.gmenu-tile').count() === 4, `${dev}: quick tiles`);
    ok(await p.locator('.gmenu-item', { hasText: 'Add a note' }).isVisible() && !(await p.locator('.gmenu-item', { hasText: 'Categories' }).isVisible()), `${dev}: only Entries open by default`);
    await p.locator('.gmenu-section', { hasText: 'Reports' }).click(); await p.waitForTimeout(100);
    ok(await p.locator('.gmenu-item', { hasText: 'Categories' }).isVisible() && !(await p.locator('.gmenu-item', { hasText: 'Add a note' }).isVisible()), `${dev}: a section opens, the other closes`);
    ok(await p.locator('.gmenu-group.open').count() === 1, `${dev}: one section open at a time`);
    await p.screenshot({ path: `${S}/v17-${dev}-menu.png` });
    await p.locator('.gmenu-tile', { hasText: 'Undo' }).click(); await p.waitForTimeout(400);
    await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(250);
    ok(await p.locator('.gmenu-item', { hasText: 'Categories' }).isVisible(), `${dev}: open sections are remembered`);
    await p.evaluate(() => document.querySelector('.gmenu-item').click()); // keep the sheet; show a toast over it
    // Settings: grouped rows with their values; the clock switches in place.
    await p.locator('.gsheet-close').click().catch(() => {}); await p.waitForTimeout(250);
    await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(250);
    await p.locator('.gmenu-tile', { hasText: 'Settings' }).click(); await p.waitForTimeout(400);
    const titles = await p.locator('.gset-title').allTextContents();
    ok((await p.locator('.gsheet-title').textContent()) === 'Settings' && titles.join() === 'Appearance,Pay,AI,Account,Data', `${dev}: Settings groups (signed out): ${titles}`);
    ok(await p.locator('.gset-seg button[aria-pressed="true"]', { hasText: 'GUI' }).count() === 1, `${dev}: the current view is marked`);
    ok((await p.locator('.gset-row', { hasText: 'Save a full backup' }).locator('.gset-value').textContent()) === 'never on this device', `${dev}: backup shows when it was last saved`);
    await p.screenshot({ path: `${S}/menu-${dev}-settings.png` });
    const box = await p.locator('.gsheet').boundingBox(); const vp = p.viewportSize();
    ok(dev === 'phone' ? box.y <= 1 && box.height >= vp.height - 2 : box.height < vp.height * 0.7, `${dev}: Settings ${dev === 'phone' ? 'covers the whole screen' : 'stays a panel above the start bar'} (${Math.round(box.y)}+${Math.round(box.height)} of ${vp.height})`);
    await p.locator('.gset-seg button', { hasText: '24h' }).click(); await p.waitForTimeout(400);
    ok(await p.locator('.gset-seg button[aria-pressed="true"]', { hasText: '24h' }).count() === 1 && (await p.locator('.gsheet-title').textContent()) === 'Settings', `${dev}: 24h applies and Settings stays open`);
    await p.locator('.gset-seg button', { hasText: '12h' }).click(); await p.waitForTimeout(300);
    // Trash: deleted entries, each with Restore.
    await p.locator('.gsheet-close').click(); await p.waitForTimeout(250);
    await p.evaluate((t) => {
      const recs = JSON.parse(tymleeStorage.getItem('tymlee.v2.local.records') || '[]');
      recs.push({ id: 'trash-1', kind: 'trash', body: { entry: { id: 'gone', ts: t - 3600000, text: 'ZENITH gone soon', sid: 990 }, deletedAt: t - 60000 }, at: t - 60000 });
      tymleeStorage.setItem('tymlee.v2.local.records', JSON.stringify(recs));
      localStorage.setItem('tymlee.menuSection', 'Entries');
    }, Date.now() + 0);
    await p.reload(); await p.waitForTimeout(700);
    await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(250);
    await p.locator('.gmenu-item', { hasText: 'Trash' }).click(); await p.waitForTimeout(400);
    const listed = await p.locator('.gtrash-row .gtick-text').allTextContents();
    ok(listed.join() === 'dev first thing,ZENITH gone soon', `${dev}: Trash lists deleted entries, newest first (the undone start, then ours): ${listed}`);
    await p.screenshot({ path: `${S}/menu-${dev}-trash.png` });
    await p.locator('.gtrash-row', { hasText: 'ZENITH' }).locator('button', { hasText: 'Restore' }).click(); await p.waitForTimeout(500);
    const back = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).filter((e) => !e.deleted).map((e) => e.text));
    ok(back.includes('ZENITH gone soon') && (await p.locator('.gtrash-row').count()) === 1 && (await p.locator('.gsheet-title').textContent()) === 'Trash', `${dev}: Restore puts it back; the trash stays open: ${back}`);
    await ctx.close();
  }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
