// 2.0.2's safeguards: confirming the recovery key, keys kept out of history,
// warnings about changes that haven't synced or a log only in this browser,
// entries from two offline devices interleaving, Report a problem, and
// /midnight split.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const U = 'tymlee.v2.user-me@example.com.';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const entries = new Map();
const keyring = new Map();
const settings = new Map();
const fakeDb = (uid, table, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  if (table === 'settings') {
    if (op === 'single') return { data: settings.has(uid) ? { data: settings.get(uid) } : null, error: null };
    if (op === 'upsert') { settings.set(uid, a[0].data); return { data: null, error: null }; }
  }
  if (table === 'keyring') {
    if (op === 'single') return { data: keyring.get(uid) || null, error: null };
    if (op === 'insert') {
      if (keyring.has(uid)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      keyring.set(uid, { recovery: a[0].recovery, link: null });
      return { data: null, error: null };
    }
    if (op === 'update') { if (a[1] === uid && keyring.has(uid)) Object.assign(keyring.get(uid), a[0]); return { data: null, error: null }; }
  }
  if (table === 'entries') {
    if (op === 'select') {
      const q = a[0];
      if (q.cols.includes('modified_at')) return { data: null, error: { code: '42703', message: 'column entries.modified_at does not exist' } };
      const since = q.gte ? q.gte[1] : null;
      const rows = [...entries.values()].filter((r) => r.user_id === uid && (since == null || r.ts >= since)).sort((x, y) => x.ts - y.ts);
      return { data: rows.slice(q.from, q.to + 1).map(({ id, ts, text }) => ({ id, ts, text })), error: null };
    }
    if (op === 'upsert') { for (const r of a[0]) entries.set(r.id, { ...r }); return { data: null, error: null }; }
    if (op === 'delete') { for (const id of a[0]) entries.delete(id); return { data: null, error: null }; }
  }
  if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
};

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const device = async (opts = {}) => {
    const ctx = await b.newContext({ ...opts, serviceWorkers: 'block' });
    await ctx.exposeFunction('fakeDb', fakeDb);
    await ctx.addInitScript(fake);
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { errs.push(e.message); if (!/boom/.test(e.message)) console.log(e.stack); });
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(300);
    p.send = async (x, wait = 300) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
    p.out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
    p.ctx = ctx;
    return p;
  };

  // ---- the recovery key ----------------------------------------------------
  const A = await device();
  await A.send('ACME drawings');
  await A.send('/login me@example.com'); await A.send('/code 123456', 2500);
  const shown = (await A.out()).match(/([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})/);
  ok(shown && /confirm it: \/recovery check/.test(await A.out()), 'the recovery key comes with how to confirm it');
  const key = shown[1];
  await A.send('/recovery check AAAAA-AAAAA-AAAAA-AAAAA', 1500);
  ok(/isn't this account's current recovery key/.test(await A.out()), 'a wrong key is refused');
  // Not confirmed, a day later: a reminder.
  await A.evaluate((u) => tymleeStorage.setItem(`${u}recoveryNag`, '1'), U);
  await A.send('/sync', 1500);
  ok(/haven't confirmed that your recovery key is saved/.test(await A.out()), 'a reminder once a day until it is confirmed');
  await A.send(`/recovery check ${key}`, 1500);
  ok(/recovery key confirmed/.test(await A.out()), 'the right key is confirmed');
  await A.send('/history-probe', 100);
  // Up arrow: the key isn't in the history.
  await A.press('#entry', 'ArrowUp'); await A.press('#entry', 'ArrowUp');
  const recalled = await A.inputValue('#entry');
  ok(!/recovery check/.test(recalled), `a line with the key stays out of history (Up gives "${recalled}")`);
  await A.fill('#entry', '');
  await A.evaluate((u) => tymleeStorage.setItem(`${u}recoveryNag`, '1'), U);
  const before = (await A.out()).split("haven't confirmed").length;
  await A.send('/sync', 1500);
  ok((await A.out()).split("haven't confirmed").length === before, 'no more reminders once confirmed');
  ok([...settings.values()].length === 1, 'confirmed is kept with the (encrypted) settings, for every device');
  // The Settings page shows it.
  await A.evaluate(() => localStorage.setItem('tymlee.view2', 'pure')); await A.reload(); await A.waitForTimeout(1500);
  await A.click('.sb-menu'); await A.waitForTimeout(250);
  await A.locator('.gmenu-tile', { hasText: 'Settings' }).click(); await A.waitForTimeout(400);
  ok((await A.locator('.gset-row', { hasText: 'Recovery key' }).locator('.gset-value').textContent()) === 'saved', 'Settings: Recovery key · saved');
  await A.screenshot({ path: `${S}/safety-settings.png` });
  await A.locator('.gsheet-close').click(); await A.waitForTimeout(200);
  await A.evaluate(() => localStorage.setItem('tymlee.view2', 'cli')); await A.reload(); await A.waitForTimeout(1500);

  // ---- two devices offline at once ---------------------------------------------
  const B = await device();
  await B.send('/login me@example.com'); await B.send('/code 123456', 2000);
  await A.send('/link', 1500);
  const code = (await A.out()).match(/\/link ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  await B.send(`/link ${code}`, 2500);
  ok(/this device is set up/.test(await B.out()), 'a second device is linked');
  ok(!/haven't confirmed/.test(await B.out()), 'it knows the recovery key was confirmed');
  await B.evaluate(() => { window.__offline = true; });
  await B.send('NORTHSTAR mix', 400);
  await A.send('ZENITH call', 800);
  await B.send('NORTHSTAR stems', 400);
  // B's changes have waited a while (as if offline for an hour).
  await B.evaluate((u) => tymleeStorage.setItem(`${u}unsentSince`, String(Date.now() - 3600000)), U);
  await B.evaluate(() => { window.__offline = false; });
  await B.send('/sync', 2500);
  ok(/another device logged entries in the same hours/.test(await B.out()), 'interleaved entries from two offline devices are pointed out');
  const other = (await B.out()).split('another device logged entries').length;
  await B.send('MOJO edit', 400); await B.send('/sync', 1500);
  ok((await B.out()).split('another device logged entries').length === other, 'an ordinary sync says nothing');

  // ---- changes that haven't synced for days ---------------------------------------
  await B.evaluate(() => { window.__offline = true; });
  await B.send('TLWH notes', 400);
  await B.evaluate((u) => { tymleeStorage.setItem(`${u}unsentSince`, String(Date.now() - 3 * 86400000)); localStorage.removeItem('tymlee.dataWarned'); }, U);
  await B.waitForTimeout(800); // written through to IndexedDB
  await B.ctx.addInitScript(() => { window.__offline = true; }); // still offline after reloading
  await B.reload(); await B.waitForTimeout(2000);
  ok(/1 change hasn't reached the server for 3 days/.test(await B.out()), 'changes stuck for days: a warning');
  await B.reload(); await B.waitForTimeout(2000);
  ok(!/reached the server for/.test(await B.out()), 'at most once a day');
  await B.ctx.close();

  // ---- a log only in this browser ---------------------------------------------------
  const L = await device({ ...devices['iPhone 13'] });
  await L.evaluate(() => {
    const t = Date.now() - 10 * 86400000;
    tymleeStorage.setItem('tymlee.v2.local.entries', JSON.stringify([{ id: 'x', ts: t, text: 'OOB prep', sid: 10 }, { id: 'y', ts: t + 3600000, text: '/off', sid: 20 }]));
    localStorage.setItem('tymlee.view2', 'pure');
    localStorage.setItem('tymlee.homeHint', '1');
  });
  await L.waitForTimeout(600); await L.reload(); await L.waitForTimeout(1500);
  const toasts = (await L.locator('.toast').allTextContents()).join(' ');
  ok(/only in this browser/.test(toasts), `signed out, no backup: a warning, shown in the GUI (${toasts.slice(0, 80)})`);
  await L.screenshot({ path: `${S}/safety-only-here.png` });

  // ---- Report a problem -------------------------------------------------------------
  await L.evaluate(() => setTimeout(() => { null.boom(); }, 0)); await L.waitForTimeout(200);
  await L.locator('.tab[data-tab="menu"]').tap(); await L.waitForTimeout(300);
  await L.locator('.gmenu-section', { hasText: 'Help' }).tap(); await L.waitForTimeout(150);
  await L.locator('.gmenu-item', { hasText: 'Report a problem' }).tap(); await L.waitForTimeout(400);
  const report = await L.inputValue('.gproblem-text');
  ok(/^tymlee problem report\nversion \d+\.\d+\.\d+/.test(report) && /iOS, Safari/.test(report), 'the report has the version and the kind of device');
  ok(/page: TypeError/.test(report), 'and the error that just happened');
  ok(!/OOB/.test(report), 'and nothing from the log');
  ok(await L.locator('.gsheet button', { hasText: 'Copy' }).isVisible() && await L.locator('.gsheet button', { hasText: 'Open a GitHub issue' }).isVisible(), 'Copy and Open a GitHub issue');
  await L.screenshot({ path: `${S}/safety-problem.png` });
  await L.ctx.close();

  // ---- /midnight split ---------------------------------------------------------------
  const N = await device();
  await N.evaluate(() => {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const t = day.getTime();
    tymleeStorage.setItem('tymlee.v2.local.entries', JSON.stringify([
      { id: 'n1', ts: t - 2 * 3600000, text: 'OOB night shift', sid: 10 },
      { id: 'n2', ts: t + 3 * 3600000, text: '/off', sid: 20 },
    ]));
  });
  await N.waitForTimeout(600); await N.reload(); await N.waitForTimeout(800);
  await N.send('/report today', 300);
  ok(/no entries \(today\)/.test(await N.out()), 'by default a night shift counts on the day it started');
  await N.send('/midnight split', 300);
  await N.send('/report today', 300);
  ok(/OOB\s+3:00/.test(await N.out()), `split: today gets its 3 hours (${(await N.out()).split('\n').filter((l) => /OOB/.test(l)).pop()})`);
  await N.send('/report yesterday', 300);
  ok(/OOB\s+2:00/.test(await N.out()), 'and yesterday its 2');
  await N.send('/midnight', 200);
  ok(/past midnight: split/.test(await N.out()), '/midnight shows the setting');
  // The timeline: today shows the shift's part after midnight.
  await N.evaluate(() => localStorage.setItem('tymlee.view2', 'pure')); await N.reload(); await N.waitForTimeout(1200);
  ok(await N.locator('.tl-block.tl-cont').count() === 1 && /from \d\d-\d\d 22:00/.test(await N.locator('.tl-block.tl-cont').textContent()), 'the timeline draws the part after midnight, with when it started');
  await N.screenshot({ path: `${S}/safety-night.png` });
  await N.ctx.close();

  ok(!errs.filter((e) => !/boom/.test(e)).length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
