#!/usr/bin/env node
// Runs the browser (Playwright) and terminal (pty) tests. Prints one line per
// test file, and the failures.
//
//   node test/e2e/run.js            the tests for what changed since the
//                                   live branch (plus a few that cover a lot)
//   node test/e2e/run.js quick      a short set that touches everything once
//   node test/e2e/run.js all        every test
//   node test/e2e/run.js ai sync    these tests (names without -e2e.js / .py)
//
// Needs Playwright (npm i -g playwright; or set NODE_PATH to where it is),
// Python 3 with pyte for the terminal tests (pip install pyte), and a
// Chromium Playwright can find. Browser tests run a few at a time; terminal
// tests one at a time (they share a fake server).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '../..');
const PUBLIC = path.join(ROOT, 'public');
const LIVE = 'origin/claude/time-tracking-app-bg1ckf';
const PORT = 8123;
const PARALLEL = Math.max(1, Math.min(3, os.cpus().length - 1));
const TIMEOUT_MS = 300000;

const browserTests = fs.readdirSync(HERE).filter((f) => f.endsWith('-e2e.js')).map((f) => f.replace(/-e2e\.js$/, ''));
const ptyTests = fs.readdirSync(HERE).filter((f) => /^pty_.*\.py$/.test(f)).map((f) => f.replace(/\.py$/, ''));
// cli-web shares the terminal tests' fake server file, so it runs with them.
const SERIAL = new Set([...ptyTests, 'cli-web']);

// A short set that touches every part once.
const QUICK = ['pure', 'sync', 'strict', 'e2ee', 'ai-gui', 'csp', 'todo-do', 'pty_test'];

// Which tests a changed file calls for. 'all': everything.
const RULES = [
  [/^public\/(core|commands|store|vault|idb)\.js$/, 'all'],
  [/^public\/(gui|timeline|app)\.js$|^public\/(style\.css|index\.html)$/, browserTests],
  [/^public\/ai\.js$/, ['ai', 'ai-gui', 'csp', 'pty_ai']],
  [/^public\/sw\.js$/, ['offline', 'csp']],
  [/^public\/(_headers|vendor\/)/, ['csp', 'ai', 'sync']],
  [/^cli\//, [...ptyTests, 'cli-web']],
  [/^supabase\//, ['strict', 'e2ee', 'sync', 'records', 'settings']],
];

function changedFiles() {
  const base = spawnSync('git', ['merge-base', 'HEAD', LIVE], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const range = base ? [base] : ['HEAD'];
  const committed = spawnSync('git', ['diff', '--name-only', ...range], { cwd: ROOT, encoding: 'utf8' }).stdout;
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout;
  return [...new Set(`${committed}\n${untracked}`.split('\n').filter(Boolean))];
}

function pick(args) {
  const all = [...browserTests, ...ptyTests];
  if (args[0] === 'all') return all;
  if (args[0] === 'quick') return QUICK;
  if (args.length) {
    const unknown = args.filter((a) => !all.includes(a));
    if (unknown.length) throw new Error(`no test called ${unknown.join(', ')} · tests: ${all.join(' ')}`);
    return args;
  }
  const want = new Set();
  const files = changedFiles();
  for (const f of files) {
    const own = f.match(/^test\/e2e\/(.+?)(-e2e\.js|\.py)$/);
    if (own) want.add(own[1]);
    for (const [re, tests] of RULES) {
      if (!re.test(f)) continue;
      if (tests === 'all') return all;
      tests.forEach((t) => want.add(t));
    }
  }
  console.log(`changed since ${LIVE}: ${files.length ? files.join(' ') : 'nothing'}`);
  return [...want].filter((t) => all.includes(t));
}

// The site, as Cloudflare serves it (static files from public/).
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };
function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(PUBLIC, url.endsWith('/') ? `${url}index.html` : url);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => resolve(server));
  });
}

function runOne(name, work) {
  const browser = !name.startsWith('pty_');
  const cmd = browser ? process.execPath : 'python3';
  const file = path.join(HERE, browser ? `${name}-e2e.js` : `${name}.py`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, [file, work], { cwd: ROOT, env: { ...process.env, NODE_PATH: nodePath() } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const pass = (out.match(/^PASS/gm) || []).length;
      const fails = out.split('\n').filter((l) => /^FAIL|Error|Timeout/.test(l));
      const bad = code !== 0 || fails.some((l) => l.startsWith('FAIL'));
      resolve({ name, pass, fails, bad, code, secs: Math.round((Date.now() - started) / 1000) });
    });
  });
}

// Playwright from NODE_PATH, a global install, or this machine's usual place.
function nodePath() {
  const tried = [process.env.NODE_PATH, '/opt/node22/lib/node_modules', path.join(path.dirname(process.execPath), '../lib/node_modules')].filter(Boolean);
  return tried.join(path.delimiter);
}

async function main() {
  const names = pick(process.argv.slice(2));
  if (!names.length) {
    console.log('no browser or terminal tests needed for these changes (the unit tests: npm test)');
    return;
  }
  // A fresh folder each run: the fixtures, and whatever the tests write.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tymlee-e2e-'));
  for (const f of fs.readdirSync(path.join(HERE, 'fixtures'))) fs.copyFileSync(path.join(HERE, 'fixtures', f), path.join(work, f));
  fs.chmodSync(path.join(work, 'fake-editor.sh'), 0o755);
  const server = await serve();
  console.log(`running ${names.length}: ${names.join(' ')} (screenshots in ${work})`);
  const started = Date.now();
  const results = [];
  const report = (r) => {
    results.push(r);
    console.log(`${r.bad ? 'FAIL' : 'ok  '} ${r.name}: ${r.pass} passed${r.bad ? `, exit ${r.code}` : ''} (${r.secs}s)`);
    if (r.bad) r.fails.slice(0, 8).forEach((l) => console.log(`       ${l.slice(0, 300)}`));
  };
  const parallel = names.filter((n) => !SERIAL.has(n));
  const serial = names.filter((n) => SERIAL.has(n));
  const lane = async (queue) => { while (queue.length) report(await runOne(queue.shift(), work)); };
  await Promise.all([
    ...Array.from({ length: PARALLEL }, () => lane(parallel)),
    (async () => { for (const n of serial) report(await runOne(n, work)); })(),
  ]);
  server.close();
  const failed = results.filter((r) => r.bad);
  console.log(`${failed.length ? `${failed.length} FAILED: ${failed.map((r) => r.name).join(' ')}` : 'all passed'} · ${results.length} files in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => { console.error(err.message || err); process.exitCode = 2; });
