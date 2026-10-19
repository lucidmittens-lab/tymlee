# Notes for working on tymlee

## Versions

`MAJOR.MINOR.PATCH` (semantic versioning), kept in three places that must match
(a unit test checks the first two):

- `public/core.js` (`VERSION`)
- `cli/package.json` (`version`)
- `cli/package-lock.json` (`version`, and `packages[""].version`)

**Every change that ships bumps PATCH by 1** (1.0.2 → 1.0.3), unless the owner
says it's a point release: then MINOR goes up and PATCH resets (1.0.9 → 1.1.0).
MAJOR only changes when the owner asks.

After a version bump that affects the terminal app, the Mac installer is
released by running the "Release terminal app" workflow
(`.github/workflows/release-cli.yml`); it creates the tag `v<version>`.

## Build IDs

The build ID is the commit a copy was built from, shown next to the version.
Nothing to maintain: Cloudflare runs `scripts/stamp-build.js` before each
deploy (the `build` command in `wrangler.jsonc`), which writes
`public/build.js`; the committed `public/build.js` is an empty placeholder.
The Mac installer gets it from `GITHUB_SHA` (`cli/build.js`), and a git
checkout of the terminal app reads its own commit.

## Deploying

Two branches, with different jobs:

- **Production: `claude/time-tracking-app-bg1ckf`.** The website (`public/`) is
  deployed by Cloudflare from this branch on every push. Only Claude pushes
  here, and only when the owner says to ship. Nothing else (bolt.new or any
  other tool) commits to it.
- **Staging: `main`**, the repository's default branch. bolt.new (and any tool
  that syncs to "the default branch") commits here. Nothing deploys from it to
  the website. bolt.new's work reaches production only through Claude: merge
  `main` into the production branch, review it, test it (`npm run e2e`), and
  ship it when the owner says so.

After shipping, bring `main` up to date with production (scheduled
workflows such as `vendor-check.yml` run from the default branch).

Database changes go in `supabase/schema.sql` (safe to run again) and are run
by the owner in the Supabase SQL editor.

## Testing

- `npm test`: the unit tests (seconds). Run after every change.
- `npm run e2e`: the browser and terminal tests related to what changed since
  the live branch (`test/e2e/run.js` maps files to tests). Run before shipping.
- `npm run e2e quick`: a short set that touches everything once.
- `npm run e2e all`: every test (about 10 minutes). Only when shared code
  changed in a way the mapping can't see, or the owner asks.

New behavior gets a check in the related `test/e2e/*-e2e.js` (or a new file
there). Test data uses made-up names only, never the owner's real projects.

## Bundled libraries

`public/vendor/` holds the website's copies of `@supabase/supabase-js` and
`@anthropic-ai/sdk`, built from the versions pinned in `cli/package.json`
(`scripts/vendor.js`). A monthly workflow (`vendor-check.yml`) fails when newer
versions are out or `npm audit` finds a problem; then run
`node scripts/vendor.js update`, test (`npm test`, `npm run e2e ai ai-gui sync
e2ee strict csp`), and ship as a normal version.

## Security

`SECURITY.md` is the threat model. Changes to `vault.js`, `store.js`'s sync
and key handling, `supabase/schema.sql` or `public/_headers` should keep it
true (and `strict-e2e.js`, `e2ee-e2e.js`, `csp-e2e.js`, `passkey-e2e.js` passing).
