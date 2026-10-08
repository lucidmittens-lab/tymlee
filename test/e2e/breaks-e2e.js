const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (d, hm) => new Date(`2026-${d}T${hm}:00-04:00`).getTime();
// Thursday 2026-10-01 at 13:40. Last Friday and Monday are in "week" but
// only Monday is in "calweek" (Sunday 09-27 to Saturday 10-03).
const seed = [
  ['09-25', '09:00', 'NORTHSTAR rack install'], ['09-25', '12:00', '/off'],
  ['09-28', '09:00', 'ACME site survey'], ['09-28', '11:00', '/off'],
  ['10-01', '08:00', 'NORTHSTAR commissioning'], ['10-01', '10:00', '/break-paid'],
  ['10-01', '10:15', 'NORTHSTAR commissioning'], ['10-01', '12:00', '/break-unpaid'],
  ['10-01', '12:45', 'ACME drawings'],
].map(([d, hm, text], i) => ({ id: `s${i}`, ts: at(d, hm), text }));
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [name, opts] of [['desktop', { viewport: { width: 1100, height: 820 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }]]) {
    const ctx = await b.newContext({ ...opts, timezoneId: 'America/New_York' });
    await ctx.clock.install({ time: new Date('2026-10-01T13:40:00-04:00') });
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await ctx.addInitScript(() => { new MutationObserver(() => document.querySelectorAll('.gmenu-group:not(.open)').forEach((g) => g.classList.add('open'))).observe(document, { childList: true, subtree: true }); }); // tests: every menu section open
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'cli'); }, seed);
    await p.reload(); await p.waitForTimeout(600);
    const send = async (t) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(250); };
    const last = () => p.locator('#out pre').last().textContent();
    const status = () => p.locator('#status').textContent();
    if (name === 'desktop') {
      await send('/break-unpaid');
      ok(/13:40 {2}out ACME \(0:55\) {2}unpaid break · your next entry ends it/.test(await last()), `/break-unpaid: ${await last()}`);
      ok((await status()).includes('■ unpaid break'), 'status shows the unpaid break');
      await send('/break-unpaid');
      ok((await last()).includes('already on an unpaid break since 13:40'), `twice: ${await last()}`);
      await send('/note lunch with the client');
      ok((await last()).includes('notes saved on ID:000100 unpaid break'), `/note during an unpaid break goes on the break: ${await last()}`);
      await p.clock.runFor(10 * 60000);
      await send('/break-paid');
      ok((await last()).includes('out of unpaid break (0:10)  paid break'), `/break-paid: ${await last()}`);
      await send('/note coffee');
      ok((await last()).includes('notes saved on ID:000110 paid break'), `/note during a paid break goes on the break: ${await last()}`);
      await p.clock.runFor(5 * 60000);
      await p.waitForTimeout(1100);
      ok(/▶ 0:05:\d\d/.test(await status()) && (await status()).includes('paid break'), `status counts a paid break: ${await status()}`);
      await send('ACME drawings again');
      ok((await last()).includes('out of paid break (0:05)'), `next entry ends the paid break: ${await last()}`);
      await send('/undo'); // back to the paid break running
      ok((await last()).includes('resumed paid break'), `undo: ${await last()}`);
      await send('/clear');
      await send('/report calweek');
      const rep = await last();
      ok(rep.includes('report: calweek (2026-09-28 .. 2026-10-01)') && !rep.includes('rack install'), `calweek: only this Sunday-Saturday week: ${rep.split('\n')[0]}`);
      ok(/\(paid break\) +0:20/.test(rep) && !/unpaid break\) +\d/.test(rep), 'paid breaks count, unpaid ones don\'t');
      await send('/report week');
      ok((await last()).includes('rack install'), 'week: the last 7 days');
      await send('/report calmonth');
      ok((await last()).includes('report: calmonth (2026-10-01'), 'calmonth: this month');
      await send('/clear');
      await send('/log');
      await p.screenshot({ path: `${S}/breaks-desktop-log.png` });
      await send('/clear');
      await send('/report calweek');
      await p.screenshot({ path: `${S}/breaks-desktop-calweek.png` });
    }
    await p.evaluate(() => localStorage.setItem('tymlee.view2', 'gui')); await p.reload(); await p.waitForTimeout(700);
    await p.screenshot({ path: `${S}/breaks-${name}-hybrid.png` });
    await p.evaluate(() => localStorage.setItem('tymlee.view2', 'pure')); await p.reload(); await p.waitForTimeout(700);
    await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(200);
    await p.screenshot({ path: `${S}/breaks-${name}-menu.png` });
    if (name === 'phone') {
      await p.locator('.gmenu button', { hasText: 'Categories' }).click(); await p.waitForTimeout(200);
      await p.screenshot({ path: `${S}/breaks-phone-ranges.png` });
      await p.locator('.gform-range', { hasText: 'This week' }).click();
      await p.click('.gform-go'); await p.waitForTimeout(400);
      ok((await p.locator('.gsheet-text').allTextContents()).join('').includes('calweek'), 'GUI: This week works');
    } else {
      await p.locator('.gmenu button', { hasText: 'Unpaid break' }).click(); await p.waitForTimeout(400);
      ok((await p.locator('#status').textContent()).includes('■ unpaid break'), 'GUI menu: Unpaid break');
    }
    await ctx.close();
  }
  ok(!errs.length, `no errors ${errs}`);
  await b.close();
})();
