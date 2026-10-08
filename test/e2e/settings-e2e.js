const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const entries = new Map();
const keyring = new Map();
let keyringMissing = false; // start as a server where the SQL hasn't been run
const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.keyring' in the schema cache" } };
const settings = new Map();
let settingsMissing = true;
const noSettings = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.settings' in the schema cache" } };
const fakeDb = (uid, table, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  if (table === 'settings') {
    if (settingsMissing) return noSettings;
    if (op === 'single') return { data: settings.has(uid) ? { data: settings.get(uid) } : null, error: null };
    if (op === 'upsert') {
      if (a[0].user_id !== uid) return { data: null, error: { message: 'row-level security' } };
      settings.set(uid, a[0].data);
      return { data: null, error: null };
    }
  }
  if (table === 'keyring') {
    if (keyringMissing) return missing;
    if (op === 'single') return { data: keyring.get(uid) || null, error: null };
    if (op === 'insert') {
      if (a[0].user_id !== uid) return { data: null, error: { message: 'row-level security' } };
      if (keyring.has(uid)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "keyring_pkey"' } };
      keyring.set(uid, { recovery: a[0].recovery, link: null });
      return { data: null, error: null };
    }
    if (op === 'update') {
      if (a[1] === uid && keyring.has(uid)) Object.assign(keyring.get(uid), a[0]);
      return { data: null, error: null };
    }
  }
  if (table === 'entries') {
    if (op === 'select') {
      const q = a[0];
      if (q.cols.includes('modified_at')) return { data: null, error: { code: '42703', message: 'column entries.modified_at does not exist' } };
      const since = q.gte ? q.gte[1] : null;
      const rows = [...entries.values()].filter((r) => r.user_id === uid && (since == null || r.ts >= since)).sort((x, y) => x.ts - y.ts);
      return { data: rows.slice(q.from, q.to + 1).map(({ id, ts, text }) => ({ id, ts, text })), error: null };
    }
    if (op === 'upsert') {
      for (const r of a[0]) {
        if (r.user_id !== uid || r.text.length > 8000) return { data: null, error: { message: 'rejected' } };
        entries.set(r.id, { ...r });
      }
      return { data: null, error: null };
    }
    if (op === 'delete') { for (const id of a[0]) if (entries.get(id)?.user_id === uid) entries.delete(id); return { data: null, error: null }; }
  }
  if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
};


const UID = 'user-me@example.com';
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const device = async (init) => {
    const ctx = await b.newContext();
    await ctx.exposeFunction('fakeDb', fakeDb);
    await ctx.addInitScript(fake);
    if (init) await ctx.addInitScript(init);
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(300);
    p.send = async (x, wait = 300) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
    p.out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
    p.last = async () => (await p.locator('#out pre').allTextContents()).slice(-1)[0];
    p.signIn = async () => { await p.send('/login me@example.com'); await p.send('/code 123456', 800); };
    return p;
  };
  const A = await device(() => localStorage.setItem('tymlee.view2', 'cli'));
  await A.signIn();
  await A.send('/encrypt', 800);
  await A.send('dev work');
  await A.send('/rate 30', 600);
  ok((await A.out()).includes('settings are kept on this browser until the server has the latest supabase/schema.sql'), 'before the SQL: explains the rate stays on this device');
  await A.waitForTimeout(1100);
  ok((await A.locator('#status').textContent()).includes('$'), 'the rate works right away');

  settingsMissing = false;
  await A.send('/sync', 1200);
  const stored = settings.get(UID);
  ok(stored && stored.startsWith('/e1/') && !stored.includes('"rate"') && !stored.includes(':30'), `after the SQL: uploaded, encrypted (${String(stored).slice(0, 12)}…)`);

  await A.send('/link', 600);
  const code = ((await A.out()).match(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/g) || []).pop();
  const B = await device(() => localStorage.setItem('tymlee.view2', 'cli'));
  await B.signIn();
  await B.send(`/link ${code}`, 1500);
  await B.send('/rate', 300);
  ok((await B.last()).includes('rate: $30.00 an hour'), `another device gets the rate: ${await B.last()}`);

  await B.send('/otmin 40', 800);
  await A.send('/sync', 1200);
  await A.send('/otmin');
  ok((await A.last()).includes('overtime after 40 hours'), 'and changes come back the other way');

  // Both change something before syncing: both changes are kept.
  await A.evaluate(() => { window.__offline = true; });
  await A.send('/otrate 2', 400);
  await B.send('/rate 35', 800);
  await A.evaluate(() => { window.__offline = false; });
  await A.send('/sync', 1500);
  await B.send('/sync', 1500);
  for (const [name, p] of [['A', A], ['B', B]]) {
    await p.send('/rate'); const rate = await p.last();
    await p.send('/otrate'); const f = await p.last();
    ok(rate.includes('$35.00') && f.includes('2×'), `${name}: both offline changes kept (${rate} / ${f})`);
  }

  await A.send('/logout', 800);
  ok(await A.evaluate(() => tymleeStorage.getItem('tymlee.v2.user-me@example.com.settings') === null), 'signing out removes the settings from the device');

  // The first test version kept pay on the device: it moves over.
  const C = await device(() => {
    localStorage.setItem('tymlee.view2', 'cli');
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('tymlee.pay', JSON.stringify({ rate: [{ from: 0, value: 22 }] }));
    }
  });
  await C.send('/rate');
  ok((await C.last()).includes('$22.00') && await C.evaluate(() => localStorage.getItem('tymlee.pay') === null), 'settings from the device-only version move over');
  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
