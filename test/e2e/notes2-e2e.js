const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const open = async (opts) => {
    const ctx = await b.newContext(opts);
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html'); await p.waitForTimeout(300);
    p.send = async (t, w = 300) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(w); };
    p.notes = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).map((e) => e.notes || ''));
    p.gui = () => p.locator('#gui').isVisible();
    return p;
  };
  const p = await open({ viewport: { width: 1000, height: 700 } });
  // Views: starts in GUI; a command showing output doesn't change the default.
  ok(await p.gui(), 'opens in the GUI view');
  await p.send('dev one'); await p.send('mtg two');
  await p.send('/log');
  ok(await p.gui(), '/log keeps the GUI view (the tray shows it)');
  await p.send('/clear');
  ok(await p.gui(), '/clear goes back to the GUI view');
  await p.send('/help');
  await p.reload(); await p.waitForTimeout(400);
  ok(await p.gui(), 'still opens in the GUI view after a command switched to CLI');
  await p.locator('#status .view-toggle button[aria-label="CLI"]').click(); await p.waitForTimeout(200);
  await p.reload(); await p.waitForTimeout(400);
  ok(!(await p.gui()), 'choosing CLI with the switch is remembered');
  await p.send('/clear');
  ok(!(await p.gui()), '/clear keeps the chosen CLI view');
  await p.locator('#status .view-toggle button[aria-label="Hybrid"]').click(); await p.waitForTimeout(200);

  // /note <text>: a new line on the current entry.
  await p.send('/note first thing');
  await p.send('/note second thing');
  ok((await p.notes())[1] === 'first thing\nsecond thing', `"/note text" adds lines to the current entry: ${JSON.stringify(await p.notes())}`);
  await p.send('/note ID:000010 about the first');
  ok((await p.notes())[0] === 'about the first', '/note ID:000010 text adds to entry ID:000010');

  // /note, pick: a real multi-line box starting on a new line.
  await p.send('/note', 200);
  await p.press('#entry', 'Enter'); await p.waitForTimeout(200); // pick the newest (ID:000020)
  ok(await p.locator('#notes-box').isVisible() && await p.locator('#entry').isHidden(), 'notes get a multi-line box');
  ok((await p.locator('#notes-box').inputValue()) === 'first thing\nsecond thing\n', 'it starts on a new line under the notes so far');
  ok(await p.evaluate(() => document.activeElement.id === 'notes-box' && document.activeElement.selectionStart === document.activeElement.value.length), 'with the cursor there');
  const h1 = (await p.locator('#notes-box').boundingBox()).height;
  await p.keyboard.type('third');
  await p.keyboard.press('Shift+Enter');
  await p.keyboard.type('fourth');
  const h2 = (await p.locator('#notes-box').boundingBox()).height;
  ok((await p.locator('#notes-box').inputValue()).endsWith('third\nfourth') && h2 > h1, 'Shift+Enter makes a real new line (the box grows)');
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  ok((await p.notes())[1] === 'first thing\nsecond thing\nthird\nfourth', 'Enter saves');
  const echo = await p.locator('#out pre.echo').last().textContent();
  ok(echo.includes('third\nfourth'), 'the echo shows the lines as lines');
  ok(await p.locator('#entry').isVisible() && await p.evaluate(() => document.activeElement.id === 'entry'), 'back to the prompt');
  await p.send('/note', 200); await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
  await p.keyboard.type('never mind'); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  ok((await p.notes())[1].endsWith('fourth') && (await p.locator('#out').textContent()).includes('note cancelled'), 'Esc cancels');
  await p.send('/note', 200); await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  ok((await p.locator('#out pre').last().textContent()).includes('notes unchanged'), 'saving without typing leaves the notes as they were');

  // Phone: no Shift+Enter, so a "new line" button.
  const m = await open({ ...devices['iPhone 13'] });
  await m.send('dev phone');
  await m.send('/note', 200); await m.locator('#matches span', { hasText: 'select' }).tap(); await m.waitForTimeout(200);
  await m.locator('#notes-box').fill('line a');
  await m.locator('#matches span', { hasText: 'new line' }).tap();
  await m.keyboard.type('line b');
  await m.locator('#matches span', { hasText: 'save' }).tap(); await m.waitForTimeout(300);
  ok((await m.notes())[0] === 'line a\nline b', `phone: the "new line" button: ${JSON.stringify(await m.notes())}`);
  ok(errs.length === 0, `no page errors ${errs}`);
  await b.close();
})();
