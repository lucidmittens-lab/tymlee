const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (hm) => new Date(`2026-10-01T${hm}:00-04:00`).getTime();
const seed = [
  { id: 'a', ts: at('08:30'), text: 'admin email and planning' },
  { id: 'b', ts: at('09:00'), text: 'NORTHSTAR mix revisions', wo: '4471' },
  { id: 'c', ts: at('10:45'), text: '/break-paid' },
  { id: 'd', ts: at('11:00'), text: 'ACME drawings review' },
  { id: 'f', ts: at('12:45'), text: 'mtg client call' },
  { id: 'g', ts: at('13:10'), text: 'NORTHSTAR stems for the label', wo: '4471' },
];
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [dev, opts] of [['desk', { viewport: { width: 1100, height: 720 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await b.newContext({ ...opts, colorScheme: scheme, timezoneId: 'America/New_York', serviceWorkers: 'block' });
      await ctx.clock.install({ time: new Date('2026-10-01T13:40:00-04:00') });
      await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto('http://localhost:8123/index.html');
      await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'pure'); }, seed);
      await p.reload(); await p.waitForTimeout(700);
      const tag = `${dev}-${scheme}`;
      // Menu: one section at a time; a closed header goes back to muted.
      await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(250);
      await p.locator('.gmenu-section', { hasText: 'Reports' }).click(); await p.waitForTimeout(100);
      await p.locator('.gmenu-section', { hasText: 'Forms' }).click(); await p.waitForTimeout(100);
      ok(await p.locator('.gmenu-group.open').count() === 1 && (await p.locator('.gmenu-group.open .gmenu-section').textContent()) === 'Forms', `${tag}: one section open`);
      const colors = await p.evaluate(() => [...document.querySelectorAll('.gmenu-section')].map((h) => getComputedStyle(h).color));
      const muted = await p.evaluate(() => getComputedStyle(document.querySelector('.gsheet-close')).color);
      const reports = await p.locator('.gmenu-section', { hasText: 'Reports' }).evaluate((h) => getComputedStyle(h).color);
      if (dev === 'phone') ok(reports === muted, `${tag}: a closed header is muted again after a tap (${reports} vs ${muted})`);
      if (dev === 'desk' && scheme === 'light') await p.screenshot({ path: `${S}/v171-${tag}-menu.png` });
      if (dev === 'phone' && scheme === 'dark') await p.screenshot({ path: `${S}/v171-${tag}-menu.png` });
      await p.keyboard.press('Escape'); await p.locator('.gsheet-close').click().catch(() => {}); await p.waitForTimeout(250);
      // Zoom.
      const gui = p.locator('#gui');
      const fits = await gui.evaluate((g) => g.scrollHeight <= g.clientHeight + 2);
      ok(fits, `${tag}: at Fit the day fits (no scrolling)`);
      const h1 = await p.locator('.tl-day').evaluate((d) => d.offsetHeight);
      await p.locator('.gz-btn[aria-label="Zoom in"]').click(); await p.waitForTimeout(200);
      await p.locator('.gz-btn[aria-label="Zoom in"]').click(); await p.waitForTimeout(200);
      const h2 = await p.locator('.tl-day').evaluate((d) => d.offsetHeight);
      ok(h2 > h1 * 2 && await gui.evaluate((g) => g.scrollHeight > g.clientHeight), `${tag}: zoom in makes it taller and it scrolls (${h1} → ${h2})`);
      ok(await p.locator('.gz-fit').isVisible(), `${tag}: Fit appears when zoomed`);
      await p.screenshot({ path: `${S}/v171-${tag}-zoom.png` });
      await p.reload(); await p.waitForTimeout(700);
      ok(Math.abs(await p.locator('.tl-day').evaluate((d) => d.offsetHeight) - h2) < 3, `${tag}: zoom is remembered`);
      await p.locator('.gz-fit').click(); await p.waitForTimeout(200);
      ok(await gui.evaluate((g) => g.scrollHeight <= g.clientHeight + 2) && await p.locator('.gz-fit').isHidden(), `${tag}: Fit goes back`);
      if (dev === 'desk' && scheme === 'light') {
        await gui.hover(); await p.keyboard.down('Control'); await p.mouse.wheel(0, -400); await p.keyboard.up('Control'); await p.waitForTimeout(300);
        ok(await gui.evaluate((g) => g.scrollHeight > g.clientHeight), 'Ctrl+scroll zooms');
        await p.locator('.gz-fit').click(); await p.waitForTimeout(200);
      }
      // Accent.
      await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(250);
      await p.locator('.gmenu-tile', { hasText: 'Settings' }).click(); await p.waitForTimeout(350);
      await p.locator('.gset-row', { hasText: 'Accent color' }).click(); await p.waitForTimeout(400);
      ok(await p.locator('.gaccent-swatch').count() === 9 && await p.locator('.gaccent-swatch.on', { hasText: 'indigo' }).count() === 1, `${tag}: 8 swatches and a custom one; indigo chosen`);
      await p.locator('.gaccent-swatch', { hasText: 'teal' }).click(); await p.waitForTimeout(500);
      const accent = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
      ok(accent === (scheme === 'dark' ? '#2dd4bf' : '#0f766e'), `${tag}: teal applies (${accent})`);
      if (dev === 'desk' || scheme === 'dark') await p.screenshot({ path: `${S}/v171-${tag}-accent-sheet.png` });
      await p.keyboard.press('Escape'); await p.locator('.gsheet-close').click().catch(() => {}); await p.waitForTimeout(300);
      await p.screenshot({ path: `${S}/v171-${tag}-teal.png` });
      await p.reload(); await p.waitForTimeout(700);
      ok(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) === accent, `${tag}: the accent is kept (saved in settings)`);
      await ctx.close();
    }
  }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
