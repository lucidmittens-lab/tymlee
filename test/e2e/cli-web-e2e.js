const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const S = process.argv[2];
process.env.TYMLEE_FAKE_DB = `${S}/shared-db.json`;
fs.rmSync(process.env.TYMLEE_FAKE_DB, { force: true });
const { fakeDb, load } = require(`${S}/fake-db.js`);
const fake = fs.readFileSync(`${S}/fake-supabase-e2ee.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const home = `${S}/cli-home-sync`;
fs.rmSync(home, { recursive: true, force: true });
const cli = (...words) => execFileSync('node', ['cli/tymlee.js', ...words], {
  encoding: 'utf8',
  env: { ...process.env, TYMLEE_HOME: home, TYMLEE_CLIENT_MODULE: `${S}/fake-client.js`, TYMLEE_SUPABASE_URL: 'https://fake.supabase.co', TYMLEE_SUPABASE_KEY: 'anon' },
});
const serverRows = () => Object.values(load().entries).filter((r) => r.user_id === 'user-me@example.com');

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  await ctx.exposeFunction('fakeDb', fakeDb);
  await ctx.addInitScript(fake);
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const W = await ctx.newPage();
  const errs = []; W.on('pageerror', (e) => errs.push(e.message));
  await W.goto('http://localhost:8123/index.html'); await W.waitForTimeout(200);
  const send = async (x, wait = 400) => { await W.fill('#entry', x); await W.press('#entry', 'Enter'); await W.waitForTimeout(wait); };
  const wout = async () => (await W.locator('#out pre').allTextContents()).join('\n');

  // Website: sign in, turn on encryption, log two entries.
  await send('/login me@example.com'); await send('/code 123456', 800);
  await send('/encrypt', 2500);
  ok(/Your recovery key:/.test(await wout()), 'website: encryption on');
  await send('dev fixing the login bug'); await send('mtg standup', 800);

  // Terminal: sign in with a code (two separate runs, like a real person).
  let out = cli('/login', 'me@example.com');
  ok(/sent a sign-in email.*Type \/code/.test(out) && !/open the link/.test(out), 'terminal: /login asks for the code');
  out = cli('/code', '123456');
  ok(/signed in as me@example.com/.test(out) && /doesn't have the key yet/.test(out), 'terminal: signed in, told it is locked');
  out = cli('/log');
  ok(!/fixing the login bug/.test(out), 'terminal: cannot read entries before linking');

  // Link the terminal from the website.
  await send('/link', 2000);
  const code = (await wout()).match(/\/link ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/)[1];
  out = cli('/link', code);
  ok(/this device is set up/.test(out), 'terminal: linked with the code from the website');
  out = cli('/log');
  ok(/fixing the login bug/.test(out) && /standup/.test(out), 'terminal: reads the website\'s entries');

  // Terminal -> website.
  out = cli('dev', 'from', 'the', 'terminal');
  ok(/in ID:000030 dev from the terminal/.test(out), 'terminal: logs an entry');
  ok(serverRows().every((r) => r.deleted || (r.text.startsWith('/e2/') && r.ts === 0)), 'server only holds sealed entries');
  await W.evaluate(() => window.dispatchEvent(new Event('online'))); await W.waitForTimeout(800);
  await send('/log', 500);
  ok(/from the terminal/.test(await wout()), 'website: sees the terminal\'s entry');

  // Website -> terminal, including a deletion.
  await send('/off', 800);
  out = cli('/log');
  ok(/\(off\)/.test(out), 'terminal: sees /off from the website');
  await send('/undo', 800);
  out = cli('/log');
  ok(!/\(off\)/.test(out) && /from the terminal/.test(out), 'terminal: sees the website\'s /undo');

  // /whoami and /logout in the terminal.
  out = cli('/whoami');
  ok(/encrypted \(text and times\): this device has the key/.test(out), 'terminal: /whoami');
  out = cli('/logout');
  const data = JSON.parse(fs.readFileSync(`${home}/data.json`, 'utf8'));
  ok(/signed out of me@example.com/.test(out) && !Object.keys(data).some((k) => k.startsWith('tymlee.v2.user-')), 'terminal: /logout removes the log and key from this computer');
  const mode = fs.statSync(`${home}/data.json`).mode & 0o777;
  ok(mode === 0o600, `terminal: data file is private (${mode.toString(8)})`);
  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
