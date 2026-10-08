const { chromium, devices } = require('playwright');
const S = process.argv[2];
const at = (d, hm) => new Date(`2026-09-${d}T${hm}:00-04:00`).getTime();
const seed = [
  { id: 'a', ts: at('29', '08:00'), text: 'dev payments api refactor', wo: '4471', notes: 'root cause: expired token' },
  { id: 'b', ts: at('29', '09:30'), text: 'mtg standup' },
  { id: 'c', ts: at('29', '10:00'), text: 'dev code review', wo: '4471', notes: 'PR #42' },
  { id: 'd', ts: at('29', '12:00'), text: 'lunch' },
  { id: 'e', ts: at('29', '13:00'), text: 'dev deploy', wo: '4480' },
  { id: 'f', ts: at('29', '15:00'), text: '/off' },
];
const TEMPLATE = `Service report, %{date} (%{day})
Total: %{hours}

%{each wo}
Project: %{category}
Work Order #: %{wo}

Hours: %{hours}
Down Time: %{down}

Worked: %{in}-%{out}

System: %{ask:System}

Session Notes:
%{notes}
%{end}`;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 }, timezoneId: 'America/New_York' });
  await ctx.clock.setFixedTime(new Date('2026-09-30T10:00:00-04:00'));
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await ctx.addInitScript(() => { new MutationObserver(() => document.querySelectorAll('.gmenu-group:not(.open)').forEach((g) => g.classList.add('open'))).observe(document, { childList: true, subtree: true }); }); // tests: every menu section open
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/index.html');
  await p.evaluate((rows) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(rows)); localStorage.setItem('tymlee.view2', 'cli'); }, seed);
  await p.reload(); await p.waitForTimeout(400);
  const send = async (t) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(250); };
  const last = () => p.locator('#out pre').last().textContent();

  await send('/form');
  ok((await last()).includes('forms: none yet') && (await last()).includes('%{each category}'), '/form lists forms and tokens');
  await send('/form service'); ok((await last()).includes('/newform service makes it'), 'unknown form explained');
  await send('/newform'); ok((await last()).includes('usage: /newform'), '/newform needs a name');
  await send('/newform service');
  const ed = p.locator('#out .editor');
  ok(await ed.count() === 1 && (await ed.inputValue()).includes('%{each category}'), 'editor opens with a starter form');
  await ed.fill(`${(await ed.inputValue()).split('\n').filter((l) => l.startsWith('#')).join('\n')}\n\n${TEMPLATE.replace('%{end}', '')}`);
  await ed.press('Control+Enter'); await p.waitForTimeout(200);
  ok((await p.locator('#out pre.err').last().textContent()).includes('without an %{end}'), 'a missing %{end} is caught; nothing saved');
  await ed.fill(TEMPLATE);
  await ed.press('Control+Enter'); await p.waitForTimeout(200);
  ok((await last()).includes('form service saved'), `saved: ${await last()}`);
  await send('/newform service'); ok((await last()).includes('already a form called service'), 'no duplicate names');

  // Fill it in: asks System per work order.
  await p.fill('#entry', '/form service tue'); await p.press('#entry', 'Enter'); await p.waitForTimeout(250);
  ok((await p.locator('#matches').textContent()).includes('System for [4471]'), 'asks System for the first work order');
  await p.fill('#entry', 'Payments v2'); await p.press('#entry', 'Enter'); await p.waitForTimeout(150);
  await p.fill('#entry', 'Deployer'); await p.press('#entry', 'Enter'); await p.waitForTimeout(150);
  await p.fill('#entry', ''); await p.press('#entry', 'Enter'); await p.waitForTimeout(300);
  const out = await last();
  console.log(out);
  ok(out.startsWith('Service report, 2026-09-29 (Tuesday)\nTotal: 7:00\n\nProject: dev\nWork Order #: 4471\n\nHours: 3:30\nDown Time: 0:30\n\nWorked: 08:00-12:00\n\nSystem: Payments v2\n\nSession Notes:\nroot cause: expired token\nPR #42\n\n----'), 'first section');
  ok(out.includes('Work Order #: 4480\n\nHours: 2:00') && out.includes('System: Deployer'), 'second work order');
  ok(/Project: mtg, lunch\nWork Order #: \(none\)\n\nHours: 1:30/.test(out), 'the (none) section, last');
  ok((out.match(/-{40}/g) || []).length === 2, 'dividers between sections');
  // Answers remembered.
  await p.fill('#entry', '/form service 2026-09-29'); await p.press('#entry', 'Enter'); await p.waitForTimeout(250);
  ok(await p.inputValue('#entry') === 'Payments v2', 'last answer offered');
  await p.press('#entry', 'Escape'); await p.waitForTimeout(200);
  ok((await last()).includes('form cancelled'), 'Esc cancels');
  await send('/clock 12');
  await p.fill('#entry', '/form se'); await p.waitForTimeout(150);
  ok((await p.locator('#matches').textContent()).includes('/form service'), 'form names complete');
  await send('/editform service');
  ok((await p.locator('#out .editor').inputValue()).includes('Down Time: %{down}'), '/editform opens it');
  await send('/cancel');
  await send('/form service today'); ok((await last()).includes('no entries (today) · nothing to fill service in from'), 'an empty day says so, without asking');

  // The GUI view: the menu asks in a sheet.
  await send('/clock 24');
  await p.evaluate(() => localStorage.setItem('tymlee.view2', 'pure')); await p.reload(); await p.waitForTimeout(400);
  await p.click('.sb-menu'); await p.waitForTimeout(200);
  await p.locator('.gmenu button', { hasText: 'Fill in a form' }).click(); await p.waitForTimeout(200);
  await p.fill('input[name=day]', 'tue'); await p.click('.gform-go'); await p.waitForTimeout(250);
  const labels = await p.locator('.gform label').allTextContents();
  ok(labels.join('|').includes('System for [4471]') && await p.inputValue('input[name=q0]') === 'Payments v2', `questions in a sheet: ${labels}`);
  await p.fill('input[name=q2]', 'Office'); await p.click('.gform-go'); await p.waitForTimeout(400);
  const sheet = await p.locator('.gsheet-text').allTextContents();
  ok(await p.locator('.gsheet-title').textContent() === 'service' && sheet.join('').includes('System: Office'), 'filled form in a window');
  await p.screenshot({ path: `${S}/forms-gui.png` });
  await p.click('.gsheet-close'); await p.waitForTimeout(200);
  await p.click('.sb-menu'); await p.waitForTimeout(200);
  await p.locator('.gmenu button', { hasText: 'Delete a form' }).click(); await p.waitForTimeout(200);
  await p.click('.gform-go'); await p.waitForTimeout(300);
  await p.click('.sb-menu'); await p.waitForTimeout(200);
  await p.locator('.gmenu button', { hasText: 'Fill in a form' }).click(); await p.waitForTimeout(200);
  ok((await p.locator('.toast, .gtoast').allTextContents()).join().includes('No forms yet'), 'deleted from the menu');
  ok(!errs.length, `no errors ${errs}`);
  await b.close();
})();
