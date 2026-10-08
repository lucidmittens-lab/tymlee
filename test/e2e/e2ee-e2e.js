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
const now = Date.now();
// Entries uploaded before encryption existed (plain text).
['dev secret project alpha', 'mtg salary review', 'email dentist'].forEach((text, i) =>
  entries.set(`old${i}`, { id: `old${i}`, user_id: UID, ts: now - (5 - i) * 3600e3, text }));

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
    p.send = async (x, wait = 200) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
    p.out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
    p.last = async () => (await p.locator('#out pre').allTextContents()).slice(-1)[0];
    p.until = async (re, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(await p.out())) return true; await p.waitForTimeout(100); } return false; };
    p.sync = () => p.locator('#status .sync').textContent();
    p.local = (uid = UID) => p.evaluate((k) => JSON.parse(tymleeStorage.getItem(k) || '[]'), `tymlee.v2.${uid}.entries`);
    p.signIn = async (email = 'me@example.com') => { await p.send(`/login ${email}`); await p.send('/code 123456', 600); };
    return p;
  };
  const serverPlain = () => [...entries.values()].filter((r) => r.user_id === UID && !r.text.startsWith('/e1/'));
  const serverLeaks = (word) => [...entries.values()].some((r) => r.text.includes(word));

  // 1. Deployed before the SQL: works as before, unencrypted.
  const A = await device();
  await A.signIn();
  await A.send('/whoami');
  ok((await A.last()).includes('not encrypted: the server is not set up'), 'before the SQL: sync works unencrypted');
  ok((await A.local()).length === 3, 'before the SQL: existing entries load');

  // 2. SQL run: the next full sync offers /encrypt; nothing is encrypted until then.
  // A second device already signed in on the old server.
  const Z = await device();
  await Z.signIn();
  keyringMissing = false;
  await A.send('/sync', 600);
  ok(await A.until(/Your recovery key:/), 'after the SQL: encryption turns on by itself, with a recovery key');
  ok((await A.out()).includes('end-to-end encrypted'), 'and says what that means');
  await A.send('/encrypt', 300);
  ok((await A.last()).includes('already on'), '/encrypt explains it is already on');
  const recovery = (await A.out()).match(/[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}/)[0];
  ok(keyring.size === 1 && !JSON.stringify(keyring.get(UID)).includes(recovery), 'keyring stored, recovery key not sent to the server');
  const deadline = Date.now() + 8000;
  while (serverPlain().length && Date.now() < deadline) await A.waitForTimeout(100);
  ok(serverPlain().length === 0 && !serverLeaks('salary'), 'existing plain-text entries re-uploaded encrypted');
  await A.send('dev new private thing', 500);
  ok(!serverLeaks('private thing') && [...entries.values()].length === 4, 'new entry stored encrypted');
  await A.send('/log all');
  ok((await A.last()).includes('salary review') && (await A.last()).includes('new private thing'), 'this device still reads everything');

  await Z.send('/sync', 1200);
  ok(await Z.until(/doesn't have the key yet/) && (await Z.sync()).startsWith('locked'), 'a device open while encryption turned on becomes locked on its next sync');

  // 3. A second device is locked until linked; nothing leaks meanwhile.
  const B = await device();
  await B.signIn();
  ok(await B.until(/doesn't have the key yet/), 'second device: told it is locked');
  ok((await B.sync()).startsWith("locked"), `second device: status "${await B.sync()}"`);
  await B.send('dev typed while locked', 400);
  ok(!serverLeaks('typed while locked') && [...entries.values()].length === 4, 'locked device uploads nothing');
  await B.send('/link ABCD-EFGH-JKMN', 400);
  ok((await B.last()).includes('no active link code'), 'link before /link on the other device is refused');
  await A.send('/link', 1500);
  const linkCode = (await A.out()).match(/\/link ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  ok(keyring.get(UID).link && !JSON.stringify(keyring.get(UID)).includes(linkCode), 'link stored locked, code not sent');
  await B.send('/link ZZZZ-ZZZZ-ZZZZ', 1500);
  ok(await B.until(/that link code is not right/), 'wrong link code refused');
  await B.send(`/link ${linkCode.toLowerCase().replace(/-/g, ' ')}`, 300);
  ok(await B.until(/this device is set up/), 'correct link code (typed loosely) unlocks');
  await B.waitForTimeout(800);
  const bTexts = (await B.local()).map((e) => e.text);
  ok(['salary review', 'new private thing', 'typed while locked'].every((w) => bTexts.some((t) => t.includes(w))), 'second device reads everything, keeps what it typed');
  ok(!serverLeaks('typed while locked') && [...entries.values()].length === 5, 'its queued entry uploaded encrypted');
  ok(keyring.get(UID).link === null, 'link code used up');
  await B.send('/sync', 600);
  ok((await B.sync()) === 'synced', 'second device synced');

  // 4. Recovery key, and replacing it.
  const C = await device();
  await C.signIn();
  await C.send('/recover 00000-00000-00000-00000', 1500);
  ok(await C.until(/that recovery key is not right/), 'wrong recovery key refused');
  await C.send(`/recover ${recovery}`, 300);
  ok(await C.until(/this device is set up/), 'recovery key unlocks a new device');
  await A.send('/recovery', 1500);
  const newRecovery = (await A.out()).match(/new recovery key[\s\S]*?([0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5})/)[1];
  const D = await device();
  await D.signIn();
  await D.send(`/recover ${recovery}`, 1500);
  ok(await D.until(/that recovery key is not right/), 'old recovery key stops working after /recovery');
  await D.send(`/recover ${newRecovery}`, 300);
  ok(await D.until(/this device is set up/), 'new recovery key works');

  // 5. An old-version tab uploads plain text: the next sync encrypts it.
  entries.set('fromOldTab', { id: 'fromOldTab', user_id: UID, ts: Date.now(), text: 'dev from an old tab' });
  await A.send('/sync', 1500);
  ok(!serverLeaks('from an old tab'), 'plain text from an old tab gets encrypted');

  // 6. Tampering: swapping ciphertext between entries is detected.
  const [r1, r2] = [...entries.values()].filter((r) => r.user_id === UID).slice(0, 2);
  [r1.text, r2.text] = [r2.text, r1.text];
  await C.send('/sync', 800);
  ok(await C.until(/2 entries could not be decrypted/), 'swapped ciphertext is detected and hidden');

  // 7. A new account signs in on two devices at the same moment: one key.
  const E = await device();
  const F = await device();
  await Promise.all([E.signIn('new@example.com'), F.signIn('new@example.com')]);
  await E.waitForTimeout(2500);
  const shown = [await E.out(), await F.out()];
  ok(keyring.has('user-new@example.com') && shown.filter((o) => /Your recovery key:/.test(o)).length === 1 && shown.filter((o) => /doesn't have the key yet/.test(o)).length === 1,
    'new account on two devices at once: exactly one key, the other device is asked to link');
  ok(![...entries.values()].some((r) => r.user_id === 'user-new@example.com' && !/^\/e[12]\//.test(r.text)), 'nothing uploaded unencrypted meanwhile');
  // A new account types right after signing in, before its key exists.
  const G = await device();
  await G.signIn('fresh@example.com');
  await G.send('dev typed straight away', 50);
  await G.waitForTimeout(2500);
  const fresh = [...entries.values()].filter((r) => r.user_id === 'user-fresh@example.com');
  ok(fresh.length === 1 && /^\/e[12]\//.test(fresh[0].text) && !serverLeaks('straight away'), 'an entry typed before the key exists is uploaded only once encrypted');

  // 8. Sign out removes the key from the browser.
  await B.send('/logout', 600);
  ok(!(await B.evaluate(() => Object.keys(localStorage).some((k) => k.endsWith('.key')))), 'logout removes the key from this browser');

  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
