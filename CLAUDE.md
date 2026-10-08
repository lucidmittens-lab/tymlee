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

The website is the `public/` folder, deployed by Cloudflare from the branch
`claude/time-tracking-app-bg1ckf` on every push. Database changes go in
`supabase/schema.sql` (safe to run again) and are run by the owner in the
Supabase SQL editor.

## Testing

- `npm test`: the unit tests (seconds). Run after every change.
- `npm run e2e`: the browser and terminal tests related to what changed since
  the live branch (`test/e2e/run.js` maps files to tests). Run before shipping.
- `npm run e2e quick`: a short set that touches everything once.
- `npm run e2e all`: every test (about 10 minutes). Only when shared code
  changed in a way the mapping can't see, or the owner asks.

New behavior gets a check in the related `test/e2e/*-e2e.js` (or a new file
there). Test data uses made-up names only, never the owner's real projects.

## Security

`SECURITY.md` is the threat model. Changes to `vault.js`, `store.js`'s sync
and key handling, `supabase/schema.sql` or `public/_headers` should keep it
true (and `strict-e2e.js`, `e2ee-e2e.js`, `csp-e2e.js` passing).
