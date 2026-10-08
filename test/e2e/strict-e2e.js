const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const entries = new Map();
const keyring = new Map();
let keyringMissing = true; // start as a server where the SQL hasn't been run
const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.keyring' in the schema cache" } };
const fakeDb = (uid, table, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
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
// What a real config gets: no allowUnencrypted, so a server without the
// keyring (or one claiming not to have it) never gets plain text, and plain
// rows the server hands back are not trusted.
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const device = async () => {
    const ctx = await b.newContext();
    await ctx.exposeFunction('fakeDb', fakeDb);
    await ctx.addInitScript(() => { window.__strict = true; });
    await ctx.addInitScript(fake);
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(200);
    p.send = async (x, wait = 200) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
    p.out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
    p.last = async () => (await p.locator('#out pre').allTextContents()).slice(-1)[0];
    p.until = async (re, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(await p.out())) return true; await p.waitForTimeout(100); } return false; };
    p.sync = () => p.locator('#status .sync').textContent();
    p.local = (uid = UID) => p.evaluate((k) => JSON.parse(tymleeStorage.getItem(k) || '[]'), `tymlee.v2.${uid}.entries`);
    p.signIn = async (email = 'me@example.com') => { await p.send(`/login ${email}`); await p.send('/code 123456', 600); };
    return p;
  };

  // 1. The server says there is no keyring: nothing is uploaded.
  const A = await device();
  await A.send('ACME drawings');
  await A.signIn();
  await A.send('/import', 600);
  await A.send('mtg standup', 600);
  ok([...entries.values()].length === 0, `no keyring: nothing reaches the server (${entries.size})`);
  ok((await A.out()).includes("Sync is off: this server isn't set up for encryption"), 'and it says why');
  await A.send('/whoami');
  ok((await A.last()).includes("not synced: the server isn't set up for encryption"), '/whoami says so');

  // 2. The keyring appears: encryption turns on, everything goes up encrypted.
  keyringMissing = false;
  await A.send('/sync', 1500);
  ok(await A.until(/Your recovery key:/), 'then encryption turns on by itself');
  await A.send('/sync', 800);
  const mine = [...entries.values()].filter((r) => r.user_id === UID);
  ok(mine.length >= 2 && mine.every((r) => r.text.startsWith('/e1/') || r.text.startsWith('/e2/')), `all of it encrypted (${mine.map((r) => r.text.slice(0, 4)).join(',')})`);

  // 3. A plain row appears on the server (not written by this account's key).
  entries.set('planted', { id: 'planted', user_id: UID, ts: Date.now() - 60000, text: 'EVIL planted entry' });
  await A.send('/sync', 1200);
  ok(!(await A.local()).some((e) => e.text.includes('planted')), 'a plain row from the server is not trusted');
  ok(/1 entry on the server wasn't encrypted, so it was ignored/.test(await A.out()), 'and it says so');
  ok([...entries.values()].find((r) => r.id === 'planted').text === 'EVIL planted entry', 'it is not re-uploaded as if it were ours');

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
