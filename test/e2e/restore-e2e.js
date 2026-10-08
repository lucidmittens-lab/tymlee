const { chromium, devices } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  for (const [name, opts] of [['desktop', { viewport: { width: 900, height: 700 }, acceptDownloads: true }], ['phone', { ...devices['iPhone 13'], acceptDownloads: true }]]) {
    const ctx = await b.newContext(opts);
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    const now = Date.now();
    const seed = [
      { id: 'a', ts: now - 30 * 3600e3, text: 'dev yesterday work' },
      { id: 'b', ts: now - 28 * 3600e3, text: '/off' },
      { id: 'c', ts: now - 3 * 3600e3, text: 'dev fixing, "quoted" bug' },
      { id: 'd', ts: now - 2 * 3600e3, text: 'mtg standup' },
      { id: 'e', ts: now - 1 * 3600e3, text: '/off' },
      { id: 'f', ts: now - 0.5 * 3600e3, text: 'email inbox' },
    ];
    await p.evaluate((rows) => localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(rows)), seed);
    await p.reload(); await p.waitForTimeout(200);
    const send = async (x) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(120); };
    const last = async () => (await p.locator('#out pre').allTextContents()).slice(-1)[0];
    const stored = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).map((e) => [Math.floor(e.ts / 60000), e.text]));
    const want = seed.map((e) => [Math.floor(e.ts / 60000), e.text]);

    for (const fmt of ['txt', 'csv']) {
      const [dl] = await Promise.all([p.waitForEvent('download'), send(fmt === 'csv' ? '/export all csv' : '/export all')]);
      const file = `${S}/backup-${name}.${fmt}`;
      await dl.saveAs(file);
      // Wipe the log, then restore from the file.
      await p.evaluate(() => localStorage.setItem('tymlee.v2.local.entries', '[]'));
      await p.reload(); await p.waitForTimeout(200);
      const [chooser] = await Promise.all([p.waitForEvent('filechooser'), send('/restore file')]);
      await chooser.setFiles(file);
      await p.waitForTimeout(200);
      ok(await p.locator('#out .editor').count() === 1, `${name} ${fmt}: file shown for review`);
      await send('/save');
      ok((await last()) === 'restored 6 entries', `${name} ${fmt}: ${await last()}`);
      ok(JSON.stringify(await stored()) === JSON.stringify(want), `${name} ${fmt}: log matches the original`);
      // Restoring again adds nothing.
      await send('/restore');
      await p.locator('#out .editor').fill(fs.readFileSync(file, 'utf8'));
      await send('/save');
      ok((await last()) === 'restored 0 entries (6 already in your log)', `${name} ${fmt}: repeat restore: ${await last()}`);
    }

    // Pasted text with a mistake: nothing added, box stays open.
    await send('/restore');
    await p.locator('#out .editor').fill('Thu 2026-09-24\n08:15 gym\nhello there\n');
    await send('/save');
    ok((await last()).includes('line 3: not a tymlee log line') && await p.locator('#out .editor').count() === 1, `${name}: bad paste rejected`);
    await send('/cancel');
    ok(await p.locator('#out .editor').count() === 0, `${name}: /cancel closes restore`);
    await send('/restore now');
    ok((await last()).includes('usage: /restore'), `${name}: bad argument`);
    if (name === 'phone') { await send('/restore'); await p.screenshot({ path: `${S}/restore-phone.png` }); await send('/cancel'); }
    ok(errs.length === 0, `${name}: no page errors ${errs}`);
    await ctx.close();
  }
  await b.close();
})();
