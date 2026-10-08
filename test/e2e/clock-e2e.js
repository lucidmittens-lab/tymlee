const { chromium, devices } = require('playwright');
const S = process.argv[2];
const at = (d, hm) => new Date(`2026-09-${d}T${hm}:00-04:00`).getTime();
const seed = [
  { id: 'a', ts: at('25', '09:00'), text: 'dev payments api refactor', notes: 'root cause: expired token' },
  { id: 'b', ts: at('25', '11:30'), text: 'mtg standup' },
  { id: 'c', ts: at('25', '12:15'), text: 'NORTHSTAR quarterly review' },
];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  for (const [name, opts] of [['desktop', { viewport: { width: 1100, height: 700 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 700 } }], ['small', { ...devices['iPhone 13'], viewport: { width: 320, height: 640 } }]]) {
    const ctx = await b.newContext({ ...opts, timezoneId: 'America/New_York' });
    await ctx.clock.setFixedTime(new Date('2026-09-25T15:20:00-04:00'));
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate((rows) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(rows)); localStorage.setItem('tymlee.view2', 'gui'); }, seed);
    await p.reload(); await p.waitForTimeout(500);
    const pressed = async () => (await p.locator('.clock-toggle button[aria-pressed="true"]').textContent()).replace(/^(\d+)$/, '$1h');
    ok(await pressed() === '24h', `${name}: 24h by default`);
    ok((await p.locator('.tl-hour').first().textContent()).endsWith(':00'), `${name}: 24h axis`);
    await p.locator('.clock-toggle button', { hasText: '12' }).click();
    await p.waitForTimeout(300);
    ok(await pressed() === '12h', `${name}: switched to 12h`);
    const hours = await p.locator('.tl-hour').allTextContents();
    ok(hours.some((h) => /^\d{1,2}(am|pm)$/.test(h)), `${name}: 12h axis ${hours.slice(0, 3)}`);
    const tl = await p.locator('.tl-times').allTextContents();
    ok(tl.some((t) => t.startsWith('9:00am–11:30am')), `${name}: 12h block times ${tl[0]}`);
    // Stays after a reload (saved in settings).
    await p.reload(); await p.waitForTimeout(500);
    ok(await pressed() === '12h', `${name}: 12h kept after reload`);
    const r = await p.evaluate(() => {
      const st = document.getElementById('status');
      const kids = [...st.children].map((c) => c.getBoundingClientRect());
      let overlap = false;
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i], c = kids[j];
        if (a.width && c.width && a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) overlap = true;
      }
      return { overlap, scroll: document.documentElement.scrollWidth > innerWidth, rows: new Set(kids.filter((k) => k.width).map((k) => Math.round(k.top))).size };
    });
    ok(!r.overlap && !r.scroll, `${name}: status bar fits ${JSON.stringify(r)}`);
    await p.fill('#entry', '/report'); await p.press('#entry', 'Enter'); await p.waitForTimeout(300);
    await p.screenshot({ path: `${S}/clock-${name}.png` });
    await p.keyboard.press('Escape');
    await p.fill('#entry', '/clear'); await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
    await p.fill('#entry', '/log'); await p.press('#entry', 'Enter'); await p.waitForTimeout(300);
    const log = await p.locator('#out pre').last().textContent();
    ok(/ 9:00am( +11:30am)? +2:30/.test(log), `${name}: /log in 12h`);
    await p.fill('#entry', '/clock 24'); await p.press('#entry', 'Enter'); await p.waitForTimeout(300);
    ok((await p.locator('#out pre').last().textContent()).includes('clock: 24-hour, e.g. 15:20'), `${name}: /clock 24`);
    ok(await pressed() === '24h', `${name}: switch follows /clock`);
    await p.fill('#entry', '/clock 7'); await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
    ok((await p.locator('#out pre').last().textContent()).includes('usage'), `${name}: bad /clock explained`);
    ok(!errs.length, `${name}: no errors ${errs}`);
    await ctx.close();
  }
  await b.close();
})();
