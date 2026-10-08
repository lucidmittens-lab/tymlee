const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const entries = new Map();
const keyring = new Map();
let v2 = false; // change-tracking columns present (the new SQL has run)
let lastStamp = 0;
const stamp = () => new Date((lastStamp = Math.max(Date.now(), lastStamp + 1))).toISOString();
const selects = []; // { uid, gte, rows }
const fakeDb = (uid, table, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  // plain@example.com stands for a server set up before encryption existed.
  if (table === 'keyring' && uid === 'user-plain@example.com') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.keyring'" } };
  if (table === 'keyring') {
    if (op === 'single') return { data: keyring.get(uid) || null, error: null };
    if (op === 'insert') {
      if (keyring.has(uid)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      keyring.set(uid, { recovery: a[0].recovery, link: null });
      return { data: null, error: null };
    }
    if (op === 'update') { if (a[1] === uid && keyring.has(uid)) Object.assign(keyring.get(uid), a[0]); return { data: null, error: null }; }
  }
  if (op === 'select') {
    const q = a[0];
    if (q.cols.includes('modified_at') && !v2) return { data: null, error: { code: '42703', message: 'column entries.modified_at does not exist' } };
    let rows = [...entries.values()].filter((r) => r.user_id === uid);
    if (q.gte) {
      const [col, v] = q.gte;
      rows = rows.filter((r) => (col === 'modified_at' ? Date.parse(r.modified_at) >= Date.parse(v) : r[col] >= v));
    }
    const by = q.order || 'id';
    rows.sort((x, y) => (x[by] < y[by] ? -1 : x[by] > y[by] ? 1 : 0));
    rows = rows.slice(q.from, q.to + 1);
    selects.push({ uid, gte: q.gte, rows: rows.length });
    const cols = q.cols.split(',');
    return { data: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), error: null };
  }
  if (op === 'upsert') {
    for (const r of a[0]) {
      if (r.user_id !== uid) return { data: null, error: { message: 'row-level security' } };
      if ('deleted' in r && !v2) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'deleted' column of 'entries' in the schema cache" } };
    }
    for (const r of a[0]) {
      const row = { ...(entries.get(r.id) || {}), ...r };
      if (v2) { row.modified_at = stamp(); if (row.deleted == null) row.deleted = false; }
      entries.set(r.id, row);
    }
    return { data: null, error: null };
  }
  if (op === 'delete') { for (const id of a[0]) if (entries.get(id)?.user_id === uid) entries.delete(id); return { data: null, error: null }; }
  if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
};

const UID = 'user-me@example.com';
const mine = () => [...entries.values()].filter((r) => r.user_id === UID);

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const device = async () => {
    const ctx = await b.newContext();
    await ctx.exposeFunction('fakeDb', fakeDb);
    await ctx.addInitScript(fake);
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(200);
    p.send = async (x, wait = 300) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
    p.out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
    p.until = async (re, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(await p.out())) return true; await p.waitForTimeout(100); } return false; };
    p.local = () => p.evaluate((k) => JSON.parse(tymleeStorage.getItem(k) || '[]'), `tymlee.v2.${UID}.entries`);
    p.routine = async () => { await p.evaluate(() => window.dispatchEvent(new Event('online'))); await p.waitForTimeout(600); };
    return p;
  };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

  // 1. Encrypted account on a server without change tracking: text only.
  const A = await device();
  await A.send('/login me@example.com'); await A.send('/code 123456', 800);
  await A.send('/encrypt', 300);
  ok(await A.until(/Your recovery key:/), 'encryption on (server without change tracking)');
  await A.send('dev fixing login bug'); await A.send('mtg standup'); await A.send('dev code review', 800);
  ok(mine().length === 3 && mine().every((r) => r.text.startsWith('/e1/') && r.ts > 0), 'text encrypted, start times still readable (as before)');

  // 2. The new SQL runs: the next full sync seals times too.
  v2 = true;
  await A.send('/sync', 300);
  ok(await waitFor(() => mine().every((r) => r.text.startsWith('/e2/') && r.ts === 0 && r.deleted === false)), 'after the SQL: every entry sealed, times hidden (ts = 0)');
  const aLocal = await A.local();
  ok(aLocal.length === 3 && aLocal.every((e) => e.ts > 1e12), 'this device still has the real times');

  // 3. Another device links and gets the right times.
  const B = await device();
  await B.send('/login me@example.com'); await B.send('/code 123456', 800);
  await A.send('/link', 1500);
  const code = (await A.out()).match(/\/link ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  await B.send(`/link ${code}`, 300);
  ok(await B.until(/this device is set up/), 'second device linked');
  await B.waitForTimeout(800);
  const same = (x, y) => JSON.stringify(x.map((e) => [e.id, e.ts, e.text])) === JSON.stringify(y.map((e) => [e.id, e.ts, e.text]));
  ok(same(await B.local(), await A.local()), 'second device has identical entries and times');

  // 4. Routine checks download only what changed.
  let n = selects.length;
  await B.routine();
  let routine = selects.slice(n).filter((s) => s.uid === UID);
  ok(routine.length > 0 && routine.every((s) => s.gte && s.gte[0] === 'modified_at'), 'routine check asks only for changes');
  console.log("routine selects:", JSON.stringify(routine));
  ok(routine.reduce((t, s) => t + s.rows, 0) <= 3, `nothing new: downloads ${routine.reduce((t, s) => t + s.rows, 0)} rows (only the overlap window)`);

  // 5. An addition, a time edit and a deletion on A reach B.
  await A.send('email inbox', 600);
  await A.send('/edit', 400);
  const ed = A.locator('#out .editor');
  const text = await ed.inputValue();
  const standup = aLocal.find((e) => e.text === 'mtg standup');
  const hm = (ts) => new Date(ts).toTimeString().slice(0, 5);
  const moved = standup.ts - 15 * 60000;
  // Move "mtg standup" 15 minutes earlier (same day assumed for the test), delete "dev code review".
  await ed.fill(text.replace(`${hm(standup.ts)}  mtg standup`, `${hm(moved)}  mtg standup`).replace(/^.*dev code review.*\n/m, ''));
  await A.send('/save', 800);
  ok(/saved: 1 changed, 1 removed/.test(await A.out()), 'edited a time and removed an entry on the first device');
  const codeReview = aLocal.find((e) => e.text === 'dev code review');
  ok(entries.get(codeReview.id).deleted === true && entries.get(codeReview.id).text === '/deleted', 'deletion leaves a content-free marker');
  n = selects.length;
  await B.routine();
  const bLocal = await B.local();
  routine = selects.slice(n).filter((s) => s.uid === UID);
  ok(bLocal.some((e) => e.text === 'email inbox'), 'addition arrives');
  ok(bLocal.find((e) => e.id === standup.id).ts === Math.floor(moved / 60000) * 60000, 'time edit arrives');
  ok(!bLocal.some((e) => e.id === codeReview.id), 'deletion arrives');
  ok(routine.reduce((t, s) => t + s.rows, 0) < mine().length + 1, `routine check downloaded ${routine.reduce((t, s) => t + s.rows, 0)} of ${mine().length} rows`);
  ok(mine().filter((r) => !r.deleted).every((r) => r.text.startsWith('/e2/') && r.ts === 0), 'everything on the server stays sealed');

  // 6. A tab on the previous version wraps a sealed entry again: repaired.
  const target = mine().find((r) => !r.deleted);
  const wrapped = await A.evaluate(async ({ k, id, text }) => {
    const key = await TymleeVault.importMasterKey(tymleeStorage.getItem(k));
    return TymleeVault.encryptText(key, id, text);
  }, { k: `tymlee.v2.${UID}.key`, id: target.id, text: target.text });
  Object.assign(target, { text: wrapped, ts: 0, modified_at: stamp() });
  const before = (await B.local()).find((e) => e.id === target.id);
  await B.routine(); await B.waitForTimeout(600);
  const after = (await B.local()).find((e) => e.id === target.id);
  ok(after && after.ts === before.ts && after.text === before.text, 'double-wrapped entry reads correctly');
  ok(await waitFor(() => entries.get(target.id).text.startsWith('/e2/')), 'and is stored sealed again');

  // 7. An account without encryption on the new server: plain, deletions still sync.
  const P1 = await device(); const P2 = await device();
  for (const p of [P1, P2]) { await p.send('/login plain@example.com'); await p.send('/code 123456', 800); }
  await P1.send('dev plain entry', 600);
  const plainRow = [...entries.values()].find((r) => r.user_id === 'user-plain@example.com');
  ok(plainRow && plainRow.text === 'dev plain entry' && plainRow.ts > 0, 'server without encryption: stored as before');
  await P2.routine();
  await P1.send('/undo', 600);
  await P2.routine();
  const p2 = await P2.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.user-plain@example.com.entries') || '[]'));
  ok(p2.length === 0, 'server without encryption: deletion reaches the other device');

  // 8. Rows unchanged for longer than the overlap window cost nothing.
  for (const r of entries.values()) r.modified_at = new Date(Date.parse(r.modified_at) - 10 * 60000).toISOString();
  await B.send('/sync', 800);
  n = selects.length;
  await B.routine();
  routine = selects.slice(n).filter((s) => s.uid === UID);
  ok(routine.length > 0 && routine.reduce((t, s) => t + s.rows, 0) === 0, 'routine check with nothing new downloads 0 rows');
  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
