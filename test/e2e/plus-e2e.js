const { chromium, devices } = require('playwright');
const S = process.argv[2];
let n = 0, f = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? n++ : f++; if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [dev, opts] of [['desk', { viewport: { width: 1100, height: 760 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }]]) {
    const ctx = await b.newContext({ ...opts, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await ctx.clock.install({ time: new Date('2026-10-07T15:10:00-04:00') });
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'pure'); localStorage.setItem('tymlee.homeHint', '1'); }, [{ id: 'a', ts: new Date('2026-10-07T10:00:00-04:00').getTime(), text: 'ACME drawings' }]);
    await p.reload(); await p.waitForTimeout(700);
    const entry = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).find((e) => e.id === 'a'));
    const pick = async (label) => { await p.click('.sb-add'); await p.waitForTimeout(150); await p.locator('.sb-addmenu .sb-popup-item', { hasText: label }).click(); await p.waitForTimeout(250); };
    ok(await p.locator('.sb-add').isVisible(), `${dev}: + on the running card`);
    await p.click('.sb-add'); await p.waitForTimeout(150);
    ok(await p.locator('.sb-addmenu').isVisible() && (await p.locator('.sb-addmenu .sb-popup-item:visible').allTextContents()).map((t) => t.trim()).join('|') === 'Note|Work order|Equipment|Files|Edit entry', `${dev}: the menu: ${(await p.locator('.sb-addmenu .sb-popup-item:visible').allTextContents()).join('|')}`);
    const mb = await p.locator('.sb-addmenu').boundingBox(); const vw = (opts.viewport || {}).width;
    ok(mb.x >= 0 && mb.x + mb.width <= vw, `${dev}: the menu fits on screen`);
    await p.screenshot({ path: `${S}/plus-${dev}-menu.png` });
    await p.mouse.click(5, 5); await p.waitForTimeout(150);
    ok(!(await p.locator('.sb-addmenu').isVisible()), `${dev}: a click elsewhere closes it`);
    // Note
    await pick('Note');
    await p.fill('.gform input[name=text]', 'client asked for a recut');
    if (dev === 'phone') await p.screenshot({ path: `${S}/plus-${dev}-note.png` });
    await p.press('.gform input[name=text]', 'Enter'); await p.waitForTimeout(300);
    ok((await entry()).notes === 'client asked for a recut', `${dev}: Note adds a note`);
    // Work order
    await pick('Work order');
    await p.fill('.gform input[name=v]', '4471'); await p.press('.gform input[name=v]', 'Enter'); await p.waitForTimeout(300);
    ok((await entry()).wo === '4471' && (await p.locator('.toast').last().textContent()).includes('Work order [4471] on this entry'), `${dev}: Work order sets it`);
    await p.click('.sb-add'); await p.waitForTimeout(150);
    ok((await p.locator('.sb-addmenu .sb-popup-item', { hasText: 'Work order' }).textContent()).includes('[4471]'), `${dev}: the menu shows the work order it has`);
    await p.click('.sb-add'); await p.waitForTimeout(100);
    await pick('Work order');
    ok((await p.locator('.gform input[name=v]').inputValue()) === '4471', `${dev}: the form starts with it`);
    await p.fill('.gform input[name=v]', 'bad one'); await p.press('.gform input[name=v]', 'Enter'); await p.waitForTimeout(300);
    ok((await entry()).wo === '4471' && (await p.locator('.toast').last().textContent()).includes('not a valid work order'), `${dev}: a bad one is refused`);
    // Equipment
    await pick('Equipment');
    await p.fill('.gform input[name=v]', 'ler-resolve-07'); await p.press('.gform input[name=v]', 'Enter'); await p.waitForTimeout(300);
    ok((await entry()).eq === 'ler-resolve-07', `${dev}: Equipment sets it: ${(await entry()).eq}`);
    // Files
    await pick('Files');
    await p.fill('.gform input[name=files]', '/Volumes/Work/ mix.wav stems.zip'); await p.press('.gform input[name=files]', 'Enter'); await p.waitForTimeout(300);
    ok((await entry()).files === '/Volumes/Work/mix.wav\n/Volumes/Work/stems.zip', `${dev}: Files adds them: ${JSON.stringify((await entry()).files)}`);
    ok((await entry()).notes === 'client asked for a recut' && (await entry()).text === 'ACME drawings', `${dev}: the rest is unchanged`);
    ok((await p.locator('.gsheet-wrap').count()) === 0 && (await p.locator('.toast').last().textContent()).includes('2 files added to ID:000010'), `${dev}: Files confirms in a toast, no sheet`);
    // Edit entry
    await pick('Edit entry');
    ok(await p.locator('.entry-card').isVisible() && (await p.locator('.entry-card textarea').first().inputValue()) === 'client asked for a recut', `${dev}: Edit entry opens its card`);
    if (dev === 'desk') await p.screenshot({ path: `${S}/plus-${dev}-edit.png` });
    if (dev === 'phone') { await p.screenshot({ path: `${S}/plus-phone-edit.png` }); const cb = await p.locator('.entry-card').boundingBox(); const bb = await p.locator('.startbar').boundingBox(); ok(cb.y + cb.height <= bb.y + 1, 'phone: the entry card is a panel above the start bar'); await p.locator('.entry-card .ec-buttons button', { hasText: 'Cancel' }).tap(); } else await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    ok(!(await p.locator('.entry-card').count()), `${dev}: and it closes`);
    // Keyboard and breaks
    if (dev === 'desk') {
      await p.keyboard.press('+'); await p.waitForTimeout(150);
      ok(await p.locator('.sb-addmenu').isVisible(), '+ opens the menu');
      await p.keyboard.press('Escape'); await p.waitForTimeout(150);
      ok(!(await p.locator('.sb-addmenu').isVisible()), 'Esc closes it');
    }
    await p.evaluate(() => document.activeElement && document.activeElement.blur());
    await p.locator(dev === 'phone' ? '.sb-paid' : '.sb-break-main').click(); await p.waitForTimeout(300);
    await p.click('.sb-add'); await p.waitForTimeout(150);
    ok((await p.locator('.sb-addmenu .sb-popup-item:visible').allTextContents()).map((t) => t.trim()).join('|') === 'Note|Files|Edit entry', `${dev}: on a break: no work order or equipment`);
    await ctx.close();
  }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(`${n} passed, ${f} failed`);
  await b.close();
})();
