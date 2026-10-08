const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (hm) => new Date(`2026-10-01T${hm}:00-04:00`).getTime();
const seed = [
  { id: 'a', ts: at('08:00'), text: 'NORTHSTAR mix revisions', wo: '4471' },
  { id: 'b', ts: at('10:00'), text: '/break-paid' },
  { id: 'c', ts: at('10:15'), text: 'ACME site survey' },
];
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [name, opts] of [['desktop', { viewport: { width: 1100, height: 820 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }]]) {
    const ctx = await b.newContext({ ...opts, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await ctx.clock.install({ time: new Date('2026-10-01T13:40:00-04:00') });
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'pure'); }, seed);
    await p.reload(); await p.waitForTimeout(1300);
    const tick = async () => { await p.clock.runFor(1100); await p.waitForTimeout(200); };
    const mode = () => p.locator('#startbar').getAttribute('data-mode');
    // Desktop: one Break (the kind used last) with ▾ for the other; phones: both.
    const take = async (kind) => {
      if (name === 'phone') return p.click(kind === 'paid' ? '.sb-paid' : '.sb-unpaid');
      await p.click('.sb-break-more'); await p.waitForTimeout(100);
      return p.click(`.sb-popup-item[data-kind="${kind}"]`);
    };
    ok(await mode() === 'running', 'working: the running card');
    await take('unpaid'); await tick();
    ok((await p.locator('#status').textContent()).includes('unpaid break') && await mode() === 'break', 'Unpaid break starts one; the bar shows the break');
    if (name === 'phone') ok(await p.locator('.sb-unpaid').isDisabled() && await p.locator('.sb-paid').isEnabled(), 'on an unpaid break: Paid still available');
    else {
      await p.click('.sb-break-more'); await p.waitForTimeout(100);
      ok(await p.locator('.sb-popup-item[data-kind="unpaid"]').isDisabled() && await p.locator('.sb-popup-item[data-kind="paid"]').isEnabled(), 'on an unpaid break: ▾ offers the paid kind');
      await p.click('.sb-break-more');
    }
    await p.clock.runFor(10 * 60000);
    await take('paid'); await tick();
    ok((await p.locator('#status').textContent()).includes('paid break'), 'switches to a paid break');
    if (name === 'phone') await p.screenshot({ path: `${S}/breakbtn-phone-onbreak.png` });
    if (name === 'desktop') {
      await p.click('.sb-back'); await tick();
      ok(await mode() === 'running', 'Back to work');
      await p.click('.sb-break-main'); await tick();
      ok((await p.locator('#status').textContent()).includes('paid break'), 'Break takes the kind used last');
    }
    await p.click('.sb-off'); await tick();
    ok(await mode() === 'idle', 'clocked off: the fields and Start');
    const texts = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).map((e) => e.text).slice(-3).join(','));
    ok(texts === (name === 'phone' ? '/break-unpaid,/break-paid,/off' : 'ACME site survey,/break-paid,/off'), `entries: ${texts}`);
    const fit = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.startbar button')].filter((x) => x.offsetParent).every((x) => x.getBoundingClientRect().right <= innerWidth + 0.5));
    ok(fit, `${name}: the bar fits`);
    await ctx.close();
  }
  ok(!errs.length, `no errors ${errs}`);
  await b.close();
})();
