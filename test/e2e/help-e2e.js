const { chromium } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1000, height: 900 }, serviceWorkers: 'block' });
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/'); await p.evaluate(() => localStorage.setItem('tymlee.view2', 'cli')); await p.reload(); await p.waitForTimeout(400);
  const send = async (t) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(150); };
  const last = () => p.locator('#out pre').last().textContent();
  for (const [typed, want] of [['/tods', '/todo or /todos'], ['/tdoo', '/todo'], ['/brek-paid', '/break-paid'], ['/fnid', '/find'], ['/lgo', '/log'], ['/xyzzy', '']]) {
    await send(typed);
    const t = await last();
    ok(want ? t.includes(`did you mean ${want}?`) : !t.includes('did you mean'), `${typed}: ${t}`);
  }
  await send('/help todo');
  const h = await last();
  ok(h.startsWith('To-dos and checklists:') && h.includes('/do <TD>') && !h.includes('/rate'), '/help todo shows one topic');
  await send('/help due');
  ok((await last()).startsWith('/due <TD> [day]'), `/help <command>: ${await last()}`);
  await send('/help');
  const all = await last();
  ok(all.includes('Entries  (/help entries)') && all.includes('Pay  (/help pay)') && all.includes('More  (/help more)'), '/help shows topics');
  await p.screenshot({ path: `${S}/v17-help.png`, fullPage: false });
  ok(!errs.length, 'no errors ' + errs.join('|'));
  await b.close();
})();
