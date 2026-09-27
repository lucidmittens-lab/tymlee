#!/usr/bin/env node
// Writes public/build.js with the commit being deployed, so the site can show
// which build it is (next to the version). Cloudflare runs this before each
// deploy (wrangler.jsonc "build"). It never fails the deploy: without a
// commit to stamp, the site just shows no build ID.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function commit() {
  if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (_) {
    return '';
  }
}

try {
  const sha = /^[0-9a-f]{7,40}$/.test(commit()) ? commit() : '';
  const build = sha ? { commit: sha, at: new Date().toISOString() } : null;
  fs.writeFileSync(
    path.join(__dirname, '..', 'public', 'build.js'),
    `// Written by scripts/stamp-build.js when the site is deployed.\nwindow.TYMLEE_BUILD = ${JSON.stringify(build)};\n`,
  );
  console.log(sha ? `stamped build ${sha.slice(0, 7)}` : 'no commit found; build ID left empty');
} catch (err) {
  console.log(`could not stamp the build (${err.message}); deploying without a build ID`);
}
process.exit(0);
