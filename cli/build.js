#!/usr/bin/env node
// Builds the packaged terminal app: one file with everything the app needs
// (cli/, the shared code in public/, supabase-js), and the website's Supabase
// settings built in. build/pkg.sh turns it into a single executable and a
// macOS installer (.pkg).
//
//   node build.js            ->  dist/tymlee.cjs
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'config.js'), 'utf8'), sandbox);
const config = sandbox.window.TYMLEE_CONFIG || {};
// The build ID: the commit this was built from.
let commit = process.env.GITHUB_SHA || '';
if (!commit) {
  try { commit = execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { /* none */ }
}

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'tymlee.js')],
  outfile: path.join(__dirname, 'dist', 'tymlee.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  define: { TYMLEE_BUILT_IN_CONFIG: JSON.stringify(config), TYMLEE_BUILT_COMMIT: JSON.stringify(commit) },
  banner: { js: '// tymlee terminal app, bundled by cli/build.js. Source: https://github.com/lucidmittens-lab/tymlee' },
});
console.log(`built dist/tymlee.cjs (build ${commit.slice(0, 7) || 'unknown'}, ${config.supabaseUrl ? 'with' : 'without'} sync settings)`);
