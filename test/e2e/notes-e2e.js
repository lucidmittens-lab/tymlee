const { chromium, devices } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const entries = new Map();
const keyring = new Map();
let notesColumn = false;
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
    if (q.cols.includes('notes') && !notesColumn) return { data: null, error: { code: '42703', message: 'column entries.notes does not exist' } };
    let rows = [...entries.values()].filter((r) => r.user_id === uid);
    if (q.gte) { const [c, v] = q.gte; rows = rows.filter((r) => (c === 'modified_at' ? Date.parse(r.modified_at) >= Date.parse(v) : r[c] >= v)); }
    const by = q.order || 'id';
    rows.sort((x, y) => (x[by] < y[by] ? -1 : x[by] > y[by] ? 1 : 0));
    const cols = q.cols.split(',');
    return { data: rows.slice(q.from, q.to + 1).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))), error: null };
  }
  if (op === 'upsert') {
    for (const r of a[0]) if ('notes' in r && !notesColumn) return { error: { code: 'PGRST204', message: "Could not find the 'notes' column of 'entries' in the schema cache" } };
    for (const r of a[0]) entries.set(r.id, { ...(entries.get(r.id) || {}), ...r, modified_at: stamp(), deleted: r.deleted || false });
    return { data: null, error: null };
  }
  if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
};

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const open = async (opts = {}, { synced = true } = {}) => {
    const ctx = await b.newContext(opts);
    if (synced) {
      await ctx.exposeFunction('fakeDb', fakeDb);
      await ctx.addInitScript(fake);
    }
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(200);
    p.send = async (x, wait = 300) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(wait); };
    p.key = async (k, wait = 150) => { await p.keyboard.press(k); await p.waitForTimeout(wait); };
    p.last = async (n = 1) => (await p.locator('#out pre').allTextContents()).slice(-n).join('\n');
    p.out = async () => (await p.locator('#out pre').allTextContents()).join('\n');
    p.hint = () => p.locator('#matches .sel').textContent();
    return p;
  };

  // 1. Local log: picking, saving, changing, removing, cancelling.
  const L = await open({}, { synced: false });
  await L.send('/note');
  ok((await L.last()).includes('no entries to add notes to'), 'nothing to note yet');
  await L.send('dev fixing login bug'); await L.send('mtg standup'); await L.send('dev code review');
  await L.send('/note', 200);
  ok((await L.hint()).startsWith('ID:000030') && (await L.hint()).includes('(1/3)'), `starts on the newest entry: ${await L.hint()}`);
  await L.key('Tab'); ok((await L.hint()).startsWith('ID:000020'), 'Tab goes back in time');
  await L.key('Tab'); ok((await L.hint()).startsWith('ID:000010'), 'Tab again');
  await L.key('Tab'); ok((await L.hint()).startsWith('ID:000010'), 'stops at the oldest');
  await L.key('Shift+Tab'); ok((await L.hint()).startsWith('ID:000020'), 'Shift+Tab goes forward');
  await L.key('Tab');
  await L.key('Enter', 200);
  ok((await L.hint()).startsWith('notes for ID:000010'), `then asks for notes: ${await L.hint()}`);
  await L.page?.keyboard; await L.fill('#notes-box', 'root cause: expired token'); await L.key('Enter', 300);
  ok((await L.last()).includes('notes saved on ID:000010 dev fixing login bug'), 'notes saved');
  await L.send('/log', 300);
  ok(/fixing login bug\n\s+> root cause: expired token/.test(await L.last()), '/log shows the notes under the entry');
  await L.send('/note 10', 200);
  ok((await L.inputValue('#notes-box')) === 'root cause: expired token\n', '/note 10 opens the notes so far, on a new line');
  await L.fill('#notes-box', ''); await L.key('Enter', 300);
  ok((await L.last()).includes('notes removed from ID:000010'), 'clearing removes the notes');
  await L.send('/note', 200); await L.key('Escape', 200);
  ok((await L.last()).includes('note cancelled') && !(await L.locator('#matches .btn').count()), 'Esc cancels');
  await L.send('/note 90', 200);
  ok((await L.last()).includes('usage: /note'), 'unknown number explained');
  await L.send('/report', 300);
  ok(/report: today .*\n\ndev +\d+:\d\d +\d+%  2 entries\n +ID:000010 .*fixing login bug\n +ID:000030 .*code review\n\nmtg/.test(await L.last()), '/report groups by category');
  // /edit shows and changes notes.
  await L.send('/note 20', 200); await L.fill('#notes-box', 'ran long'); await L.key('Enter', 300);
  await L.send('/edit', 300);
  const box = L.locator('#out .editor');
  ok((await box.inputValue()).includes('mtg standup\n                    > ran long'), '/edit shows notes');
  await box.fill((await box.inputValue()).replace('> ran long', '> ran long\n> action items sent'));
  await L.send('/save', 300);
  ok((await L.last()).includes('saved: 1 changed'), '/edit saves notes');
  await L.send('/note 20', 200);
  ok((await L.inputValue('#notes-box')) === 'ran long\naction items sent\n', 'multi-line notes open as lines, on a new one');
  await L.keyboard.type('third line');
  ok((await L.inputValue('#notes-box')) === 'ran long\naction items sent\nthird line', 'typing adds the new line');
  await L.key('Enter', 300);
  ok((await L.last()).includes('notes saved on ID:000020'), 'Enter saves');
  await L.send('/log', 300);
  ok(/standup\n\s+> ran long\n\s+> action items sent\n\s+> third line/.test(await L.last()), 'saved as three lines');

  // Phone: buttons instead of Tab.
  const P = await open({ ...devices['iPhone 13'] }, { synced: false });
  await P.send('dev a'); await P.send('dev b');
  await P.send('/note', 200);
  await P.locator('#matches .btn', { hasText: 'older' }).dispatchEvent('mousedown');
  await P.waitForTimeout(100);
  ok((await P.hint()).startsWith('ID:000010'), 'phone: "‹ older" button');
  await P.locator('#matches .btn', { hasText: 'select' }).dispatchEvent('mousedown');
  await P.waitForTimeout(200);
  await P.fill('#notes-box', 'from the phone');
  await P.locator('#matches .btn', { hasText: 'save' }).dispatchEvent('mousedown');
  await P.waitForTimeout(300);
  ok((await P.last()).includes('notes saved on ID:000010 dev a'), 'phone: select and save buttons');

  // 2. Encrypted account, server without the notes column: notes sealed, synced.
  const A = await open();
  await A.send('/login me@example.com'); await A.send('/code 123456', 800);
  await A.send('/encrypt', 2500);
  await A.send('dev secret work', 600);
  await A.send('/note', 200); await A.key('Enter', 200);
  await A.fill('#notes-box', 'confidential detail'); await A.key('Enter', 800);
  ok((await A.last()).includes('notes saved'), 'encrypted account: notes allowed without the notes column');
  const row = [...entries.values()].find((r) => r.user_id === 'user-me@example.com');
  ok(row.text.startsWith('/e2/') && !JSON.stringify(row).includes('confidential'), 'notes sealed inside the entry');
  const B = await open();
  await B.send('/login me@example.com'); await B.send('/code 123456', 800);
  await A.send('/link', 2000);
  const code = (await A.out()).match(/\/link ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  await B.send(`/link ${code}`, 2500);
  await B.send('/log', 300);
  ok((await B.last()).includes('> confidential detail'), 'notes arrive on the linked device');

  // 3. Unencrypted account: needs the notes column.
  const U = await open();
  await U.send('/login plain@example.com'); await U.send('/code 123456', 800);
  await U.send('dev plain work', 600);
  await U.send('/note 10', 400);
  ok((await U.last()).includes('notes need the latest supabase/schema.sql'), 'server without encryption or the column: explained');
  notesColumn = true;
  await U.send('/sync', 800);
  await U.send('/note 10', 400); await U.fill('#notes-box', 'visible note'); await U.key('Enter', 800);
  const prow = [...entries.values()].find((r) => r.user_id === 'user-plain@example.com');
  ok((await U.last()).includes('notes saved') && prow.notes === 'visible note', 'after the SQL: saved in the notes column');
  // The encrypted account keeps notes sealed even with the column present.
  await A.send('/sync', 1500);
  ok([...entries.values()].filter((r) => r.user_id === 'user-me@example.com').every((r) => !r.notes), 'encrypted account never uses the plain column');

  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
