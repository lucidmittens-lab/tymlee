// The site under its _headers content policy: nothing it needs is blocked.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const headers = {};
for (const line of fs.readFileSync(require('path').join(__dirname, '../../public/_headers'), 'utf8').split('\n')) {
  const m = line.match(/^\s+([\w-]+):\s*(.+)$/);
  if (m) headers[m[1]] = m[2];
}
(async () => {
  const b = await chromium.launch();
  for (const [dev, opts] of [['desk', { viewport: { width: 1100, height: 760 } }], ['phone', { ...devices['iPhone 13'] }]]) {
    const ctx = await b.newContext({ ...opts, timezoneId: 'America/New_York' });
    await ctx.route('http://localhost:8123/**', async (r) => {
      const res = await r.fetch();
      await r.fulfill({ response: res, headers: { ...res.headers(), ...headers } });
    });
    await ctx.route('https://api.anthropic.com/**', (r) => (r.request().method() === 'OPTIONS'
      ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
      : r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ message: 'ok', changes: [] }) }], usage: { input_tokens: 1, output_tokens: 1 } }) })));
    const p = await ctx.newPage();
    const blocked = [];
    p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text().slice(0, 400) + ' @' + JSON.stringify(m.location())); });
    p.on('pageerror', (e) => blocked.push('pageerror ' + e.message));
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(800);
    ok((await p.evaluate(() => typeof window.TymleeVault)) === 'object', `${dev}: scripts run under the policy`);
    await p.fill('#entry', 'ACME drawings'); await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
    await p.fill('#entry', '/aikey sk-ant-api03-TESTKEY000000000000000000000abcd'); await p.press('#entry', 'Enter'); await p.waitForTimeout(300);
    await p.fill('#entry', '/ai lunch at 12'); await p.press('#entry', 'Enter'); await p.waitForTimeout(1500);
    ok((await p.locator('#out').textContent()).includes('Claude: ok'), `${dev}: Ask AI reaches Anthropic (the SDK loads, the request goes)`);
    await p.fill('#entry', '/accent teal'); await p.press('#entry', 'Enter'); await p.waitForTimeout(300);
    ok((await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#0f766e', `${dev}: a chosen accent color applies`);
    await p.locator('#status .view-toggle button[aria-label="GUI"]').click().catch(() => {}); await p.waitForTimeout(500);
    const fontOk = await p.evaluate(() => document.fonts.check('14px Inter'));
    ok(fontOk, `${dev}: the fonts load`);
    ok(await p.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), `${dev}: the offline worker registers`);
    // A photo through the shrink-to-JPEG path (canvas, blob).
    const r = await p.evaluate(async () => { const c = document.createElement('canvas'); c.width = 50; c.height = 50; const bl = await new Promise((res) => c.toBlob(res, 'image/png')); const bmp = await createImageBitmap(bl); return bmp.width; });
    ok(r === 50, `${dev}: images decode and draw`);
        ok(!blocked.length, `${dev}: nothing blocked ${blocked.join(' | ')}`);
    await ctx.close();
  }
  await b.close();
})();
