const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const fake = fs.readFileSync(`${S}/fake-supabase.js`, 'utf8');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  await ctx.exposeFunction('fakeDb', () => ({ data: [], error: null }));
  await ctx.addInitScript(fake);
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(200);
  const send = async (x) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(150); };
  const last = async (n = 1) => (await p.locator('#out pre').allTextContents()).slice(-n).join('\n');
  const localEntries = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries') || '[]').length);

  // Not signing in: a 6-digit line is an ordinary entry.
  await send('654321');
  ok((await last()).includes('in ID:000010 654321'), 'digits are an entry when no sign-in is pending');
  await send('/undo');

  await send('/login me@example.com');
  for (const [label, text] of [
    ['bare digits (keyboard code suggestion)', '000000'],
    ['"code 000000"', 'code 000000'],
    ['whole pasted email line', 'Or type this at the tymlee prompt: /code 000000'],
    ['invisible character before the slash', '​/code 000000'],
    ['full-width slash', '／code 000000'],
  ]) {
    await send(text);
    const out = await last(2);
    ok(out.includes('> /code 000000') && out.includes('invalid') && (await localEntries()) === 0, `${label} runs /code, not an entry`);
  }
  await send('Or type this at the tymlee prompt: /code 123456');
  await p.waitForTimeout(300);
  ok((await last(3)).includes('signed in as me@example.com'), 'pasted email line signs in');
  ok((await localEntries()) === 0, 'no entries were created along the way');
  ok(await p.evaluate(() => localStorage.getItem('tymlee.loginEmail')) === null, 'pending sign-in cleared');
  await send('123456');
  ok((await last()).includes('in ID:000010 123456'), 'after sign-in, digits are an ordinary entry again');
  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
