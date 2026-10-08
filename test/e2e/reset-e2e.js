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
let settingsMissing = false;
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
    if (op === 'deleteAll') {
      if (a[0] !== uid) return { data: null, error: { message: 'row-level security' } };
      for (const [id, r] of entries) if (r.user_id === uid) entries.delete(id);
      return { data: null, error: null };
    }
  }
  if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
};



const UID = 'user-me@example.com';
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const device = async () => {
    const ctx = await b.newContext();
    await ctx.exposeFunction('fakeDb', fakeDb);
    await ctx.addInitScript(fake);
    await ctx.addInitScript(() => localStorage.setItem('tymlee.view2', 'cli'));
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(300);
    p.send = async (x, wait = 400) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
    p.out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
    p.last = async () => (await p.locator('#out pre').allTextContents()).slice(-1)[0];
    p.local = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.user-me@example.com.entries') || '[]').map((e) => e.text));
    p.signIn = async () => { await p.send('/login me@example.com'); await p.send('/code 123456', 1200); };
    return p;
  };
  const mine = () => [...entries.values()].filter((r) => r.user_id === UID);

  // An encrypted account with a log, on device A.
  const A = await device();
  await A.signIn();
  await A.send('dev old work one'); await A.send('mtg old work two'); await A.send('/rate 40', 800);
  await A.send('/sync', 1200);
  ok(keyring.has(UID) && keyring.get(UID).recovery.kid && mine().length === 2, 'account encrypted; the key has a fingerprint');
  const oldKid = keyring.get(UID).recovery.kid;

  // A new device, no way to unlock it.
  const B = await device();
  await B.signIn();
  ok((await B.out()).includes('/reset-encryption starts over'), 'a locked device mentions /reset-encryption');
  await B.send('dev typed while locked', 500);
  await B.send('/reset-encryption', 500);
  ok((await B.out()).includes('Your synced log and settings are deleted'), 'it explains what happens');
  await B.fill('#entry', 'delete'); await B.press('#entry', 'Enter'); await B.waitForTimeout(500);
  ok((await B.last()).includes('reset cancelled') && mine().length === 2 && keyring.get(UID).recovery.kid === oldKid, 'anything but DELETE cancels, nothing changes');
  await B.send('/reset-encryption', 500);
  await B.fill('#entry', 'DELETE'); await B.press('#entry', 'Enter'); await B.waitForTimeout(2500);
  ok((await B.out()).includes('encryption reset: this device has the new key') && /Your recovery key:/.test(await B.out()), 'DELETE resets, with a new recovery key');
  ok(keyring.get(UID).recovery.kid !== oldKid && keyring.get(UID).link === null, 'the account has a new key');
  const texts = mine().map((r) => r.text);
  ok(mine().length === 1 && texts.every((t) => /^\/e[12]\//.test(t)), `the old log is gone; the entry typed while locked is uploaded, encrypted (${mine().length} on the server)`);
  ok(/^\/e1\//.test(settings.get(UID)), 'settings replaced, encrypted with the new key');
  await B.send('/log all');
  ok((await B.last()).includes('typed while locked') && !(await B.last()).includes('old work'), 'this device shows its own entry only');
  await B.send('/reset-encryption');
  ok((await B.last()).includes('this device has the key'), 'a device with the key cannot reset');

  // Device A still has the old key: it notices, locks, and keeps its copy.
  await A.send('dev typed on the old device', 300);
  await A.send('/sync', 1500);
  ok((await A.out()).includes('Encryption for this account was reset on another device'), 'the old device notices the reset');
  ok(mine().length === 1, 'and uploads nothing with the old key');
  await A.send('/link', 400);
  ok((await A.last()).includes("doesn't have the key yet"), 'it is locked until linked');
  await B.send('/link', 1500);
  const code = [...(await B.out()).matchAll(/\/link ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/g)].map((m) => m[1]).filter((c) => c !== 'XXXX-XXXX-XXXX').pop();
  await A.send(`/link ${code}`, 3000);
  ok((await A.out()).includes('this device is set up'), 'linked with the new key');
  await B.send('/sync', 1500);
  await B.send('/log all');
  const log = await B.last();
  ok(['old work one', 'old work two', 'typed on the old device', 'typed while locked'].every((w) => log.includes(w)), 'the old device uploaded its copy of the log again');
  ok(mine().every((r) => /^\/e[12]\//.test(r.text)), 'everything on the server is encrypted');
  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
