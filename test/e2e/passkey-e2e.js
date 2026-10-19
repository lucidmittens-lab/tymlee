// Passkeys: sign in with one, and unlock the encrypted log with it (the
// WebAuthn PRF extension), using Chromium's virtual authenticator.
const { chromium } = require('playwright');
const fs = require('fs');
const { execFileSync } = require('child_process');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---- the fake server ---------------------------------------------------------
const entries = new Map();
const keyring = new Map();
const settings = new Map();
let passkeyColumn = true; // false: a server without the latest schema.sql
const fakeDb = (uid, table, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  if (table === 'settings') {
    if (op === 'single') return { data: settings.has(uid) ? { data: settings.get(uid) } : null, error: null };
    if (op === 'upsert') { settings.set(uid, a[0].data); return { data: null, error: null }; }
  }
  if (table === 'keyring') {
    if (op === 'single') {
      const cols = (a[0] && a[0].cols) || '';
      if (cols.includes('passkeys') && !passkeyColumn) return { data: null, error: { code: '42703', message: 'column keyring.passkeys does not exist' } };
      const row = keyring.get(uid);
      return { data: row ? { ...row, passkeys: row.passkeys || [] } : null, error: null };
    }
    if (op === 'insert') {
      if (keyring.has(uid)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      keyring.set(uid, { recovery: a[0].recovery, link: null, passkeys: [] });
      return { data: null, error: null };
    }
    if (op === 'update') {
      if ('passkeys' in a[0] && !passkeyColumn) return { data: null, error: { code: '42703', message: 'column keyring.passkeys does not exist' } };
      if (a[1] === uid && keyring.has(uid)) Object.assign(keyring.get(uid), a[0]);
      return { data: null, error: null };
    }
  }
  if (table === 'entries') {
    if (op === 'select') {
      const q = a[0];
      if (q.cols.includes('modified_at')) return { data: null, error: { code: '42703', message: 'column entries.modified_at does not exist' } };
      const rows = [...entries.values()].filter((r) => r.user_id === uid).sort((x, y) => x.ts - y.ts);
      return { data: rows.slice(q.from, q.to + 1).map(({ id, ts, text }) => ({ id, ts, text })), error: null };
    }
    if (op === 'upsert') { for (const r of a[0]) entries.set(r.id, { ...r }); return { data: null, error: null }; }
    if (op === 'delete') { for (const id of a[0]) entries.delete(id); return { data: null, error: null }; }
  }
  if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
};

// Supabase's passkey endpoints (signatures aren't checked here; the browser
// side and what is sent are what's tested).
const passkeys = new Map(); // credential id -> { pid, user, name, created }
const sent = []; // every credential the browser sent
let n = 0;
const fakePasskeys = (op, user, p) => {
  const challenge = b64u(require('crypto').randomBytes(32));
  if (op === 'regStart') {
    if (!user) return { data: null, error: { message: 'Auth session missing!' } };
    return { data: { challenge_id: `r${++n}`, expires_at: 0, options: {
      challenge, rp: { id: 'localhost', name: 'tymlee' }, user: { id: b64u(user.id), name: user.email, displayName: user.email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 60000,
      excludeCredentials: [...passkeys.entries()].filter(([, v]) => v.user.id === user.id).map(([id]) => ({ id, type: 'public-key' })),
    } }, error: null };
  }
  if (op === 'regVerify') {
    sent.push(p.credential);
    const pid = `pk-${++n}`;
    passkeys.set(p.credential.id, { pid, user, name: '', created: new Date().toISOString() });
    return { data: { id: pid, created_at: new Date().toISOString() }, error: null };
  }
  if (op === 'authStart') return { data: { challenge_id: `a${++n}`, expires_at: 0, options: { challenge, rpId: 'localhost', userVerification: 'required', timeout: 60000 } }, error: null };
  if (op === 'authVerify') {
    sent.push(p.credential);
    const k = passkeys.get(p.credential.id);
    if (!k) return { data: null, error: { message: 'Passkey not found' } };
    k.used = new Date().toISOString();
    return { data: { user: k.user }, error: null };
  }
  const mine = [...passkeys.entries()].filter(([, v]) => user && v.user.id === user.id);
  if (op === 'list') return { data: mine.map(([, v]) => ({ id: v.pid, friendly_name: v.name, created_at: v.created, last_used_at: v.used })), error: null };
  if (op === 'update') { for (const [, v] of mine) if (v.pid === p.passkeyId) v.name = p.friendlyName; return { data: null, error: null }; }
  if (op === 'delete') { for (const [id, v] of mine) if (v.pid === p.passkeyId) passkeys.delete(id); return { data: null, error: null }; }
  return { data: null, error: { message: `unexpected passkey ${op}` } };
};

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const ctx = await b.newContext({ serviceWorkers: 'block' });
  await ctx.exposeFunction('fakeDb', fakeDb);
  await ctx.exposeFunction('fakePasskeys', (op, user, p) => fakePasskeys(op, user, p));
  await ctx.addInitScript(() => { window.__strict = true; }); // encryption required, as on tymlee.date
  await ctx.addInitScript(fake);
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  // A platform authenticator with PRF, like iCloud Keychain on an iPhone or Mac.
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
  } });
  await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(300);
  const send = async (x, wait = 400) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
  const out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
  const enc = () => p.evaluate(() => document.getElementById('status').textContent);
  const UID = 'user-me@example.com';

  // An account with encryption and an entry.
  await send('/login me@example.com'); await send('/code 123456', 2500);
  ok(/Your recovery key:/.test(await out()), 'signed in by email; encryption on');
  await send('ACME drawings', 800); await send('/sync', 1000);

  // Add a passkey.
  await send('/passkey', 500);
  ok(/no passkeys yet/.test(await out()), '/passkey: none yet');
  await send('/passkey add', 2500);
  ok(/passkey added: it signs you in and unlocks your log/.test(await out()), `/passkey add: signs in and unlocks (${(await out()).split('\n').slice(-2).join(' | ')})`);
  const row = keyring.get(UID);
  const raw = await p.evaluate((k) => tymleeStorage.getItem(k), `tymlee.v2.${UID}.key`);
  ok(row.passkeys.length === 1 && row.passkeys[0].pid && row.passkeys[0].kid && !JSON.stringify(row.passkeys).includes(raw), 'the server keeps one passkey copy of the key, locked (the key itself is not in it)');
  ok(sent.every((c) => JSON.stringify(c.clientExtensionResults) === '{}') && !JSON.stringify(sent).includes('prf'), 'the PRF secret is never sent to the server');
  ok([...passkeys.values()][0].name !== '', 'the passkey is named after the device');
  await send('/passkey', 500);
  ok(/1 {2}.*signs in and unlocks/.test(await out()), '/passkey lists it: signs in and unlocks');

  // A "new device": signed out, nothing on this browser; the passkey syncs.
  await send('/logout', 800);
  ok(!(await p.evaluate((k) => tymleeStorage.getItem(k), `tymlee.v2.${UID}.key`)), 'signed out: no key on this device');
  await p.evaluate(() => localStorage.setItem('tymlee.view2', 'pure')); await p.reload(); await p.waitForTimeout(800);
  await p.click('.sb-menu'); await p.waitForTimeout(250);
  await p.locator('.gmenu-tile', { hasText: 'Settings' }).click(); await p.waitForTimeout(400);
  await p.locator('.gset-row', { hasText: 'Sign in' }).click(); await p.waitForTimeout(300);
  ok(await p.locator('.gform-passkey').isVisible(), 'Sign in offers a passkey first');
  await p.screenshot({ path: `${S}/passkey-signin.png` });
  await p.locator('.gform-passkey').click(); await p.waitForTimeout(3000);
  const texts = await p.evaluate((k) => JSON.parse(tymleeStorage.getItem(k) || '[]').map((e) => e.text), `tymlee.v2.${UID}.entries`);
  ok(texts.includes('ACME drawings'), `one passkey touch: signed in, unlocked, the log decrypted (${texts.join(', ')})`);
  ok((await p.locator('.toast').allTextContents()).join(' ').includes('unlocked with your passkey'), 'and it says so');
  await p.screenshot({ path: `${S}/passkey-unlocked.png` });

  // Signed in by email on a device without the key: unlock with the passkey.
  await p.evaluate(() => localStorage.setItem('tymlee.view2', 'cli')); await p.reload(); await p.waitForTimeout(800);
  await send('/logout', 800);
  await send('/login me@example.com'); await send('/code 123456', 2000);
  ok(/Or, if you added a passkey that unlocks: \/passkey unlock/.test(await out()), 'locked: points to /passkey unlock');
  await send('/passkey unlock', 2500);
  ok(/unlocked with your passkey/.test(await out()) && /this device has the key/.test(await (async () => { await send('/whoami', 300); return out(); })()), '/passkey unlock unlocks it');

  // An unexpected sign-out is said, and kept for Report a problem.
  await p.evaluate(() => window.supabase.createClient().auth.signOut()); await p.waitForTimeout(600);
  ok(/you were signed out: the session ended/.test(await out()), 'a sign-out nobody asked for is pointed out');
  await send('/problem', 600);
  ok(/last unexpected sign-out: /.test(await out()), 'and shows in the problem report');

  // Removing it: it no longer signs in, and its copy of the key is gone.
  await send('/passkey login', 2500);
  await send('/passkey remove 1', 800);
  ok(keyring.get(UID).passkeys.length === 0 && passkeys.size === 0, '/passkey remove deletes the passkey and its copy of the key');

  // A server without the latest schema.sql: a clear message.
  passkeyColumn = false;
  await send('/passkey add', 1200);
  ok(/passkeys need the latest supabase\/schema\.sql/.test(await out()), 'without the schema update: says what is needed');
  passkeyColumn = true;

  // The terminal app: no passkeys there.
  const home = `${S}/cli-home-passkey`;
  fs.rmSync(home, { recursive: true, force: true });
  const cli = execFileSync('node', ['cli/tymlee.js', '/passkey'], { encoding: 'utf8', env: { ...process.env, TYMLEE_HOME: home, TYMLEE_CLIENT_MODULE: `${S}/fake-client.js`, TYMLEE_SUPABASE_URL: 'https://fake.supabase.co', TYMLEE_SUPABASE_KEY: 'anon' } });
  ok(/passkeys work in the website/.test(cli), `the terminal app says passkeys are for the website (${cli.trim()})`);

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
