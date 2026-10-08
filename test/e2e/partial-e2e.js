const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const UID = 'user-me@example.com';
const DAY = 86400000;
const now = Date.now();
const db = new Map();
// 60 days of history, 4 entries a day.
for (let d = 60; d >= 0; d--) for (let k = 0; k < 4; k++) {
  const id = `e${d}-${k}`;
  db.set(id, { id, user_id: UID, ts: now - d * DAY - (4 - k) * 3600e3, text: `dev day ${d} task ${k}` });
}
const selects = [];
const fakeDb = (uid, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  if (op === 'select') {
    const since = a[2];
    const rows = [...db.values()].filter((r) => r.user_id === uid && (since == null || r.ts >= since)).sort((x, y) => x.ts - y.ts);
    const pageRows = rows.slice(a[0], a[1] + 1);
    selects.push({ since, rows: pageRows.length });
    return { data: pageRows.map(({ id, ts, text }) => ({ id, ts, text })), error: null };
  }
  if (op === 'upsert') { for (const r of a[0]) db.set(r.id, { ...r }); return { data: null, error: null }; }
  if (op === 'delete') { for (const id of a[0]) db.delete(id); return { data: null, error: null }; }
};
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  await ctx.exposeFunction('fakeDb', fakeDb);
  await ctx.addInitScript(fake);
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(200);
  const send = async (x) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(200); };
  const local = () => p.evaluate((k) => JSON.parse(tymleeStorage.getItem(k) || '[]'), `tymlee.v2.${UID}.entries`);
  const byId = async () => new Map((await local()).map((e) => [e.id, e]));
  const routine = async () => { await p.evaluate(() => window.dispatchEvent(new Event('online'))); await p.waitForTimeout(300); };
  const total = db.size;

  await send('/login me@example.com'); await send('/code 123456'); await p.waitForTimeout(300);
  let last = selects[selects.length - 1];
  ok(last.since == null && (await local()).length === total, `sign-in downloads everything (${total} entries)`);

  // Another device changes things.
  db.get('e0-1').text = 'dev day 0 task 1 (edited elsewhere)';      // recent edit
  db.delete('e1-2');                                                  // recent delete
  db.set('x1', { id: 'x1', user_id: UID, ts: now - 3600e3 + 1, text: 'mtg added elsewhere' }); // recent add
  db.get('e40-0').text = 'dev day 40 task 0 (edited elsewhere)';     // old edit
  db.get('e2-0').ts = now - 45 * DAY;                                 // moved from recent to old

  const before = selects.length;
  await routine();
  const partial = selects.slice(before);
  const partialRows = partial.reduce((n, s) => n + s.rows, 0);
  ok(partial.length > 0 && partial.every((s) => s.since != null), 'routine check asks only for recent entries');
  ok(partialRows < 70, `routine check downloads ${partialRows} rows instead of ${db.size}`);
  let m = await byId();
  ok(m.get('e0-1').text.includes('edited elsewhere'), 'recent edit arrives');
  ok(!m.has('e1-2'), 'recent delete arrives');
  ok(m.has('x1'), 'recent addition arrives');
  ok(!m.get('e40-0').text.includes('edited elsewhere'), 'old edit waits for a full download (expected)');
  ok(!m.has('e2-0'), 'entry moved into the past is hidden until a full download (expected)');

  // Queued local change survives a routine check.
  await p.evaluate(() => { window.__offline = true; });
  await send('email while offline');
  await p.evaluate(() => { window.__offline = false; });
  await routine();
  m = await byId();
  ok([...m.values()].some((e) => e.text === 'email while offline') && [...db.values()].some((e) => e.text === 'email while offline'), 'offline entry sent and kept');

  const beforeFull = selects.length;
  await send('/sync');
  ok(selects.slice(beforeFull).some((s) => s.since == null), '/sync does a full download');
  m = await byId();
  ok(m.get('e40-0').text.includes('edited elsewhere') && m.has('e2-0'), 'full download brings in the old edit and the moved entry');
  ok(JSON.stringify([...m.keys()].sort()) === JSON.stringify([...db.keys()].sort()), 'local log matches the account exactly');

  await p.reload(); await p.waitForTimeout(400);
  ok(selects[selects.length - 1].since == null || selects.slice(-3).some((s) => s.since == null), 'page load does a full download');
  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
