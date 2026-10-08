const { chromium, devices } = require('playwright');
const S = process.argv[2];
const scheme = process.argv[3] || 'light';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (hm) => new Date(`2026-10-01T${hm}:00-04:00`).getTime();
const seed = [
  { id: 'a', ts: at('08:30'), text: 'admin email and planning' },
  { id: 'b', ts: at('09:00'), text: 'NORTHSTAR mix revisions', wo: '4471', notes: 'vocals up 1 dB' },
  { id: 'c', ts: at('10:45'), text: '/break-paid' },
  { id: 'd', ts: at('11:00'), text: 'ACME drawings review' },
  { id: 'e', ts: at('12:15'), text: '/break-unpaid' },
  { id: 'f', ts: at('12:45'), text: 'mtg client call' },
  { id: 'g', ts: at('13:10'), text: '/off' },
];
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [dev, opts] of [['desk', { viewport: { width: 1100, height: 720 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }]]) {
    const ctx = await b.newContext({ ...opts, colorScheme: scheme, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await ctx.clock.install({ time: new Date('2026-10-01T13:40:00-04:00') });
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'pure'); }, seed);
    await p.reload(); await p.waitForTimeout(700);
    const shot = async (n) => { await p.waitForTimeout(250); await p.screenshot({ path: `${S}/bar-${dev}-${scheme}-${n}.png` }); };
    const mode = () => p.locator('#startbar').getAttribute('data-mode');
    const entries = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries') || '[]').map((e) => e.text));
    ok(await mode() === 'idle', `${dev}: off → idle`);
    await shot('1-idle');
    await p.click('.sb-resume'); await p.waitForTimeout(300);
    ok((await entries()).slice(-1)[0] === 'mtg client call' && await mode() === 'running', `${dev}: Resume restarts the last task`);
    await ctx.clock.runFor(30 * 60000); await p.waitForTimeout(1100);
    await shot('2-running');
    await p.click('.sb-new'); await p.waitForTimeout(150);
    ok(await mode() === 'compose' && await p.evaluate(() => document.activeElement.getAttribute('aria-label') === 'Category'), `${dev}: New task → compose, category focused`);
    await p.keyboard.type('AC'); await p.waitForTimeout(150);
    await shot('3-compose');
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.waitForTimeout(150);
    ok(await mode() === 'running', `${dev}: Esc cancels`);
    await p.click('.sb-new'); await p.fill('.sb-cat input', 'ACME'); await p.fill('.sb-title', 'drawings'); await p.click('.sb-start'); await p.waitForTimeout(350);
    ok((await entries()).slice(-1)[0] === 'ACME drawings' && await mode() === 'running', `${dev}: Switch starts the new task`);
    await shot('4-switched');
    if (dev === 'desk') {
      await p.click('.sb-break-more'); await p.waitForTimeout(150);
      await shot('5-breakmenu');
      await p.click('.sb-popup-item[data-kind="unpaid"]'); await p.waitForTimeout(300);
      ok((await entries()).slice(-1)[0] === '/break-unpaid', 'desk: ▾ → Unpaid break');
    } else {
      await p.click('.sb-unpaid'); await p.waitForTimeout(300);
      ok((await entries()).slice(-1)[0] === '/break-unpaid', 'phone: Unpaid');
    }
    ok(await mode() === 'break', `${dev}: break mode`);
    await ctx.clock.runFor(4 * 60000); await p.waitForTimeout(1100);
    await shot('6-break');
    await p.click('.sb-back'); await p.waitForTimeout(300);
    ok((await entries()).slice(-1)[0] === 'ACME drawings' && await mode() === 'running', `${dev}: Back to work`);
    // to-do running
    await p.evaluate(() => localStorage.setItem('tymlee.view2', 'cli')); await p.reload(); await p.waitForTimeout(500);
    await p.fill('#entry', '/todo NORTHSTAR send the label the stems due:today'); await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
    await p.fill('#entry', '/do 10'); await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
    await p.evaluate(() => localStorage.setItem('tymlee.view2', 'pure')); await p.reload(); await p.waitForTimeout(700);
    ok(await p.locator('.sb-td').textContent() === 'TD:000010' && !(await p.locator('.sb-done').isDisabled()), `${dev}: linked to-do shows, Done on`);
    await shot('7-todo');
    await p.click('.sb-done'); await p.waitForTimeout(300);
    ok(await p.locator('.sb-done').isDisabled() && (await entries()).slice(-1)[0] === 'NORTHSTAR send the label the stems', `${dev}: Done keeps the timer`);
    await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await shot('8-menu');
    await ctx.close();
  }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
