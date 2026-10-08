const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const entries = new Map();
const keyring = new Map();
let v2 = true; // change-tracking columns present (the new SQL has run)
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
  const ids = (list) => list.filter((e) => !e.text.startsWith('/wo ')).map((e) => `${e.sid || '-'}:${e.text}`).join(' | ');

  // 1. An account from before IDs: device A runs without numbering.
  const A = await device();
  await A.evaluate(() => { window.__realAssign = Tymlee.assignIds; Tymlee.assignIds = () => ({ changed: [], renumbered: 0 }); });
  await A.send('/login me@example.com'); await A.send('/code 123456', 800);
  await A.send('/encrypt', 300);
  ok(await A.until(/Your recovery key:/), 'encryption on');
  await A.send('dev fixing login bug'); await A.send('mtg standup'); await A.send('dev code review', 1200);
  ok(ids(await A.local()) === '-:dev fixing login bug | -:mtg standup | -:dev code review', `no IDs yet: ${ids(await A.local())}`);

  // 2. Device B (this version) links: numbers the log once, by position.
  const B = await device();
  await B.send('/login me@example.com'); await B.send('/code 123456', 800);
  await A.send('/link', 1500);
  const code = (await A.out()).match(/\/link ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  await B.send(`/link ${code}`, 300);
  ok(await B.until(/this device is set up/), 'second device linked');
  ok(await waitFor(async () => ids(await B.local()) === '10:dev fixing login bug | 20:mtg standup | 30:dev code review'), `numbered by position x10: ${ids(await B.local())}`);
  ok(await waitFor(() => entries.size === 3 && [...entries.values()].every((r) => r.text.startsWith('/e2/') && !r.text.includes('"i"'))), 'uploaded, still sealed');

  // 3. A gets this version: it downloads the same IDs.
  await A.evaluate(() => { Tymlee.assignIds = window.__realAssign; });
  await A.send('/sync', 1500);
  ok(ids(await A.local()) === ids(await B.local()), `both devices agree: ${ids(await A.local())}`);
  await A.send('/log', 300);
  ok(/ ID:000010  \d\d:\d\d .*fixing login bug/.test(await A.out()), '/log shows the IDs');

  // 4. A new entry: the next ten. Short IDs work in commands.
  await A.send('email inbox', 300);
  ok((await A.out()).includes('in ID:000040 email inbox'), 'new entry gets 000040');
  await A.send('/note #20 ran long', 300);
  ok((await A.out()).includes('notes saved on ID:000020'), '/note #20 means 000020');
  await A.send('/sync', 1500); await B.send('/sync', 1500);

  // 5. Both offline, both add an entry: both pick 000050; syncing fixes it.
  await A.evaluate(() => { window.__offline = true; });
  await B.evaluate(() => { window.__offline = true; });
  await A.send('dev from the laptop', 400);
  await B.send('dev from the phone', 400);
  const la = ids(await A.local()); const lb = ids(await B.local());
  ok(la.endsWith('50:dev from the laptop') && lb.endsWith('50:dev from the phone'), `offline, both used 000050 (${la.split(' | ').pop()} / ${lb.split(' | ').pop()})`);
  await A.evaluate(() => { window.__offline = false; });
  await B.evaluate(() => { window.__offline = false; });
  await A.send('/sync', 1500); await B.send('/sync', 1500); await A.send('/sync', 1500); await B.send('/sync', 1500);
  const fa = ids(await A.local()); const fb = ids(await B.local());
  ok(fa === fb, `agree after syncing: ${fa}`);
  const sids = fa.split(' | ').map((x) => x.split(':')[0]);
  ok(new Set(sids).size === sids.length, 'no ID used twice');
  ok(/had the same ID as one made on another device/.test((await A.out()) + (await B.out())), 'the renumbering is mentioned');
  // 6. /edit: an entry added before the first one takes 000001 (the free
  // numbers before 000010); the rest keep theirs.
  await A.send('/edit', 300);
  const box = A.locator('#out .editor');
  const t = await box.inputValue();
  const header = t.split('\n').find((l) => /^\w{3} \d{4}-\d\d-\d\d$/.test(l));
  await box.fill(t.replace(header, `${header}\n00:00 dev early start`));
  await box.press('Control+Enter'); await A.waitForTimeout(400);
  const early = (await A.local()).find((e) => e.text === 'dev early start');
  ok(early && early.sid === 1, `added before the first: ${early && early.sid}`);
  ok(ids(await A.local()).includes('10:dev fixing login bug'), 'the others keep their IDs');
  await A.send('/clear'); await A.send('/log', 400);
  await A.screenshot({ path: `${S}/ids-log.png` });
  ok(!errs.length, `no page errors ${errs}`);
  await b.close();
})();
