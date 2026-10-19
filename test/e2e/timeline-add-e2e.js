// 2.0.6: an End field on the entry card, clicking the timeline to add an
// entry, adding to an empty day, and Off time drawn as nothing.
const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (hm, d = '07') => new Date(`2026-10-${d}T${hm}:00-04:00`).getTime();

(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [dev, opts] of [['desk', { viewport: { width: 1200, height: 800 } }], ['phone', { ...devices['iPhone 13'] }]]) {
    const ctx = await b.newContext({ ...opts, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await ctx.clock.install({ time: new Date('2026-10-07T18:00:00-04:00') });
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8123/index.html');
    await p.evaluate((r) => {
      localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r));
      localStorage.setItem('tymlee.view2', 'pure');
      localStorage.setItem('tymlee.homeHint', '1');
    }, [
      { id: 'a', ts: at('09:00'), text: 'ACME drawings', sid: 10 },
      { id: 'b', ts: at('11:00'), text: '/off', sid: 20 },
      { id: 'c', ts: at('13:00'), text: 'NORTHSTAR mix', sid: 30 },
      { id: 'd', ts: at('16:00'), text: '/off', sid: 40 },
    ]);
    await p.reload(); await p.waitForTimeout(900);
    const log = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).filter((e) => !e.deleted).sort((x, y) => x.ts - y.ts)
      .map((e) => `${new Date(e.ts).toTimeString().slice(0, 5)} ${e.text}`));

    // Off time is nothing: no block for it.
    ok((await p.locator('.tl-offblock').count()) === 0, `${dev}: Off time has no block`);
    if (dev === 'desk') await p.screenshot({ path: `${S}/tladd-${dev}-day.png` });

    // The entry card's End.
    await p.locator('.tl-block', { hasText: 'ACME' }).click(); await p.waitForTimeout(300);
    const end = p.locator('.entry-card .ec-field', { hasText: 'End' }).locator('input');
    ok((await end.inputValue()) === '11:00', `${dev}: End shows where it ends now`);
    await end.fill('10:30'); await p.locator('.entry-card button[type=submit]').click(); await p.waitForTimeout(400);
    ok((await log()).join('|') === '09:00 ACME drawings|10:30 /off|13:00 NORTHSTAR mix|16:00 /off', `${dev}: End 10:30 moves the Off after it (${(await log()).join('|')})`);
    await p.locator('.tl-block', { hasText: 'NORTHSTAR' }).click(); await p.waitForTimeout(300);
    await p.locator('.entry-card .ec-field', { hasText: 'End' }).locator('input').fill('19:00');
    await p.locator('.entry-card button[type=submit]').click(); await p.waitForTimeout(300);
    ok(/future/.test(await p.locator('.entry-card .ec-error').textContent()), `${dev}: an End in the future is refused`);
    await p.locator('.entry-card button', { hasText: 'Cancel' }).click(); await p.waitForTimeout(200);

    // Click inside NORTHSTAR (13:00-16:00) to add a call that ends at 14:45.
    const block = await p.locator('.tl-block', { hasText: 'NORTHSTAR' }).boundingBox();
    await p.mouse.click(block.x + 5, block.y + block.height / 2); // on the block: edits it
    await p.waitForTimeout(200);
    ok(await p.locator('.entry-card:not(.add-card)').isVisible(), `${dev}: a click on a block still edits it`);
    await p.locator('.entry-card button', { hasText: 'Cancel' }).click(); await p.waitForTimeout(200);
    // Empty space at about 12:00 (between the Off at 10:30 and 13:00).
    const col = await p.locator('.tl-day').first().boundingBox();
    const y13 = block.y; // 13:00
    const yNorth = block.y + block.height; // ~16:00
    const perHour = (yNorth - y13) / 3;
    await p.mouse.click(col.x + col.width * 0.6, y13 - perHour); await p.waitForTimeout(300);
    ok(await p.locator('.add-card').isVisible(), `${dev}: a click on empty time opens a new entry`);
    const start = await p.locator('.add-card .ec-field', { hasText: 'Start' }).locator('input').inputValue();
    ok(/^1[12]:[0-5][05]$/.test(start), `${dev}: its start is where it was clicked, to 5 minutes (${start})`);
    if (dev === 'desk') await p.screenshot({ path: `${S}/tladd-${dev}-card.png` });
    await p.locator('.add-card .ec-field', { hasText: 'Start' }).locator('input').fill('14:30');
    await p.locator('.add-card .ec-field', { hasText: 'End' }).locator('input').fill('14:45');
    await p.locator('.add-card .ec-field', { hasText: 'Entry' }).locator('input').fill('mtg client call');
    await p.locator('.add-card button[type=submit]').click(); await p.waitForTimeout(400);
    ok((await log()).join('|') === '09:00 ACME drawings|10:30 /off|13:00 NORTHSTAR mix|14:30 mtg client call|14:45 NORTHSTAR mix|16:00 /off',
      `${dev}: a call in the middle of a block: the block picks up again after it (${(await log()).join('|')})`);

    // A day with no entries: Add an entry.
    await p.locator('button[title^="Previous"]').first().click();
    await p.waitForTimeout(400);
    if (await p.locator('.tl-add').count()) {
      await p.locator('.tl-add').click(); await p.waitForTimeout(300);
      await p.locator('.add-card .ec-field', { hasText: 'Entry' }).locator('input').fill('ZENITH prep');
      await p.locator('.add-card button[type=submit]').click(); await p.waitForTimeout(400);
      ok((await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).some((e) => e.text === 'ZENITH prep' && new Date(e.ts).getDate() === 6))), `${dev}: an empty day has Add an entry (9:00 that day)`);
    } else ok(false, `${dev}: the day before shows Add an entry`);
    await ctx.close();
  }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
