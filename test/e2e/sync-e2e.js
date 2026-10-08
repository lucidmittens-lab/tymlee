const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase.js`, 'utf8');
const db = new Map(); // id -> row
const selects = []; // every download: { since, rows }
const fakeDb = (uid, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  if (op === 'select') {
    const since = a[2];
    const rows = [...db.values()].filter((r) => r.user_id === uid && (since == null || r.ts >= since)).sort((x, y) => x.ts - y.ts);
    selects.push({ since, rows: Math.min(rows.length, a[1] - a[0] + 1) });
    return { data: rows.slice(a[0], a[1] + 1).map(({ id, ts, text }) => ({ id, ts, text })), error: null };
  }
  if (op === 'upsert') {
    for (const r of a[0]) {
      if (r.user_id !== uid) return { data: null, error: { message: 'new row violates row-level security policy' } };
      db.set(r.id, { ...r });
    }
    return { data: null, error: null };
  }
  if (op === 'delete') {
    for (const id of a[0]) if (db.get(id)?.user_id === uid) db.delete(id);
    return { data: null, error: null };
  }
};
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const b = await chromium.launch();
  const device = async (withFake = true) => {
    const ctx = await b.newContext({ viewport: { width: 900, height: 700 }, serviceWorkers: 'block' });
    if (withFake) {
      await ctx.exposeFunction('fakeDb', fakeDb);
      await ctx.addInitScript(fake);
      await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    } else {
      await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "window.TYMLEE_CONFIG = { supabaseUrl: '', supabaseAnonKey: '' };" }));
    }
    const p = await ctx.newPage();
    p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.waitForTimeout(200);
    p.send = async (t) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(150); };
    p.last = async (n = 1) => (await p.locator('#out pre').allTextContents()).slice(-n).join('\n');
    p.status = () => p.locator('#status .sync').textContent();
    p.signIn = async (email) => { await p.send('/login ' + email); await p.evaluate(() => window.__clickLink()); await p.waitForTimeout(300); };
    return p;
  };

  // Local-only mode (real, empty config.js) plus migration of v1 data.
  const L = await device(false);
  await L.evaluate(() => localStorage.setItem('tymlee.entries.v1', JSON.stringify([{ ts: Date.now() - 60000, text: 'old entry' }])));
  await L.reload(); await L.waitForTimeout(200);
  await L.send('/log');
  ok(/old +entry/.test(await L.last()), 'v1 data migrated in local-only mode');
  ok((await L.status()) === 'local', 'status ' + JSON.stringify(await L.status()) + '  shows local when not configured');
  await L.send('/login a@b.co');
  ok((await L.last()).includes('not configured'), JSON.stringify(await L.last()) + ' /login explains sync is not configured');

  // Device A: log while signed out, then sign in and import.
  const A = await device();
  ok((await A.status()).startsWith('local · /login'), 'signed-out status prompts /login');
  await A.send('dev before login'); await A.send('mtg before login');
  await A.send('/code 123456');
  ok((await A.last()).includes('not signed in · /login'), '/code without /login is refused');
  await A.send('/login me@example.com');
  ok((await A.last()).includes('sent a sign-in email') && (await A.last()).includes('/code'), '/login sends email and mentions /code');
  await A.send('/code 000000');
  ok((await A.last()).includes('invalid'), 'wrong code shows error');
  await A.send('/code abc');
  ok((await A.last()).includes('usage: /code'), 'non-numeric code rejected');
  // Phones often reload the tab while you fetch the code from the mail app.
  await A.reload(); await A.waitForTimeout(300);
  await A.send('/code 123456');
  await A.waitForTimeout(300);
  const out = await A.last(3);
  ok(out.includes('signed in as me@example.com') && out.includes('/import'), 'signed in, offered /import:\n' + out);
  await A.send('/import'); await A.waitForTimeout(300);
  ok((await A.last()).includes('imported 2 entries'), 'imported 2 entries');
  await A.send('dev after login'); await A.waitForTimeout(300);
  ok(db.size === 3, `server has 3 rows (has ${db.size})`);
  ok((await A.status()) === 'synced', 'status synced');

  // Device B: sign in, see A's entries, undo one.
  const B = await device();
  await B.signIn('me@example.com');
  await B.send('/log');
  const logB = await B.last();
  ok(['dev before login', 'mtg before login', 'dev after login'].every((t) => logB.includes(t.replace(/^\w+ /, ''))), 'device B sees all 3 entries');
  await B.send('/undo'); await B.waitForTimeout(300);
  ok(db.size === 2, `undo on B deleted on server (has ${db.size})`);

  // Device A picks up B's change.
  await A.send('/sync');
  ok((await A.last()).includes('synced · 2 entries'), JSON.stringify(await A.last()) + ' A synced down to 2 entries');

  // Offline on A: entry is queued, then sent on reconnect.
  await A.evaluate(() => { window.__offline = true; });
  await A.send('email offline work'); await A.waitForTimeout(300);
  ok(/not synced|waiting|offline/.test(await A.status()) && db.size === 2, `offline entry queued (status "${await A.status()}")`);
  await A.send('/logout');
  ok((await A.last()).includes('not synced yet'), '/logout refuses with unsynced changes');
  await A.evaluate(() => { window.__offline = false; });
  await A.send('/sync'); await A.waitForTimeout(200);
  ok(db.size === 3 && (await A.status()) === 'synced', 'queued entry sent after reconnect');

  // A different user sees nothing of this one.
  const C = await device();
  await C.send('/login other@example.com'); await C.send('/code 123456'); await C.waitForTimeout(300);
  await C.send('/log all');
  ok((await C.last()).includes('no entries'), 'another user sees none of these entries');

  // Sign out clears the account's cache from the browser.
  await A.send('/logout'); await A.waitForTimeout(200);
  await A.send('/log all');
  const keys = await A.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('user-')));
  ok((await A.last()).includes('no entries') && keys.length === 0, 'logout leaves no account data in the browser');
  await A.screenshot({ path: `${S}/sync.png` });

  // Reload B: session and entries persist.
  await B.reload(); await B.waitForTimeout(400);
  ok((await B.status()) === 'synced', 'B still signed in after reload');

  for (const [n, p] of Object.entries({ L, A, B, C })) ok(p.errs.length === 0, `no page errors on ${n} ${p.errs}`);
  await B.screenshot({ path: `${S}/sync-b.png` });
  await b.close();
})();
