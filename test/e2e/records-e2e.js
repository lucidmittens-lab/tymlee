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
const records = new Map();
let recordsMissing = true;
let tick = 0;
const fakeDb = (uid, table, op, ...a) => {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  if (table === 'records') {
    if (recordsMissing) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
    if (op === 'select') {
      const q = a[0];
      const since = q.gte ? Date.parse(q.gte[1]) : null;
      const rows = [...records.values()].filter((r) => r.user_id === uid && (since == null || r.modified >= since)).sort((x, y) => x.modified - y.modified);
      return { data: rows.slice(q.from, q.to + 1).map((r) => ({ id: r.id, data: r.data, deleted: r.deleted, modified_at: new Date(r.modified).toISOString() })), error: null };
    }
    if (op === 'upsert') {
      for (const r of a[0]) {
        if (r.user_id !== uid) return { data: null, error: { message: 'row-level security' } };
        if (!((r.deleted && r.data === '/deleted') || r.data.startsWith('/e1/'))) return { data: null, error: { code: '23514', message: 'violates check constraint "records_encrypted_check"' } };
        records.set(r.id, { ...r, modified: Date.now() + (tick++) });
      }
      return { data: null, error: null };
    }
    if (op === 'deleteAll') { for (const [id, r] of records) if (r.user_id === uid) records.delete(id); return { data: null, error: null }; }
  }
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
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
};



const UID = 'user-me@example.com';
const TEMPLATE = 'Day %{date}\n%{each wo}\n%{wo}: %{hours}\nSystem: %{ask:System}\n%{end}';
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const device = async (init) => {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 760 } });
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
    p.signIn = async () => { await p.send('/login me@example.com'); await p.send('/code 123456', 1000); };
    p.newForm = async (name, text) => {
      await p.send(`/newform ${name}`);
      await p.locator('#out .editor').fill(text);
      await p.locator('#out .editor').press('Control+Enter'); await p.waitForTimeout(300);
    };
    // Answers each question with the given text (or keeps what's offered when null).
    p.fill1 = async (line, answers) => {
      await p.fill('#entry', line); await p.press('#entry', 'Enter'); await p.waitForTimeout(250);
      const offered = [];
      for (const ans of answers) {
        offered.push(await p.inputValue('#entry'));
        if (ans != null) await p.fill('#entry', ans);
        await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
      }
      await p.waitForTimeout(300);
      return offered;
    };
    return p;
  };
  const A = await device(() => localStorage.setItem('tymlee.view2', 'cli'));
  await A.signIn();
  await A.send('dev one');
  await A.send('/wopunch 10 4471', 400);
  // Before the SQL: forms work as before (in the settings).
  await A.newForm('service', TEMPLATE);
  ok((await A.last()).includes('form service saved'), 'before the SQL: a form saves');
  await A.fill1('/form service', ['rig-A']);
  ok((await A.last()).includes('System: rig-A'), 'and fills in');
  ok(records.size === 0, 'nothing in records yet');

  // The SQL is run: the next full sync moves forms and answers over.
  recordsMissing = false;
  await A.send('/sync', 1500);
  const rows = [...records.values()];
  ok(rows.length === 2 && rows.every((r) => r.data.startsWith('/e1/') && !r.data.includes('service') && !r.data.includes('rig-A')), `moved: ${rows.length} encrypted rows`);
  await A.send('/form');
  ok((await A.last()).includes('forms: service'), 'still listed after the move');
  const offered = await A.fill1('/form service', [null]);
  ok(offered[0] === 'rig-A', `answer still offered after the move: ${offered}`);

  // Another device.
  await A.send('/link', 600);
  const code = ((await A.out()).match(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/g) || []).pop();
  const B = await device(() => localStorage.setItem('tymlee.view2', 'cli'));
  await B.signIn();
  await B.send(`/link ${code}`, 2000);
  await B.send('/form');
  ok((await B.last()).includes('forms: service'), `the other device has the form: ${await B.last()}`);
  // A new work order starts with the last answer given for System.
  await B.send('dev two');
  await B.send('/wopunch 20 4480', 400);
  const offeredB = await B.fill1('/form service', [null, 'rig-B']);
  ok(offeredB[0] === 'rig-A' && offeredB[1] === 'rig-A', `new work order offered the latest answer: ${offeredB}`);

  // Both offline, each changes a different form: both changes kept.
  await A.newForm('timesheet', 'Hours %{hours}');
  await A.send('/sync', 1500); await B.send('/sync', 1500);
  await A.evaluate(() => { window.__offline = true; });
  await B.evaluate(() => { window.__offline = true; });
  await A.send('/editform service'); await A.locator('#out .editor').fill(TEMPLATE + '\nSigned: A'); await A.locator('#out .editor').press('Control+Enter'); await A.waitForTimeout(300);
  await B.send('/editform timesheet'); await B.locator('#out .editor').fill('Total %{hours} (B)'); await B.locator('#out .editor').press('Control+Enter'); await B.waitForTimeout(300);
  await A.evaluate(() => { window.__offline = false; });
  await B.evaluate(() => { window.__offline = false; });
  await A.send('/sync', 1500); await B.send('/sync', 1500); await A.send('/sync', 1500);
  for (const [n, p] of [['A', A], ['B', B]]) {
    await p.send('/editform service'); const sv = await p.locator('#out .editor').inputValue(); await p.send('/cancel');
    await p.send('/editform timesheet'); const ts = await p.locator('#out .editor').inputValue(); await p.send('/cancel');
    ok(sv.includes('Signed: A') && ts.includes('Total %{hours} (B)'), `${n}: both offline edits kept`);
  }
  // To-dos and checklists ride the same rows.
  await B.send('/todo dev send the stems', 300);
  await B.send('/sync', 1500); await A.send('/sync', 1500);
  await A.send('/todos');
  ok((await A.last()).includes('TD:000010  dev  send the stems'), `a to-do made on one device shows on the other: ${await A.last()}`);
  await A.send('/done 10', 300); await A.send('/sync', 1500); await B.send('/sync', 1500);
  await B.send('/todos all');
  ok((await B.last()).includes('[x] TD:000010'), 'and ticking it comes back');
  // Delete syncs.
  await B.send('/delform timesheet', 300); await B.send('/sync', 1500); await A.send('/sync', 1500);
  await A.send('/form');
  ok(!(await A.last()).includes('timesheet'), 'a deletion reaches the other device');

  // Lots of answers: none dropped (they used to share one 16,000-character row).
  const big = await A.evaluate(() => {
    const T = window.Tymlee;
    return T ? true : false;
  });
  await A.newForm('many', '%{each entry}\n%{titles}: %{ask:Serial}\n%{end}');
  for (let i = 0; i < 40; i++) await A.send(`dev job${i}`, 60);
  const answers = [];
  for (let i = 0; i < 42; i++) answers.push(`SN-${String(i).padStart(4, '0')}-${'x'.repeat(300)}`);
  await A.fill1('/form many', answers);
  await A.send('/sync', 2500);
  const answerRows = [...records.values()].filter((r) => !r.deleted).length;
  ok(answerRows >= 45, `${answerRows} rows on the server, ${(([...records.values()].reduce((n, r) => n + r.data.length, 0)) / 1000).toFixed(0)}K characters in all (the old limit was 16K)`);
  const offeredMany = await A.fill1('/form many', new Array(42).fill(null));
  ok(offeredMany[0].startsWith('SN-0000') && offeredMany[41].startsWith('SN-0041'), 'every answer is still offered');
  await A.send('/clear');
  await A.send('/form many', 300);
  await A.screenshot({ path: `${S}/records-ask.png` });
  await A.press('#entry', 'Escape');

  // Starting encryption over: this device's forms go back up with the new key.
  await A.send('/reset-encryption DELETE', 2500);
  await A.send('/sync', 1500);
  const after = [...records.values()].filter((r) => !r.deleted);
  await A.send('/form');
  ok(after.length >= 45 && (await A.last()).includes('forms: many, service'), `after /reset-encryption: forms kept and re-sent (${after.length} rows)`);
  await A.send('/clear');
  await A.send('/form');
  await A.screenshot({ path: `${S}/records-cli.png` });
  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
