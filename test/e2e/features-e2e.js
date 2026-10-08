const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (hm) => new Date(`2026-10-01T${hm}:00-04:00`).getTime();
const seed = [
  { id: 'a', ts: at('08:00'), text: 'NORTHSTAR mix revisions', wo: '4471', notes: 'vocals up 1 dB' },
  { id: 'b', ts: at('10:00'), text: '/break-paid' },
  { id: 'c', ts: at('10:15'), text: 'NORTHSTAR stems for the label', wo: '4471' },
];
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [name, opts] of [['desktop', { viewport: { width: 1100, height: 820 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }]]) {
    const ctx = await b.newContext({ ...opts, timezoneId: 'America/New_York' });
    await ctx.clock.install({ time: new Date('2026-10-01T13:40:00-04:00') });
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await ctx.addInitScript(() => { new MutationObserver(() => document.querySelectorAll('.gmenu-group:not(.open)').forEach((g) => g.classList.add('open'))).observe(document, { childList: true, subtree: true }); }); // tests: every menu section open
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'cli'); }, seed);
    await p.reload(); await p.waitForTimeout(600);
    const send = async (t) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(250); };
    const last = () => p.locator('#out pre').last().textContent();
    // File paths.
    await send('/file "/Volumes/Work/NORTHSTAR/stems v3/stems.zip"');
    ok((await last()).startsWith('@ "/Volumes/Work/NORTHSTAR/stems v3/stems.zip" added to ID:000030'), `/file (a quoted path with a space): ${await last()}`);
    await send('/file #10 /Volumes/Work/NORTHSTAR/mix_v7.wav');
    await send('/clear'); await send('/log');
    const log = await last();
    ok(/vocals up 1 dB\n +@ \/Volumes\/Work\/NORTHSTAR\/mix_v7\.wav/.test(log) && log.includes('@ "/Volumes/Work/NORTHSTAR/stems v3/stems.zip"'), 'paths show under their entries');
    await send('/newform delivery');
    await p.locator('#out .editor').fill('%{each entry}\n%{title} (%{dur})\n%{files}\n%{end}');
    await p.locator('#out .editor').press('Control+Enter'); await p.waitForTimeout(200);
    await send('/form delivery');
    ok((await last()).includes('stems for the label (3:25)\n/Volumes/Work/NORTHSTAR/stems v3/stems.zip'), `%{files} in a form: ${JSON.stringify(await last())}`);
    if (name === 'desktop') { await send('/clear'); await send('/log'); await p.screenshot({ path: `${S}/feat-files-log.png` }); }
    // To-dos.
    await send('/clear');
    await send('/todo NORTHSTAR send the stems to the label');
    await send('/todo ACME call about the drawings');
    await send('/todo email invoice for September');
    await send('/done 20');
    await send('/todos all');
    const todos = await last();
    ok(/\[ \] TD:000010 +NORTHSTAR +send the stems/.test(todos) && /\[x\] TD:000020 +ACME/.test(todos), `to-dos: ${todos}`);
    if (name === 'desktop') await p.screenshot({ path: `${S}/feat-todos-cli.png` });
    // Checklists: template in the editor; start one; tick with [x].
    await send('/newchecklist upload');
    await p.locator('#out .editor').fill('file named PROJECT_vNN\nloudness at -14 LUFS\nfinal mix bounced\nshared path posted\n');
    await p.locator('#out .editor').press('Control+Enter'); await p.waitForTimeout(200);
    ok((await last()).includes('checklist upload saved (4 items)'), 'checklist saved');
    await send('/check upload Project X');
    const ed = p.locator('#out .editor');
    ok((await ed.inputValue()).includes('[ ] loudness at -14 LUFS'), 'the editor shows [ ] items');
    await ed.fill((await ed.inputValue()).replace('[ ] file named', '[x] file named').replace('[ ] loudness', '[x] loudness'));
    if (name === 'desktop') await p.screenshot({ path: `${S}/feat-check-editor.png` });
    await ed.press('Control+Enter'); await p.waitForTimeout(200);
    ok((await last()).includes('CL:000010 upload · Project X: 2/4 checked'), `ticked: ${await last()}`);
    // The GUI: tick boxes.
    await p.evaluate(() => localStorage.setItem('tymlee.view2', 'pure')); await p.reload(); await p.waitForTimeout(600);
    await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(200);
    await p.locator('.gmenu button', { hasText: 'To-do list' }).click(); await p.waitForTimeout(200);
    ok((await p.locator('.gsheet-title').textContent()) === 'To-do · 0/2', `to-do window: the done one is archived: ${await p.locator('.gsheet-title').textContent()}`);
    await p.locator('.gform-range', { hasText: 'Done · 1' }).click(); await p.waitForTimeout(200);
    ok((await p.locator('.gsheet-title').textContent()) === 'Done · 1' && (await p.locator('.gtick-row .gtick-text').allTextContents()).join() === 'call about the drawings', 'the Done archive lists it');
    await p.locator('.gtick-row', { hasText: 'call about the drawings' }).locator('input').uncheck(); await p.waitForTimeout(150);
    await p.locator('.gform-range', { hasText: 'Back to the list' }).click(); await p.waitForTimeout(200);
    ok((await p.locator('.gsheet-title').textContent()) === 'To-do · 0/3', 'unticked there, it is back on the list');
    await p.locator('.gtick-row', { hasText: 'invoice for September' }).locator('input').check(); await p.waitForTimeout(150);
    ok((await p.locator('.gtick-row.done', { hasText: 'invoice for September' }).count()) === 1, 'ticked here, it stays (struck) while the sheet is open');
    await p.screenshot({ path: `${S}/feat-${name}-todo.png` });
    const stored = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.records')).filter((r) => r.kind === 'todo').map((r) => `${r.body.sid}:${r.body.done}`).join(','));
    ok(stored === '10:false,20:false,30:true' || stored.split(',').sort().join(',') === '10:false,20:false,30:true', `ticks saved: ${stored}`);
    await p.click('.gsheet-close'); await p.click('.sb-menu:visible, .tab[data-tab="menu"]:visible'); await p.waitForTimeout(200);
    await p.locator('.gmenu button', { hasText: 'Open checklists' }).click(); await p.waitForTimeout(200);
    await p.locator('.gtick-open').first().click(); await p.waitForTimeout(200);
    await p.locator('.gtick-row', { hasText: 'final mix bounced' }).locator('input').check(); await p.waitForTimeout(150);
    ok((await p.locator('.gsheet-title').textContent()).endsWith('3/4'), `checklist window: ${await p.locator('.gsheet-title').textContent()}`);
    await p.screenshot({ path: `${S}/feat-${name}-checklist.png` });
    // The entry card has Files.
    if (name === 'desktop') {
      await p.click('.gsheet-close');
      await p.evaluate(() => localStorage.setItem('tymlee.view2', 'gui')); await p.reload(); await p.waitForTimeout(600);
      await p.locator('.tl-block', { hasText: 'stems for the label' }).click(); await p.waitForTimeout(200);
      ok((await p.locator('.entry-card textarea').nth(1).inputValue()).includes('stems.zip'), 'card shows the paths');
      await p.screenshot({ path: `${S}/feat-card.png` });
    }
    await ctx.close();
  }
  ok(!errs.length, `no errors ${errs}`);
  await b.close();
})();
