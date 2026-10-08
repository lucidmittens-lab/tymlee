const { chromium } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(300);
  // An older version's log, in local storage.
  await p.evaluate(() => {
    const now = Date.now();
    localStorage.setItem('tymlee.v2.local.entries', JSON.stringify([{ id: 'a', ts: now - 3600e3, text: 'dev from local storage' }]));
    localStorage.setItem('tymlee.view2', 'cli');
  });
  await p.reload(); await p.waitForTimeout(500);
  ok((await p.locator('#out').textContent()).includes('from local storage'), 'the old log is still there');
  const moved = await p.evaluate(() => ({ ls: localStorage.getItem('tymlee.v2.local.entries'), view: localStorage.getItem('tymlee.view2'), kind: tymleeStorage.kind }));
  ok(moved.ls === null && moved.view === 'cli' && moved.kind === 'IndexedDB', `moved to IndexedDB, view setting left: ${JSON.stringify(moved)}`);
  // Survives a reload from IndexedDB alone.
  await p.fill('#entry', 'mtg after the move'); await p.press('#entry', 'Enter'); await p.waitForTimeout(300);
  await p.reload(); await p.waitForTimeout(500);
  ok((await p.locator('#out').textContent()).includes('after the move'), 'new entries kept across a reload');
  // A log far past local storage's 5 MB: 40,000 entries with notes (~12 MB).
  const big = await p.evaluate(async () => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 40000; i++) rows.push({ id: `big${i}`, ts: now - (40000 - i) * 600000, text: `cat${i % 12} entry number ${i}`, notes: 'x'.repeat(250) });
    tymleeStorage.setItem('tymlee.v2.local.entries', JSON.stringify(rows));
    await tymleeStorage.flushed();
    return tymleeStorage.getItem('tymlee.v2.local.entries').length;
  });
  ok(big > 10e6, `stored ${(big / 1e6).toFixed(1)} MB`);
  const t0 = Date.now();
  await p.reload(); await p.waitForFunction(() => document.querySelector('#out pre'));
  await p.waitForTimeout(800);
  const loadMs = Date.now() - t0;
  await p.fill('#entry', 'dev one more on top'); await p.press('#entry', 'Enter'); await p.waitForTimeout(800);
  const after = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).length);
  ok(after === 40001, `adding to a big log saves (${after} entries; reload took ${loadMs} ms)`);
  ok(!(await p.locator('#out pre.err').count()), 'no storage warnings');
  await p.fill('#entry', '/log week'); await p.press('#entry', 'Enter'); await p.waitForTimeout(500);
  await p.screenshot({ path: `${S}/idb-big-log.png` });
  // Another tab sees changes.
  const p2 = await ctx.newPage();
  await p2.goto('http://localhost:8123/index.html'); await p2.waitForTimeout(1500);
  await p.fill('#entry', 'email from tab one'); await p.press('#entry', 'Enter'); await p.waitForTimeout(1500);
  ok((await p2.locator('#status').textContent()).includes('email from tab one'), 'the other tab picks the change up');
  ok(!errs.length, `no errors ${errs}`);
  await b.close();
})();
