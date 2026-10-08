const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const entries = new Map();
const keyring = new Map();
let woColumns = false;
let lastStamp = 0;
const stamp = () => new Date((lastStamp = Math.max(Date.now(), lastStamp + 1))).toISOString();
const fakeDb = (uid, table, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  // plain@example.com stands for a server set up before encryption existed.
  if (table === 'keyring' && uid === 'user-plain@example.com') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.keyring'" } };
  if (table === 'keyring') {
    if (op === 'single') return { data: keyring.get(uid) || null, error: null };
    if (op === 'insert') { if (keyring.has(uid)) return { error: { code: '23505', message: 'dup' } }; keyring.set(uid, { recovery: a[0].recovery, link: null }); return { error: null }; }
    if (op === 'update') { if (a[1] === uid && keyring.has(uid)) Object.assign(keyring.get(uid), a[0]); return { error: null }; }
  }
  if (op === 'select') {
    const q = a[0];
    if (/\bwo\b/.test(q.cols) && !woColumns) return { data: null, error: { code: '42703', message: 'column entries.wo does not exist' } };
    let rows = [...entries.values()].filter((r) => r.user_id === uid);
    if (q.gte) { const [c, v] = q.gte; rows = rows.filter((r) => (c === 'modified_at' ? Date.parse(r.modified_at) >= Date.parse(v) : r[c] >= v)); }
    const by = q.order || 'id';
    rows.sort((x, y) => (x[by] < y[by] ? -1 : x[by] > y[by] ? 1 : 0));
    const cols = q.cols.split(',');
    return { data: rows.slice(q.from, q.to + 1).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))), error: null };
  }
  if (op === 'upsert') {
    for (const r of a[0]) if ('wo' in r && !woColumns) return { error: { code: 'PGRST204', message: "Could not find the 'wo' column" } };
    for (const r of a[0]) entries.set(r.id, { ...(entries.get(r.id) || {}), ...r, modified_at: stamp(), deleted: r.deleted || false });
    return { data: null, error: null };
  }
  if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
};

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const open = async ({ synced = true } = {}) => {
    const ctx = await b.newContext({ acceptDownloads: true });
    if (synced) { await ctx.exposeFunction('fakeDb', fakeDb); await ctx.addInitScript(fake); }
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(200);
    p.send = async (x, wait = 300) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
    p.key = async (k, wait = 150) => { await p.press('#entry', k); await p.waitForTimeout(wait); };
    p.last = async (n = 1) => (await p.locator('#out pre').allTextContents()).slice(-n).join('\n');
    p.out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
    p.hint = () => p.locator('#matches .sel').textContent();
    p.status = () => p.locator('#status').innerText();
    return p;
  };

  // 1. Schedule first, then log.
  const L = await open({ synced: false });
  await L.send('/wolink dev 4471');
  ok(/\[4471\] linked to dev on .*: 0 entries updated$/.test(await L.last()), `link before any entries: ${await L.last()}`);
  await L.send('/wolink mtg', 200);
  ok((await L.hint()).startsWith('work order for mtg on'), 'no number given: asks for it');
  await L.fill('#entry', '5520'); await L.key('Enter', 300);
  ok((await L.last()).includes('[5520] linked to mtg'), 'typed at the prompt');
  await L.send('/wolist');
  ok(/\[4471\] +0:00 +0% +0 entries +dev/.test(await L.last()) && /\[5520\].*mtg/.test(await L.last()), `/wolist shows scheduled work orders: \n${await L.last()}`);
  await L.send('dev fixing login bug');
  ok((await L.last()).includes('in ID:000010 [4471] dev fixing login bug'), 'new dev entry picks up the linked WO');
  ok((await L.status()).includes('[4471] dev fixing login bug'), 'status bar shows the WO');
  await L.send('mtg standup'); await L.send('email inbox'); await L.send('dev code review');
  ok((await L.last()).includes('in ID:000040 [4471] dev code review'), 'entry numbers ignore the hidden links');
  await L.send('/log', 300);
  const log = await L.last();
  ok(/^ +wo +start/m.test(log) && / ID:000010  \[4471\] +\d\d:\d\d/.test(log) && / ID:000030 +\d\d:\d\d/.test(log) && / ID:000020  \[5520\]/.test(log), `/log has the WO column before the time:\n${log}`);
  ok(!/\/wo /.test(log), 'hidden links never show');

  // 2. /wopunch one entry; relinking leaves punched entries alone.
  await L.send('/wopunch', 200);
  ok((await L.hint()).startsWith('ID:000040 [4471]'), `picker starts on the newest: ${await L.hint()}`);
  await L.key('Tab'); await L.key('Enter', 200);
  ok((await L.hint()).startsWith('work order for ID:000030'), 'picked ID:000030, asks for the WO');
  await L.fill('#entry', '6001'); await L.key('Enter', 300);
  ok((await L.last()).includes('[6001] set on ID:000030 email inbox'), 'punched one entry');
  await L.send('/wopunch 40 7777', 300);
  ok((await L.last()).includes('[7777] set on ID:000040 dev code review'), '/wopunch <#> <wo> in one go');
  await L.send('/wolink dev 9000', 300);
  ok((await L.last()).includes('1 entry updated'), 'relink updates only linked entries');
  await L.send('/log', 300);
  ok(/ ID:000010  \[9000\]/.test(await L.last()) && / ID:000040  \[7777\]/.test(await L.last()), 'punched entry keeps its own WO');
  await L.send('/wolink dev has space', 300);
  ok((await L.last()).includes('not a valid work order'), 'invalid WO refused');

  // 3. Hidden links never interfere.
  await L.send('/undo', 300);
  ok((await L.last()).includes('undid ID:000040'), '/undo removes the last real entry');
  await L.send('/rm 90', 200);
  ok((await L.last()).includes('an entry ID from /log'), '/rm: no such entry (links have no ID)');
  await L.send('/edit', 300);
  const box = await L.locator('#out .editor').inputValue();
  ok(box.includes('[9000]  ') && box.includes('[6001]  ') && !box.includes('/wo '), '/edit shows WOs, not links');
  await L.send('/cancel', 200);
  await L.send('/report', 300);
  ok(/ ID:000010  \[9000\] +\d\d:\d\d/.test(await L.last()), '/report shows WOs');

  // 4. Unlink.
  await L.send('/wolink dev', 200); await L.fill('#entry', ''); await L.key('Enter', 300);
  ok((await L.last()).includes('work order unlinked from dev'), 'empty answer unlinks');
  await L.send('dev later work', 300);
  ok((await L.last()).includes('in ID:000040 dev later work'), 'no WO after unlinking');
  await L.send('/wolink dev 2026-01-01 3333', 300);
  ok((await L.last()).includes('[3333] linked to dev on 2026-01-01: 0 entries updated') && !(await L.last()).includes('today'), 'another date');
  await L.send('/wolist 2026-01-01', 300);
  ok((await L.last()).includes('[3333]'), '/wolist for that date');

  // 5. Backups keep WOs.
  const [dl] = await Promise.all([L.waitForEvent('download'), L.send('/export all csv', 300)]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(csv.startsWith('n,wo,start,') && csv.includes(',5520,') && csv.includes(',6001,'), 'CSV has the wo column');
  const R = await open({ synced: false });
  await R.send('/restore', 200);
  await R.locator('#out .editor').fill(csv);
  await R.send('/save', 300);
  await R.send('/log all', 300);
  ok(/\[5520\]/.test(await R.last()) && /\[6001\]/.test(await R.last()), 'restored entries keep their WOs');

  // 6. Encrypted account: WOs and links sealed and synced; the link works on the other device.
  const A = await open();
  await A.send('/login me@example.com'); await A.send('/code 123456', 800);
  await A.send('/encrypt', 2500);
  await A.send('/wolink dev 4471', 800);
  ok((await A.last()).includes('[4471] linked to dev'), 'encrypted account: works without the wo columns');
  ok(![...entries.values()].some((r) => JSON.stringify(r).includes('4471') || /\/wo /.test(r.text)), 'link sealed on the server');
  const B = await open();
  await B.send('/login me@example.com'); await B.send('/code 123456', 800);
  await A.send('/link', 2000);
  const code = (await A.out()).match(/\/link ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  await B.send(`/link ${code}`, 2500);
  await B.send('dev on the other device', 800);
  ok((await B.last()).includes('[4471] dev on the other device'), 'the link reached the other device');
  await A.evaluate(() => window.dispatchEvent(new Event('online'))); await A.waitForTimeout(800);
  await A.send('/log', 300);
  ok((await A.last()).includes('[4471]') && (await A.last()).includes('on the other device'), 'and synced back');

  // 7. Unencrypted account needs the columns.
  const U = await open();
  await U.send('/login plain@example.com'); await U.send('/code 123456', 800);
  await U.send('/wolink dev 55', 400);
  ok((await U.last()).includes('work orders need the latest supabase/schema.sql'), 'server without encryption or the columns: explained');
  woColumns = true;
  await U.send('/sync', 800);
  await U.send('/wolink dev 55', 400); await U.send('dev plain', 800);
  const prow = [...entries.values()].find((r) => r.user_id === 'user-plain@example.com' && r.text === 'dev plain');
  ok(prow && prow.wo === '55' && prow.wo_linked === true, 'after the SQL: stored in the wo columns');

  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
