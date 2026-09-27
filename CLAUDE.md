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
