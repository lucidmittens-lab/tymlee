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

## Deploying

The website is the `public/` folder, deployed by Cloudflare from the branch
`claude/time-tracking-app-bg1ckf` on every push. Database changes go in
`supabase/schema.sql` (safe to run again) and are run by the owner in the
Supabase SQL editor.
