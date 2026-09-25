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
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'config.js'), 'utf8'), sandbox);
const config = sandbox.window.TYMLEE_CONFIG || {};

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
  define: { TYMLEE_BUILT_IN_CONFIG: JSON.stringify(config) },
  banner: { js: '// tymlee terminal app, bundled by cli/build.js. Source: https://github.com/lucidmittens-lab/tymlee' },
});
console.log(`built dist/tymlee.cjs (${config.supabaseUrl ? 'with' : 'without'} sync settings)`);
