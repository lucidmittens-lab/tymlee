// Preview screenshots of the current build, desktop and phone, light and dark.
// Run: PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node scripts/preview.js <folder>
const { chromium, devices } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PUBLIC = path.resolve(__dirname, '../public');
const OUT = process.argv[2] || '/tmp/tymlee-preview';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

const at = (hm) => new Date(`2026-10-01T${hm}:00-04:00`).getTime();
const day = (d, hm) => new Date(`2026-${d}T${hm}:00-04:00`).getTime();
const seed = [
  { id: 'a', ts: at('08:30'), text: 'admin email and planning' },
  { id: 'b', ts: at('09:00'), text: 'NORTHSTAR mix revisions', wo: '4471', notes: 'vocals up 1 dB' },
  { id: 'c', ts: at('10:45'), text: '/break-paid' },
  { id: 'd', ts: at('11:00'), text: 'ACME drawings review' },
  { id: 'e', ts: at('12:15'), text: '/break-unpaid' },
  { id: 'f', ts: at('12:45'), text: 'mtg client call' },
  { id: 'g', ts: at('13:10'), text: '/off' },
  { id: 'h', ts: day('09-30', '09:15'), text: 'NORTHSTAR stem export', wo: '4471' },
  { id: 'i', ts: day('09-30', '13:00'), text: 'ACME site visit' },
  { id: 'j', ts: day('09-28', '10:00'), text: 'admin invoices' },
];

fs.mkdirSync(OUT, { recursive: true });
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(PUBLIC, url.endsWith('/') ? `${url}index.html` : url);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
});

(async () => {
  await new Promise((r) => server.listen(8143, r));
  const b = await chromium.launch();
  try {
    for (const [dev, opts] of [
      ['desktop', { viewport: { width: 1280, height: 800 } }],
      ['phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 760 } }],
    ]) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await b.newContext({ ...opts, colorScheme: scheme, timezoneId: 'America/New_York', serviceWorkers: 'block' });
        await ctx.clock.install({ time: new Date('2026-10-01T13:40:00-04:00') });
        await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
        const p = await ctx.newPage();
        const tag = `${dev}-${scheme}`;
        const shot = async (n) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(OUT, `${tag}-${n}.png`) }); };
        const click = async (sel) => { try { await p.click(sel, { timeout: 2000 }); } catch (_) { /* optional */ } };
        await p.goto('http://localhost:8143/index.html');
        await p.evaluate((r) => {
          localStorage.setItem('tymlee.v2.local.entries', JSON.stringify(r));
          localStorage.setItem('tymlee.view2', 'pure');
          localStorage.setItem('tymlee.v2.local.settings', JSON.stringify({ rate: '45', otmin: '40' }));
        }, seed);
        await p.reload(); await p.waitForTimeout(900);
        await shot('1-running');
        if (dev === 'desktop') {
          await click('.sb-menu');
          await shot('2-menu');
          await p.keyboard.press('Escape');
          await p.keyboard.press('/');
          await shot('3-find');
        } else {
          await click('.tab[data-tab="todo"]');
          await shot('2-todo');
          await click('.tab[data-tab="menu"]');
          await shot('3-menu');
          await click('.tab[data-tab="timeline"]');
          await click('.sb-new');
          await shot('4-compose');
        }
        await ctx.close();
      }
    }
  } finally {
    await b.close();
    server.close();
  }
  console.log(OUT);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
