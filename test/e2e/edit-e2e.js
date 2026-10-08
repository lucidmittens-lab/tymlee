const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  for (const [name, opts] of [['desktop', { viewport: { width: 900, height: 700 } }], ['phone', devices['iPhone 13']]]) {
    const ctx = await b.newContext(opts);
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    const base = new Date(Math.floor((Date.now() - 3 * 3600e3) / 60000) * 60000);
    const t = (min) => base.getTime() + min * 60000;
    await p.evaluate((rows) => localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(rows)), [
      { id: 'old', ts: t(0) - 3 * 86400000, text: 'dev ancient' },
      { id: 'a', ts: t(0), text: 'dev fixing login bug' },
      { id: 'b', ts: t(45), text: 'mtg standup' },
      { id: 'c', ts: t(60), text: 'dev code review' },
    ]);
    await p.reload(); await p.waitForTimeout(200);
    const send = async (x) => { await p.fill('#entry', x); await p.press('#entry', 'Enter'); await p.waitForTimeout(100); };
    const last = async () => (await p.locator('#out pre').allTextContents()).slice(-1)[0];
    const hm = (min) => new Date(t(min)).toTimeString().slice(0, 5);

    await send('/save');
    ok((await last()).includes('nothing to save'), `${name}: /save without /edit`);
    await send('/edit');
    const ed = p.locator('#out .editor');
    ok(await ed.count() === 1, `${name}: editor opened`);
    const text = await ed.inputValue();
    ok(!text.includes('ancient') && text.includes('fixing login bug'), `${name}: shows last 24h only`);
    ok(await p.evaluate(() => document.activeElement.className === 'editor'), `${name}: editor has focus`);
    if (name === 'phone') ok((await ed.evaluate((e) => getComputedStyle(e).fontSize)) === '14px', 'phone: editor text 14px');

    // Break it first: an error keeps the editor open and changes nothing.
    await ed.fill(text.replace('mtg standup', 'mtg standup') + '99:99 oops\n');
    await send('/save');
    ok((await last()).includes('not a valid time') && await ed.count() === 1, `${name}: error reported, editor still open`);

    // Real edit: change text of #2, delete #3, change time of #4, add one.
    let edited = text
      .replace('fixing login bug', 'fixing the login bug')
      .replace(/^.*mtg standup.*\n/m, '')
      .replace(`${hm(60)}  dev code review`, `${hm(70)}  dev code review`);
    edited += `${hm(30)} email inbox\n`;
    await ed.fill(edited);
    await ed.press(name === 'desktop' ? 'Control+Enter' : 'Control+Enter');
    await p.waitForTimeout(150);
    ok((await last()).includes('saved: 2 changed, 1 added, 1 removed'), `${name}: saved summary: ${await last()}`);
    ok(await ed.count() === 0, `${name}: editor closed`);
    const stored = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')));
    ok(JSON.stringify(stored.map((e) => e.text)) === JSON.stringify(['dev ancient', 'dev fixing the login bug', 'email inbox', 'dev code review']), `${name}: stored ${JSON.stringify(stored.map((e) => e.text))}`);
    ok(stored.find((e) => e.id === 'c').ts === t(70), `${name}: time change stored`);

    await send('/edit'); await send('/edit');
    ok((await last()).includes('already editing'), `${name}: second /edit refused`);
    await send('/clear');
    ok(await p.locator('#out .editor').count() === 1, `${name}: /clear keeps the editor`);
    await send('/cancel');
    ok((await last()).includes('cancelled') && await p.locator('#out .editor').count() === 0, `${name}: /cancel closes`);
    await send('/edit');
    await p.screenshot({ path: `${S}/edit-${name}.png` });
    await send('/cancel');
    await send('/edit'); await p.locator('#out .editor').fill('08:00 x\n'); 
    ok(errs.length === 0, `${name}: no page errors ${errs}`);
    await ctx.close();
  }
  await b.close();
})();
