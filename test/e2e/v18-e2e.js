const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (hm) => new Date(`2026-10-01T${hm}:00-04:00`).getTime();
const seed = [
  { id: 'a', ts: at('08:30'), text: 'admin email and planning' },
  { id: 'b', ts: at('09:00'), text: 'NORTHSTAR mix revisions', wo: '4471' },
  { id: 'd', ts: at('11:00'), text: 'ACME drawings review' },
  { id: 'g', ts: at('13:10'), text: 'NORTHSTAR stems for the label', wo: '4471' },
];
// A one-finger drag, as touch events (Playwright has taps, not drags).
async function drag(p, sel, dy, steps = 8) {
  await p.evaluate(async ({ sel, dy, steps }) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y0 = r.top + 30;
    const t = (y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(y0)], changedTouches: [t(y0)], bubbles: true, cancelable: true }));
    for (let i = 1; i <= steps; i++) {
      el.dispatchEvent(new TouchEvent('touchmove', { touches: [t(y0 + (dy * i) / steps)], changedTouches: [t(y0 + (dy * i) / steps)], bubbles: true, cancelable: true }));
      await new Promise((r2) => setTimeout(r2, 30));
    }
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(y0 + dy)], bubbles: true, cancelable: true }));
  }, { sel, dy, steps });
}
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 760 }, colorScheme: scheme, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await ctx.clock.install({ time: new Date('2026-10-01T13:40:00-04:00') });
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'pure'); }, seed);
    await p.reload(); await p.waitForTimeout(800);
    const tag = scheme;
    ok(await p.locator('.home-hint').isVisible(), `${tag}: Safari on an iPhone shows the Add to Home Screen hint`);
    await p.screenshot({ path: `${S}/v18-${tag}-hint.png` });
    await p.locator('.home-hint button').tap(); await p.waitForTimeout(200);
    await p.reload(); await p.waitForTimeout(700);
    ok(!(await p.locator('.home-hint').count()), `${tag}: once dismissed it stays away`);
    ok(await p.locator('.tabbar').isVisible() && await p.locator('#status').isHidden(), `${tag}: a tab bar instead of the status bar`);
    ok(await p.locator('.tab[aria-current="true"]').getAttribute('data-tab') === 'timeline', `${tag}: Timeline is the current tab`);
    await p.screenshot({ path: `${S}/v18-${tag}-tabs.png` });
    await p.locator('.tab[data-tab="todo"]').tap(); await p.waitForTimeout(400);
    ok((await p.locator('.gsheet-title').textContent()).startsWith('To-do') && await p.locator('.tab[aria-current="true"]').getAttribute('data-tab') === 'todo', `${tag}: To-do tab opens the list and lights up`);
    await drag(p, '.gsheet', 60); await p.waitForTimeout(400);
    ok(await p.locator('.gsheet').count() === 1, `${tag}: a short pull springs back`);
    await drag(p, '.gsheet', 200); await p.waitForTimeout(500);
    ok(await p.locator('.gsheet').count() === 0 && await p.locator('.tab[aria-current="true"]').getAttribute('data-tab') === 'timeline', `${tag}: a long pull closes the sheet`);
    await p.locator('.tab[data-tab="menu"]').tap(); await p.waitForTimeout(400);
    await p.locator('.gmenu-tile', { hasText: 'Settings' }).tap(); await p.waitForTimeout(400);
    ok(await p.locator('.gset-seg button', { hasText: '12h' }).isVisible() && await p.locator('.gset-seg button', { hasText: 'Hybrid' }).isVisible(), `${tag}: the clock and view switches are in Settings`);
    await p.screenshot({ path: `${S}/v18-${tag}-menu.png` });
    await p.locator('.gset-seg button', { hasText: '12h' }).tap(); await p.waitForTimeout(500);
    ok((await p.locator('.sb-what, .tl-times').first().textContent()) !== null && (await p.locator('.tl-hour').first().textContent()).match(/am|pm|a|p/), `${tag}: the clock switches`);
    await p.evaluate(() => { localStorage.setItem('tymlee.menuSection', ''); });
    ok(await p.locator('.tab[data-tab="find"]').evaluate((t) => document.elementFromPoint(t.getBoundingClientRect().x + 5, t.getBoundingClientRect().y + 5).closest('.gsheet-full') !== null), `${tag}: Settings covers the tabs`);
    await p.locator('.gsheet-close').tap(); await p.waitForTimeout(300);
    await p.locator('.tab[data-tab="find"]').tap(); await p.waitForTimeout(400);
    ok((await p.locator('.gsheet-title').textContent()) === 'Find', `${tag}: Find tab`);
    await p.locator('.gsheet-close').tap(); await p.waitForTimeout(300);
    // Pull to refresh (signed out).
    await drag(p, '#gui', 260, 12); await p.waitForTimeout(500);
    ok((await p.locator('.toast').last().textContent()).includes('Up to date'), `${tag}: pull down refreshes`);
    // Remembers week.
    await p.locator('.gui-presets button[title="Week"]').tap(); await p.waitForTimeout(300);
    await p.reload(); await p.waitForTimeout(700);
    ok(await p.locator('.gui-presets button[title="Week"]').getAttribute('aria-pressed') === 'true', `${tag}: Week is remembered`);
    await p.locator('.gui-presets button[title="Day"]').tap(); await p.waitForTimeout(300);
    // Launch screens and colors.
    ok(await p.evaluate(() => document.querySelectorAll('link[rel="apple-touch-startup-image"]').length) === 22, `${tag}: launch screens linked`);
    const bad = await p.evaluate(async () => { const out = []; for (const l of document.querySelectorAll('link[rel="apple-touch-startup-image"]')) { const r = await fetch(l.href); if (!r.ok) out.push(l.href); } return out; });
    ok(!bad.length, `${tag}: every launch screen exists ${bad}`);
    ok(await p.evaluate(() => getComputedStyle(document.querySelector('.sb-new')).webkitUserSelect || getComputedStyle(document.querySelector('.sb-new')).userSelect) === 'none', `${tag}: buttons aren't selectable`);
    await p.locator('.tab[data-tab="todo"]').tap(); await p.waitForTimeout(400);
    await p.screenshot({ path: `${S}/v18-${tag}-todo.png` });
    await ctx.close();
  }
  // Desktop: unchanged (no tab bar).
  const ctx = await b.newContext({ viewport: { width: 1100, height: 720 }, serviceWorkers: 'block' });
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  await p.goto('http://localhost:8123/index.html'); await p.evaluate(() => localStorage.setItem('tymlee.view2', 'pure')); await p.reload(); await p.waitForTimeout(600);
  ok(await p.locator('.tabbar').isHidden() && await p.locator('#status').isVisible() && await p.locator('.sb-menu').isVisible(), 'desktop: status bar and ☰ as before');
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
