const { chromium } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (hm) => new Date(`2026-10-01T${hm}:00-04:00`).getTime();
const reply = (obj) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 1, output_tokens: 1 } });
const blank = { id: '', date: '', time: '', category: '', title: '', notes: '', wo: '', eq: '', kind: '', name: '', due: '' };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1000, height: 820 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await ctx.clock.install({ time: new Date('2026-10-01T15:10:00-04:00') });
  await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  const seen = [];
  let next = null;
  await ctx.route('https://api.anthropic.com/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    seen.push({ url: req.url(), headers: req.headers(), body: JSON.parse(req.postData() || '{}') });
    const out = next || { status: 200, json: reply({ message: 'ok', changes: [] }) };
    await r.fulfill({ status: out.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out.json) });
  });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8123/');
  await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'cli'); }, [{ id: 'a', ts: at('08:30'), text: 'admin email' }, { id: 'b', ts: at('15:00'), text: 'mtg wrong one' }]);
  await p.reload(); await p.waitForTimeout(500);
  const send = async (t, w = 250) => { await p.fill('#entry', t); await p.press('#entry', 'Enter'); await p.waitForTimeout(w); };
  const last = () => p.locator('#out pre').last().textContent();
  const texts = () => p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).filter((e) => !e.deleted && !/^\/(wo|eq) /.test(e.text)).sort((x, y) => x.ts - y.ts).map((e) => `${new Date(e.ts).toTimeString().slice(0, 5)} ${e.text}${e.wo ? ` [${e.wo}]` : ''}`));
  await send('/ai do things');
  ok((await last()).includes('no API key yet'), 'no key: explains');
  await send('/aikey nope');
  ok((await last()).includes('does not look like'), 'a bad key is refused');
  await send('/aikey sk-ant-api03-TESTKEY000000000000000000000abcd');
  ok((await last()).startsWith('API key sk-ant-…abcd saved'), `key saved, masked: ${await last()}`);
  await send('/name ACME Acme Architecture Group');
  await send('/names');
  ok((await last()) === 'ACME = Acme Architecture Group', '/name and /names');
  // A plain-language request.
  next = { status: 200, json: reply({ message: 'Logged the morning and fixed the 3pm entry.', changes: [
    { ...blank, action: 'add_entry', time: '09:00', category: 'NORTHSTAR', title: 'mix revisions', wo: '4471' },
    { ...blank, action: 'break', time: '11:00', kind: 'unpaid' },
    { ...blank, action: 'add_entry', time: '12:30', category: 'ACME', title: 'drawings review' },
    { ...blank, action: 'edit_entry', id: '000020', category: 'mtg', title: 'client call' },
    { ...blank, action: 'link_wo', category: 'ACME', wo: '5120' },
    { ...blank, action: 'add_todo', category: 'ACME', title: 'send markups', due: 'tomorrow' },
    { ...blank, action: 'add_name', category: 'NORTHSTAR', name: 'Northstar Productions' },
    { ...blank, action: 'edit_entry', id: '999999', title: 'x' },
  ] }) };
  await send('/ai 9-11 SP mix revisions WO 4471, lunch, ACME drawings from 12:30, the 3pm thing was a client call', 600);
  const req = seen[seen.length - 1];
  ok(req.body.model === 'claude-opus-5-5' && req.body.output_config.format.type === 'json_schema' && req.body.output_config.effort === 'low' && req.body.fallbacks === 'default', 'request: model, structured output, effort, fallbacks');
  ok((req.headers['anthropic-beta'] || '').includes('server-side-fallback-2026-07-01') && req.headers['x-api-key'] === 'sk-ant-api03-TESTKEY000000000000000000000abcd' && 'anthropic-dangerous-direct-browser-access' in req.headers, 'request headers: beta, the key, direct browser access');
  const ctxText = req.body.messages[0].content.find((c) => c.type === 'text').text;
  ok(ctxText.includes('ACME = Acme Architecture Group') && ctxText.includes('000020  2026-10-01 15:00-now  mtg wrong one') && ctxText.includes('Request: 9-11 SP mix'), 'Claude gets categories with full names, recent entries with IDs, the request');
  const preview = await p.locator('#out pre').nth(-1).textContent();
  const all = await p.locator('#out').textContent();
  ok(all.includes('Claude: Logged the morning and fixed the 3pm entry.') && all.includes('+ 09:00  NORTHSTAR mix revisions  [4471]') && all.includes('+ 11:00  (unpaid break)') && all.includes('~ ID:000020 15:00 mtg wrong one: "mtg wrong one" → "mtg client call"') && all.includes('link [5120] → ACME') && all.includes('to-do ACME send markups (due tomorrow)') && all.includes('name NORTHSTAR = Northstar Productions') && all.includes('skipped: no entry 999999'), `the preview lists every change: ${all.slice(-900)}`);
  await p.screenshot({ path: `${S}/ai-preview.png` });
  ok((await texts()).length === 2, 'nothing is saved before confirming');
  await send('y', 600);
  const t1 = await texts();
  ok(t1.join('|') === '08:30 admin email|09:00 NORTHSTAR mix revisions [4471]|11:00 /break-unpaid|12:30 ACME drawings review [5120]|15:00 mtg client call', `applied: ${t1.join('|')}`);
  await send('/names');
  ok((await last()).includes('NORTHSTAR = Northstar Productions'), 'the suggested full name is kept');
  await send('/todos');
  ok((await last()).includes('ACME') && (await last()).includes('send markups'), 'the to-do is added');
  await p.screenshot({ path: `${S}/ai-applied.png` });
  await send('/ai undo', 400);
  ok((await texts()).join('|') === '08:30 admin email|15:00 mtg wrong one', `/ai undo takes back the entry changes: ${(await texts()).join('|')}`);
  // Nothing later than now (it's 15:10): an interruption that "ends" at 15:40 is refused.
  next = { status: 200, json: reply({ message: 'Added the interruption.', changes: [
    { ...blank, action: 'add_entry', time: '15:05', category: 'mtg', title: 'phone call' },
    { ...blank, action: 'add_entry', time: '15:40', category: 'mtg', title: 'wrong one' },
    { ...blank, action: 'edit_entry', id: '000010', time: '16:00' },
  ] }) };
  await send('/ai I got interrupted by a phone call at 3:05 for half an hour', 600);
  const fut = await p.locator('#out').textContent();
  ok(fut.includes('+ 15:05  mtg phone call') && fut.includes("skipped: mtg wrong one at 15:40: that's later than now") && fut.includes("skipped: moving ID:000010 to 16:00: that's later than now"), `future times are skipped: ${fut.slice(-400)}`);
  ok(seen[seen.length - 1].body.system[0].text.includes('Never add or move anything to a time later than now'), 'the instructions say so too');
  await send('y', 500);
  ok((await texts()).join('|') === '08:30 admin email|15:00 mtg wrong one|15:05 mtg phone call', `only the past one is added: ${(await texts()).join('|')}`);
  await send('/ai undo', 400);
  // A note goes under the entry; the title stays.
  next = { status: 200, json: reply({ message: 'Noted.', changes: [{ ...blank, action: 'edit_entry', id: '000020', notes: 'client wants a recut of reel 2' }] }) };
  await send('/ai add a note to the current entry: client wants a recut of reel 2', 600);
  ok((await p.locator('#out').textContent()).includes('~ ID:000020 15:00 mtg wrong one: + notes "client wants a recut of reel 2"'), 'the preview shows a note added, no rename');
  ok(seen[seen.length - 1].body.system[0].text.includes('it goes in notes, never in title'), 'the glossary is sent');
  await send('y', 500);
  const noted = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).find((e) => e.text === 'mtg wrong one'));
  ok(noted && noted.notes === 'client wants a recut of reel 2', `the note is on the entry, the title unchanged: ${JSON.stringify(noted)}`);
  next = { status: 200, json: reply({ message: 'Noted.', changes: [{ ...blank, action: 'edit_entry', id: '000020', notes: '> and the logo swap' }] }) };
  await send('/ai also note the logo swap', 600);
  ok(seen[seen.length - 1].body.messages[0].content.at(-1).text.includes('mtg wrong one\n        > client wants a recut of reel 2'), 'Claude sees the notes already there');
  await send('y', 500);
  const noted2 = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).find((e) => e.text === 'mtg wrong one'));
  ok(noted2.notes === 'client wants a recut of reel 2\nand the logo swap', `notes are added to, not replaced: ${JSON.stringify(noted2.notes)}`);
  await send('/ai undo', 400);
  // Declining.
  next = { status: 200, json: reply({ message: 'Which day?', changes: [] }) };
  await send('/ai fix tuesday', 600);
  ok((await last()).includes('Claude: Which day?'), 'a question comes back with no changes');
  next = { status: 200, json: reply({ message: 'ok', changes: [{ ...blank, action: 'off', time: '15:08' }] }) };
  await send('/ai off at 4', 600);
  await send('n', 300);
  ok((await last()) === 'nothing changed' && (await texts()).length === 2, 'n: nothing changed');
  // A PDF.
  next = { status: 200, json: reply({ message: 'Linked 1 work order.', changes: [{ ...blank, action: 'link_wo', category: 'ACME', wo: '7001', date: '2026-10-02' }] }) };
  const chooser = p.waitForEvent('filechooser');
  await p.fill('#entry', '/ai file link the work orders'); await p.press('#entry', 'Enter');
  await (await chooser).setFiles([{ name: 'schedule.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') }, { name: 'board.png', mimeType: 'image/png', buffer: Buffer.from('PNGDATA') }]);
  await p.waitForTimeout(700);
  const pdfReq = seen[seen.length - 1].body;
  ok(pdfReq.messages[0].content[0].type === 'document' && pdfReq.messages[0].content[0].source.media_type === 'application/pdf' && pdfReq.output_config.effort === 'medium', 'the PDF goes as a document; effort medium');
  ok(pdfReq.messages[0].content[1].type === 'image' && pdfReq.messages[0].content[1].source.media_type === 'image/png' && pdfReq.messages[0].content[2].text === '(The image above is board.png.)', 'the photo goes as an image, named');
  ok((await p.locator('#out').textContent()).includes('asking Claude Opus 5.5 about schedule.pdf, board.png'), 'says which files');
  await send('y', 500);
  await send('/wolist 2026-10-02');
  ok((await last()).includes('7001'), `the link applies to that day: ${await last()}`);
  // Errors.
  next = { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
  await send('/ai anything', 800);
  ok((await last()).includes('Anthropic refused the API key'), `401 explained: ${await last()}`);
  await send('/aimodel haiku');
  next = { status: 200, json: reply({ message: 'ok', changes: [] }) };
  await send('/ai hi', 600);
  const hreq = seen[seen.length - 1];
  ok(hreq.body.model === 'claude-haiku-4-5' && !hreq.body.fallbacks && !hreq.body.output_config.effort && !(hreq.headers['anthropic-beta'] || '').includes('fallback'), 'haiku: no effort, no fallbacks');
  await send('/aikey');
  ok((await last()).includes('model Claude Haiku 4.5'), '/aikey shows the model');
  await send('/aikey off');
  await send('/ai x');
  ok((await last()).includes('no API key yet'), 'key removed');
  await send('/help ai');
  ok((await last()).startsWith('AI (your own Claude API key):'), '/help ai');
  ok(!errs.length, 'no page errors ' + errs.join('|'));
  await b.close();
})();
