const { chromium, devices } = require('playwright');
const S = process.argv[2];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const at = (hm) => new Date(`2026-10-01T${hm}:00-04:00`).getTime();
const blank = { id: '', date: '', time: '', category: '', title: '', notes: '', wo: '', eq: '', kind: '', name: '', due: '' };
const reply = (obj) => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 1, output_tokens: 1 } });
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [dev, opts] of [['desk', { viewport: { width: 1100, height: 760 } }], ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await b.newContext({ ...opts, colorScheme: scheme, timezoneId: 'America/New_York', serviceWorkers: 'block' });
      await ctx.clock.install({ time: new Date('2026-10-07T15:10:00-04:00') });
      await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
      const seen = [];
      await ctx.route('https://api.anthropic.com/**', async (r) => {
        if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        const body = JSON.parse(r.request().postData());
        seen.push(body);
        const pdf = body.messages[0].content[0].type === 'document';
        const changes = pdf
          ? [{ ...blank, action: 'link_wo', category: 'TLWH', wo: '4410021' }, { ...blank, action: 'link_wo', category: 'OOB', wo: '4410022' }, { ...blank, action: 'link_wo', category: 'NORTHSTAR', wo: '4410023' }, { ...blank, action: 'link_wo', category: 'ZENITH', wo: '4410024' }, { ...blank, action: 'link_wo', category: 'MOJO', wo: '4410025' }, { ...blank, action: 'add_name', category: 'TLWH', name: 'The Long Way Home' }]
          : [{ ...blank, action: 'add_entry', time: '14:30', category: 'mtg', title: 'phone call' }, { ...blank, action: 'add_entry', time: '14:50', category: 'TLWH', title: 'finishing' }, { ...blank, action: 'add_entry', time: '15:40', category: 'TLWH', title: 'later' }];
        await new Promise((res) => setTimeout(res, 400));
        await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply({ message: pdf ? 'Linked 5 work orders. Mo-Jo (1–3) is a second hold.' : 'Added the phone call and picked TLWH back up after it.', changes })) });
      });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto('http://localhost:8123/index.html');
      await p.evaluate((r) => { localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r)); localStorage.setItem('tymlee.view2', 'pure'); localStorage.setItem('tymlee.homeHint', '1'); }, [{ id: 'a', ts: new Date('2026-10-07T10:00:00-04:00').getTime(), text: 'TLWH finishing' }]);
      await p.reload(); await p.waitForTimeout(700);
      const tag = `${dev}-${scheme}`;
      const aiOpen = async () => { if (dev === 'phone') await p.locator('.tab[data-tab="ai"]').tap(); else await p.click('.sb-ai'); await p.waitForTimeout(350); };
      ok(!(await p.locator('.tab[data-tab="ai"]').isVisible()) && !(await p.locator('.sb-ai').isVisible()), `${tag}: no key yet: no AI button`);
      if (dev === 'phone') ok((await p.locator('.tab:visible').count()) === 4, `${tag}: four tabs`);
      if (scheme === 'light') await p.screenshot({ path: `${S}/aig-${tag}-bar.png` });
      if (dev === 'desk') { await p.keyboard.press('a'); await p.waitForTimeout(200); ok(!(await p.locator('.aipanel').isVisible()), `${tag}: A does nothing yet`); }
      if (dev === 'phone') await p.locator('.tab[data-tab="menu"]').tap(); else await p.click('.sb-menu');
      await p.waitForTimeout(250);
      await p.locator('.gmenu-tile', { hasText: 'Settings' }).click(); await p.waitForTimeout(350);
      await p.locator('.gset-row', { hasText: 'Set up AI' }).click(); await p.waitForTimeout(300);
      ok((await p.locator('.gsheet-title').textContent()) === 'Set up AI', `${tag}: set up from Menu → Settings`);
      if (scheme === 'light') await p.screenshot({ path: `${S}/aig-${tag}-setup.png` });
      await p.fill('input[name=key]', 'sk-ant-api03-TESTKEY000000000000000000000abcd');
      await p.locator('.gform-range', { hasText: 'Haiku' }).click();
      await p.click('.gform-go'); await p.waitForTimeout(900);
      ok((dev === 'phone' ? await p.locator('.tab[data-tab="ai"]').isVisible() : await p.locator('.sb-ai').isVisible()), `${tag}: now the AI button shows`);
      ok(await p.locator('.aipanel').isVisible() && (await p.locator('.gsheet-wrap').count()) === 0 && (await p.locator('.aip-model').inputValue()) === 'haiku', `${tag}: then the Ask AI panel (no sheet), with the model`);
      ok(dev === 'phone' ? (await p.locator('.tab[data-tab="ai"]').getAttribute('aria-current')) === 'true' : (await p.locator('.sb-ai').getAttribute('aria-pressed')) === 'true', `${tag}: the AI button shows it's open`);
      const panelBox = await p.locator('.aipanel').boundingBox(); const barBox = await p.locator('.startbar').boundingBox();
      ok(panelBox.y + panelBox.height <= barBox.y + 1, `${tag}: the panel sits above the start bar`);
      await p.selectOption('.aip-model', 'sonnet'); await p.waitForTimeout(300);
      ok((await p.locator('.gsheet-wrap').count()) === 0 && (await p.evaluate(() => document.body.innerText)).includes('Ask AI') && (await p.locator('.aip-model').inputValue()) === 'sonnet', `${tag}: changing the model asks for nothing`);
      await p.selectOption('.aip-model', 'haiku'); await p.waitForTimeout(300);
      ok((await p.locator('.chat-msg').count()) === 0 && !(await p.locator('.chat').isVisible()) && (await p.locator('.chat-input').isVisible()), `${tag}: a new chat: just the message box, no hint`);
      await p.fill('.chat-input', 'got interrupted by a phone call 2:30 to 2:50');
      if (scheme === 'light') await p.screenshot({ path: `${S}/aig-${tag}-ask.png` });
      await p.press('.chat-input', 'Enter');
      await p.waitForTimeout(150);
      ok((await p.locator('.chat-msg.me').textContent()) === 'got interrupted by a phone call 2:30 to 2:50' && (await p.locator('.chat-msg.wait').count()) === 1 && (await p.locator('.chat-input').inputValue()) === '', `${tag}: Enter sends: your message, then Claude typing`);
      await p.waitForTimeout(700);
      ok((await p.locator('.chat-msg.ai .chat-text').first().textContent()).includes('picked TLWH back up') && (await p.locator('.chat-input').getAttribute('placeholder')) === 'Reply…', `${tag}: Claude's answer; the box says Reply`);
      // A follow-up: the earlier turn goes along.
      await p.fill('.chat-input', 'the call ended at 2:50');
      await p.press('.chat-input', 'Enter'); await p.waitForTimeout(900);
      ok((await p.locator('.chat-msg').count()) === 4 && (await p.locator('.chat-apply').count()) === 1 && (await p.locator('.gai-list.old').count()) === 1, `${tag}: the chat: 4 messages, Apply only on the latest`);
      const fu = seen[seen.length - 1].messages;
      ok(fu.length === 3 && fu[0].content.at(-1).text === 'Request: got interrupted by a phone call 2:30 to 2:50' && fu[1].role === 'assistant' && fu[1].content[0].text.includes('picked TLWH back up') && fu[2].content[0].text.includes('Follow-up: the call ended at 2:50'), `${tag}: the follow-up carries the conversation`);
      const lastAi = p.locator('.chat-msg.ai').last();
      ok((await lastAi.locator('.gai-change.add').count()) === 2 && (await lastAi.locator('.gai-change.skipped').textContent()).includes("later than now"), `${tag}: the preview, with the future one skipped`);
      await p.screenshot({ path: `${S}/aig-${tag}-preview.png` });
      await p.locator('.chat-apply').click(); await p.waitForTimeout(500);
      ok(!(await p.locator('.aipanel').isVisible()), `${tag}: Apply closes the panel`);
      const texts = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).filter((e) => !e.deleted).map((e) => e.text));
      ok(texts.join('|') === 'TLWH finishing|mtg phone call|TLWH finishing', `${tag}: applied: ${texts.join('|')}`);
      ok((await p.locator('.toast').last().textContent()).includes('Applied 2 changes') && !(await p.locator('.toasts').textContent()).includes('/ai undo'), `${tag}: toast with Undo`);
      await p.locator('.toast-action').last().click(); await p.waitForTimeout(400);
      const t2 = await p.evaluate(() => JSON.parse(tymleeStorage.getItem('tymlee.v2.local.entries')).filter((e) => !e.deleted).map((e) => e.text));
      ok(t2.join('|') === 'TLWH finishing', `${tag}: Undo takes them back`);
      // A PDF.
      await aiOpen();
      ok((await p.locator('.chat-msg').count()) === 0 && !(await p.locator('.chat').isVisible()), `${tag}: after Apply, a new chat`);
      const fc = p.waitForEvent('filechooser');
      await p.click('.gai-attach');
      await (await fc).setFiles([
        { name: 'SCHEDULE_10.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') },
        { name: 'sched.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: require('fs').readFileSync(`${S}/fix-sched.xlsx`) },
        { name: 'take.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF') },
      ]);
      await p.waitForTimeout(400);
      ok((await p.locator('.gai-chip').count()) === 2 && (await p.locator('.gai-chips').textContent()).includes('SCHEDULE_10.pdf') && (await p.locator('.gai-chips').textContent()).includes('sched.xlsx'), `${tag}: two files show as chips`);
      ok((await p.locator('.toast').last().textContent()).includes("take.wav: tymlee can't read this kind of file"), `${tag}: the audio file is refused`);
      if (scheme === 'light') await p.screenshot({ path: `${S}/aig-${tag}-files.png` });
      const fc2 = p.waitForEvent('filechooser');
      await p.click('.gai-attach');
      await (await fc2).setFiles({ name: 'notes.docx', mimeType: 'application/octet-stream', buffer: require('fs').readFileSync(`${S}/fix-notes.docx`) });
      await p.waitForTimeout(300);
      await p.locator('.gai-chip').nth(2).locator('.gai-chip-x').click();
      ok((await p.locator('.gai-chip').count()) === 2, `${tag}: a chip can be removed`);
      await p.click('.chat-send'); await p.waitForTimeout(1100);
      ok((await p.locator('.chat-msg.me .chat-file').count()) === 2 && (await p.locator('.gai-chip').count()) === 0, `${tag}: the files go into your message`);
      const fr = seen[seen.length - 1].messages[0].content;
      ok(fr[0].type === 'document' && fr[0].source.type === 'base64' && fr[1].type === 'document' && fr[1].source.type === 'text' && fr[1].source.data === 'Sheet 1\nWO\tProject\n4410021\tThe Long Way Home' && fr[1].title === 'sched.xlsx', `${tag}: the PDF as is, the sheet as text`);
      ok(seen[seen.length - 1].messages[0].content.at(-1).text.includes('Link the work orders in the attached schedule'), `${tag}: no words: link the work orders`);
      ok((await p.locator('.gai-change').count()) === 6 && (await p.locator('.chat-msg.ai .chat-text').last().textContent()).includes('second hold'), `${tag}: six changes and Claude's note`);
      if (scheme === 'dark' || dev === 'desk') await p.screenshot({ path: `${S}/aig-${tag}-pdf.png` });
      await p.locator('.aip-close').click(); await p.waitForTimeout(200);
      await aiOpen();
      ok((await p.locator('.gai-change').count()) === 6, `${tag}: ✕ then open again: the chat is still there`);
      await p.locator('.aip-new').click(); await p.waitForTimeout(200);
      ok((await p.locator('.gai-change').count()) === 0 && (await p.locator('.gai-chip').count()) === 0 && !(await p.locator('.chat').isVisible()) && !(await p.locator('.aip-new').isVisible()), `${tag}: New chat starts over, empty`);
      await p.locator('.aip-close').click(); await p.waitForTimeout(300);
      // Photos: shrunk to 1568px and sent as JPEG; the camera button on phones only.
      await aiOpen();
      for (const x of await p.locator('.gai-chip-x').all()) await p.locator('.gai-chip-x').first().click();
      ok((await p.locator('.gai-photo').isVisible()) === (dev === 'phone'), `${tag}: the Photo button ${dev === 'phone' ? 'is there' : 'is not shown'}`);
      const png = Buffer.from(await p.evaluate(async () => {
        const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
        const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 3000, 2000);
        const b = await new Promise((r) => c.toBlob(r, 'image/png'));
        return [...new Uint8Array(await b.arrayBuffer())];
      }));
      const fc3 = p.waitForEvent('filechooser');
      await p.click(dev === 'phone' ? '.gai-photo' : '.gai-attach');
      const chooser3 = await fc3;
      if (dev === 'phone') ok(!chooser3.isMultiple(), `${tag}: the camera takes one photo`);
      await chooser3.setFiles({ name: 'IMG_0042.png', mimeType: 'image/png', buffer: png });
      await p.waitForTimeout(500);
      ok((await p.locator('.gai-chip').textContent()).includes('IMG_0042.jpg'), `${tag}: the photo becomes a JPEG`);
      if (dev === 'phone' && scheme === 'light') await p.screenshot({ path: `${S}/aig-${tag}-photo.png` });
      await p.fill('.chat-input', 'add these as to-dos');
      await p.click('.chat-send'); await p.waitForTimeout(1100);
      const img = seen[seen.length - 1].messages[0].content[0];
      const dims = await p.evaluate(async (b64) => { const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob()); return [bmp.width, bmp.height]; }, img.source.data);
      ok(img.type === 'image' && img.source.media_type === 'image/jpeg' && dims.join('x') === '1568x1045', `${tag}: sent at 1568px: ${dims.join('x')}`);
      ok(seen[seen.length - 1].system[0].text.includes('Skip items that are ticked, checked or crossed out'), `${tag}: the handwritten-list rules are sent`);
      await p.locator('.aip-close').click(); await p.waitForTimeout(200);
      if (dev === 'desk') {
        await p.evaluate(() => document.activeElement && document.activeElement.blur());
        await p.keyboard.press('a'); await p.waitForTimeout(300);
        ok(await p.locator('.aipanel').isVisible(), 'A opens Ask AI');
        await p.keyboard.press('Escape'); await p.waitForTimeout(200);
        ok(!(await p.locator('.aipanel').isVisible()), 'Esc closes it');
      }
      await ctx.close();
    }
  }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
