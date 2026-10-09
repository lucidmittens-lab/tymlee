#!/usr/bin/env node
// The website's copies of the Supabase and Anthropic libraries
// (public/vendor/) are built from the versions the terminal app pins in
// cli/package.json, so both always run the same code.
//
//   node scripts/vendor.js check    are newer versions out? do the copies
//                                   match the pinned versions? (--strict:
//                                   fail when behind; the monthly workflow)
//   node scripts/vendor.js update   pin the latest versions, reinstall, and
//                                   rebuild public/vendor/ from them
//   node scripts/vendor.js build    rebuild public/vendor/ from cli/node_modules
//
// After an update: npm test, npm run e2e ai ai-gui sync e2ee strict csp, and a
// version bump (it ships in both the website and the terminal app).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli');
const VENDOR = path.join(ROOT, 'public', 'vendor');

const LIBS = [
  {
    pkg: '@supabase/supabase-js',
    file: 'supabase.js',
    license: 'supabase-js.LICENSE',
    // Supabase publishes a browser build; it's used as is.
    build: (mod) => fs.readFileSync(path.join(mod, 'dist', 'umd', 'supabase.js')),
  },
  {
    pkg: '@anthropic-ai/sdk',
    file: 'anthropic.js',
    license: 'anthropic-sdk.LICENSE',
    // Bundled for the browser as window.TymleeAnthropic (public/app.js loads
    // it the first time /ai is used).
    build: () => {
      const entry = path.join(CLI, '.vendor-entry.mjs');
      const out = path.join(os.tmpdir(), `tymlee-anthropic-${process.pid}.js`);
      fs.writeFileSync(entry, "import Anthropic from '@anthropic-ai/sdk';\nglobalThis.TymleeAnthropic = Anthropic;\n");
      try {
        run('npx', ['esbuild', entry, '--bundle', '--minify', '--format=iife', '--platform=browser', `--outfile=${out}`, '--log-level=warning'], CLI);
        return fs.readFileSync(out);
      } finally {
        fs.rmSync(entry, { force: true });
        fs.rmSync(out, { force: true });
      }
    },
  },
];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
  return r.stdout;
}

const pinned = (pkg) => JSON.parse(fs.readFileSync(path.join(CLI, 'package.json'), 'utf8')).dependencies[pkg];
const modDir = (pkg) => path.join(CLI, 'node_modules', ...pkg.split('/'));
const installed = (pkg) => {
  try { return JSON.parse(fs.readFileSync(path.join(modDir(pkg), 'package.json'), 'utf8')).version; } catch (_) { return null; }
};

async function latest(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`);
  if (!res.ok) throw new Error(`npm registry: ${res.status} for ${pkg}`);
  return (await res.json()).version;
}

function ensureInstalled() {
  if (LIBS.every((l) => installed(l.pkg) === pinned(l.pkg))) return;
  console.log('installing the pinned versions in cli/ …');
  run('npm', ['ci', '--no-audit', '--no-fund'], CLI);
}

function build() {
  ensureInstalled();
  for (const l of LIBS) {
    fs.writeFileSync(path.join(VENDOR, l.file), l.build(modDir(l.pkg)));
    fs.copyFileSync(path.join(modDir(l.pkg), 'LICENSE'), path.join(VENDOR, l.license));
    console.log(`public/vendor/${l.file}: ${l.pkg} ${installed(l.pkg)}`);
  }
}

async function check() {
  let behind = 0;
  for (const l of LIBS) {
    const want = pinned(l.pkg);
    let newest = '?';
    try { newest = await latest(l.pkg); } catch (err) { console.log(`  (could not reach npm: ${err.message})`); }
    const old = newest !== '?' && newest !== want;
    if (old) behind++;
    console.log(`${l.pkg}: ${want}${old ? ` · ${newest} is out` : newest === '?' ? '' : ' · up to date'}`);
  }
  // The copies should be exactly what the pinned versions build.
  if (LIBS.every((l) => installed(l.pkg) === pinned(l.pkg))) {
    for (const l of LIBS) {
      const same = Buffer.compare(fs.readFileSync(path.join(VENDOR, l.file)), l.build(modDir(l.pkg))) === 0;
      console.log(`public/vendor/${l.file}: ${same ? 'matches the pinned version' : 'DIFFERS from the pinned version · node scripts/vendor.js build'}`);
      if (!same) process.exitCode = 1;
    }
  } else {
    console.log('(cli/node_modules is missing or out of date, so the copies were not compared: cd cli && npm ci)');
  }
  if (behind) console.log(`${behind} behind · node scripts/vendor.js update, then test (see the top of this file)`);
  if (behind && process.argv.includes('--strict')) process.exitCode = 1; // the monthly GitHub check
}

async function update() {
  const want = [];
  for (const l of LIBS) want.push(`${l.pkg}@${await latest(l.pkg)}`);
  console.log(`pinning ${want.join(' ')}`);
  run('npm', ['install', '--save-exact', '--no-audit', '--no-fund', ...want], CLI);
  build();
  console.log('now: npm test && npm run e2e ai ai-gui sync e2ee strict csp, then bump the version');
}

const what = process.argv[2] || 'check';
const jobs = { check, update, build: async () => build() };
if (!jobs[what]) {
  console.error('usage: node scripts/vendor.js [check|update|build]');
  process.exitCode = 2;
} else {
  jobs[what]().catch((err) => { console.error(err.message || err); process.exitCode = 1; });
}
