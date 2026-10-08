const { chromium } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 }, timezoneId: 'America/New_York' });
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/index.html');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('tymlee.view2', 'cli'); });
  await p.reload(); await p.waitForTimeout(400);
  const send = async (t) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(250); };
  const last = () => p.locator('#out pre').last().textContent();
  const stored = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')));
  await send('dev first');
  await send('/eqlink dev ler-resolve-07');
  ok((await last()) === '{ler-resolve-07} linked to dev on ' + (await p.evaluate(() => new Date().toISOString().slice(0, 10))) + ': 1 entry updated' || (await last()).startsWith('{ler-resolve-07} linked to dev on'), `eqlink: ${await last()}`);
  await send('/wolink dev 4471');
  await send('dev second');
  ok((await last()).includes('in ID:000020 [4471] {ler-resolve-07} dev second'), `new entry gets both: ${await last()}`);
  let rows = await stored();
  const link = rows.find((e) => e.text === '/wo dev');
  ok(link && link.wo === '4471' && link.eq === 'ler-resolve-07', 'one hidden link holds both');
  await send('/wolink dev -'); // invalid? use empty via ask instead
  await send('/eqpunch 10 rig-9');
  ok((await last()).includes('{rig-9} set on ID:000010'), `eqpunch: ${await last()}`);
  await send('/eqpunch 10 rig{9}');
  ok((await last()).includes('is not valid equipment'), 'bad equipment explained');
  await send('/eqlink NORTHSTAR ler-resolve-01, ler-resolve-07');
  ok((await last()).startsWith('{ler-resolve-01, ler-resolve-07} linked to NORTHSTAR'), `a list links: ${await last()}`);
  // Unlinking the work order keeps the equipment link.
  await p.fill('#entry', '/wolink dev'); await p.press('#entry', 'Enter'); await p.waitForTimeout(200);
  await p.fill('#entry', ''); await p.press('#entry', 'Enter'); await p.waitForTimeout(250);
  ok((await last()).includes('work order unlinked from dev'), `wo unlinked: ${await last()}`);
  rows = await stored();
  const l2 = rows.find((e) => e.text === '/wo dev');
  ok(l2 && !l2.wo && l2.eq === 'ler-resolve-07', 'link kept for equipment');
  ok(rows.find((e) => e.text === 'dev first').eq === 'rig-9', 'punched equipment kept');
  // /edit keeps equipment; a renamed entry into dev picks up the link.
  await send('mtg standup');
  await send('/edit');
  const ed = p.locator('#out .editor');
  await ed.fill((await ed.inputValue()).replace('mtg standup', 'dev standup').replace('dev first', 'dev first renamed'));
  await ed.press('Control+Enter'); await p.waitForTimeout(250);
  rows = await stored();
  ok(rows.find((e) => e.text === 'dev first renamed').eq === 'rig-9', '/edit keeps punched equipment');
  ok(rows.find((e) => e.text === 'dev standup').eq === 'ler-resolve-07', '/edit picks up the linked equipment');
  // Forms.
  await send('/newform eqf');
  await p.locator('#out .editor').fill('%{each category}\n%{category} %{equipment}\n%{each entry}\n%{title} - %{dur} %{in12}\n%{end}\n%{end}');
  await p.locator('#out .editor').press('Control+Enter'); await p.waitForTimeout(250);
  await send('/form eqf');
  const out = await last();
  ok(/^dev rig-9, ler-resolve-07\nfirst renamed - 0:00 \d{1,2}:\d\d[ap]m\n/.test(out), `form: ${JSON.stringify(out)}`);
  // Timeline and the card.
  await p.evaluate(() => localStorage.setItem('tymlee.view2', 'gui')); await p.reload(); await p.waitForTimeout(500);
  const aria = await p.locator('.tl-block').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  ok(aria.some((a) => a.includes('{rig-9} dev first renamed')), `timeline shows equipment: ${aria}`);
  await p.locator('.tl-block.tl-running').click(); await p.waitForTimeout(200);
  const labels = await p.locator('.entry-card label, .entry-card .ec-field').allTextContents();
  ok(labels.join('|').includes('Equipment'), 'card has an Equipment field');
  ok(await p.locator('.entry-card input').nth(2).inputValue() === 'ler-resolve-07', 'card shows the equipment');
  await p.screenshot({ path: `${S}/eq-card.png` });
  ok(!errs.length, `no errors ${errs}`);
  await b.close();
})();
