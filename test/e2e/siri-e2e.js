// Siri and Shortcuts links: ?say=<what was said> and ?do=<exact line>.
const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const ctx = await b.newContext({ ...devices['iPhone 13'], timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await ctx.clock.install({ time: new Date('2026-10-07T15:10:00-04:00') });
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/index.html');
  const day = (h, m) => new Date(`2026-10-07T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).getTime();
  await p.evaluate((r) => {
    localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r));
    localStorage.setItem('tymlee.v2.local.settings', JSON.stringify({ names: { NORTHSTAR: ['Northstar Pictures'] } }));
    localStorage.setItem('tymlee.view2', 'pure');
    localStorage.setItem('tymlee.homeHint', '1');
  }, [{ id: 'a', ts: day(9, 0), text: 'ACME drawings', sid: 10 }, { id: 'b', ts: day(11, 0), text: 'NORTHSTAR mix', sid: 20 }]);
  const texts = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).filter((e) => !e.deleted).sort((x, y) => x.ts - y.ts).map((e) => e.text));
  const last = async () => (await texts()).slice(-1)[0];
  const say = async (words, wait = 700) => {
    await p.goto(`http://localhost:8123/index.html?say=${encodeURIComponent(words)}`);
    await p.waitForTimeout(wait);
    await ctx.clock.runFor(60000);
  };

  await say('north star color pass');
  ok((await last()) === 'NORTHSTAR color pass', `"north star …" is NORTHSTAR: ${await last()}`);
  ok(!(await p.evaluate(() => location.search)), 'the link is taken off the address');
  await p.reload(); await p.waitForTimeout(600);
  ok((await texts()).filter((t) => t === 'NORTHSTAR color pass').length === 1, 'reloading does not do it again');

  await say('Acne drawings.');
  ok((await last()) === 'ACME drawings', `misheard "Acne" is ACME: ${await last()}`);
  await say('Northstar Pictures stems');
  ok((await last()) === 'NORTHSTAR stems', `a full name (/name) is its category: ${await last()}`);
  await say('switch to Mojo edit');
  ok((await last()) === 'Mojo edit', `a new category stays as said, "switch to" dropped: ${await last()}`);
  await say('Lunch');
  ok((await last()) === '/break-unpaid', 'lunch is an unpaid break');
  await say("I'm back");
  ok((await last()) === 'Mojo edit', `back resumes the last task: ${await last()}`);
  await say('note called the client back');
  const noted = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).filter((e) => !e.deleted).sort((x, y) => x.ts - y.ts).pop());
  ok(noted.text === 'Mojo edit' && noted.notes === 'called the client back', `a note goes on the running entry: ${JSON.stringify(noted)}`);
  await say('clock out');
  ok((await last()) === '/off', 'clock out is /off');
  await p.screenshot({ path: `${S}/siri-phone.png` });

  // ?do=: exact lines, safe ones only.
  const before = (await texts()).length;
  await p.goto('http://localhost:8123/index.html?do=%2Frm%2010'); await p.waitForTimeout(600);
  ok((await texts()).length === before && (await p.locator('.toast').last().textContent()).includes("links can't run /rm"), 'a link cannot remove entries');
  await p.goto('http://localhost:8123/index.html?do=ACME%20invoices'); await p.waitForTimeout(600);
  ok((await last()) === 'ACME invoices', '?do= starts an entry');

  // Anything with a time goes to Ask AI, when it's set up.
  await p.evaluate(() => {
    const s = JSON.parse(tymleeStorage.getItem('tymlee.v2.local.settings') || '{}');
    s.ai = { key: 'sk-ant-api03-TESTKEY000000000000000000000abcd', model: 'haiku' };
    tymleeStorage.setItem('tymlee.v2.local.settings', JSON.stringify(s));
  });
  await p.waitForTimeout(300);
  let asked = null;
  await ctx.route('https://api.anthropic.com/**', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    asked = JSON.parse(r.request().postData());
    const blank = { id: '', date: '', time: '', category: '', title: '', notes: '', wo: '', eq: '', kind: '', name: '', due: '' };
    await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ message: 'Added the call.', changes: [{ ...blank, action: 'add_entry', time: '14:00', category: 'mtg', title: 'call' }] }) }] }) });
  });
  await say('I got pulled into a call at 2', 1500);
  ok(asked && asked.messages[0].content.at(-1).text.includes('Request: I got pulled into a call at 2'), 'a sentence with a time goes to Ask AI');
  ok(await p.locator('.aipanel').isVisible() && (await p.locator('.chat-apply').count()) === 1, 'the AI panel shows its answer, to apply');
  asked = null;
  await say('pick up the thing for the producer', 1500);
  ok(asked && asked.messages[0].content.at(-1).text.includes('Request: pick up the thing for the producer'), 'a phrase that is no category in use goes to Ask AI too');
  await say('ACME revisions', 900);
  ok((await last()) === 'ACME revisions', 'a category in use still starts at once, without the AI');
  await p.screenshot({ path: `${S}/siri-ai.png` });

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
