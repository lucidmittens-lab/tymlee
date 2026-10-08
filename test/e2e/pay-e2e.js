const { chromium, devices } = require('playwright');
const S = process.argv[2];
const at = (d, hm) => new Date(`2026-09-${d}T${hm}:00-04:00`).getTime();
// Mon 21 - Thu 24: 9h a day (36h), Friday from 09:00 (running at 15:20).
const seed = [];
for (const d of ['21', '22', '23', '24']) seed.push({ id: `w${d}`, ts: at(d, '08:00'), text: 'dev work' }, { id: `o${d}`, ts: at(d, '17:00'), text: '/off' });
seed.push({ id: 'fri', ts: at('25', '09:00'), text: 'dev friday' });
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 700 }, timezoneId: 'America/New_York' });
  await ctx.clock.setFixedTime(new Date('2026-09-25T15:20:00-04:00'));
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/index.html');
  await p.evaluate((rows) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(rows)); localStorage.setItem('tymlee.view2', 'cli'); }, seed);
  await p.reload(); await p.waitForTimeout(400);
  const send = async (t) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(300); };
  const last = () => p.locator('#out pre').last().textContent();
  const status = () => p.locator('#status').textContent();
  ok(!(await status()).includes('$'), 'no money without a rate');
  await send('/rate'); ok((await last()).includes('rate is not set'), '/rate shows it is not set');
  await send('/rate abc'); ok((await last()).includes('not a number'), 'bad rate explained');
  await send('/rate $30'); ok((await last()).includes('rate: $30.00 an hour') && (await last()).includes('/otmin'), `/rate sets it: ${await last()}`);
  await p.waitForTimeout(1100);
  let st = await status();
  // Friday 09:00-15:20 = 6h20m = $190.00; today the same.
  ok(/▶ 6:20:00\s+\$190\.00/.test(st), `status shows this entry's pay: ${st}`);
  ok(/today 6:20\s+\$190\.00 · since 09:00/.test(st), 'and today\'s pay next to today\'s time');
  await send('/otmin 40'); ok((await last()).includes('overtime after 40 hours a week (Sunday to Saturday), paid at 1.5×'), `/otmin: ${await last()}`);
  await p.waitForTimeout(1100);
  st = await status();
  // 36h before Friday: 4h regular ($120) + 2h20m overtime at $45 ($105) = $225.
  ok(/\$225\.00 OT/.test(st) && (await p.locator('#status .money.ot').count()) === 1, `overtime shows: ${st}`);
  await send('/otrate 2'); await p.waitForTimeout(1100);
  ok(/\$260\.00 OT/.test(await status()), `/otrate 2: ${await status()}`); // 120 + 140
  await send('/otrate 0.5'); ok((await last()).includes('between 1 and 10'), 'bad factor explained');
  await send('/rate 40'); ok((await last()).includes('from now on'), 'changing the rate keeps earlier time');
  await send('/off'); await p.waitForTimeout(1100);
  ok(/today 6:20\s+\$260\.00/.test(await status()), `off: today's pay stays: ${await status()}`);
  await send('/rate off'); await p.waitForTimeout(1100);
  ok((await last()).includes('turned off'), '/rate off');
  await p.reload(); await p.waitForTimeout(600);
  await send('/otmin'); ok((await last()).includes('overtime after 40 hours'), 'settings are kept after a reload');
  await send('/help'); ok((await p.locator('#out').textContent()).includes('/otrate'), '/help lists them');
  ok(errs.length === 0, `no errors ${errs}`);
  await b.close();
})();
