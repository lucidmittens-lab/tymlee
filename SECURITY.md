# Security

What tymlee protects, from whom, and what it doesn't. For a reviewer, the
places to look are listed at the end.

## What is protected

Your log (entries, their start times, notes, work orders, equipment and file
paths), your settings (including your Claude API key, if you set one), and
your forms, to-dos and checklists are encrypted on your devices before they
are uploaded. The server stores ciphertext.

- **Cipher:** AES-256-GCM with a random 96-bit nonce per write. Each entry is
  bound to its id (additional data), so the server can't move ciphertext from
  one entry to another; settings are bound to the account, records to theirs.
- **Keys:** one random 256-bit master key per account, made on the first
  device. The server only holds it locked: with the recovery key (100 random
  bits, PBKDF2-SHA-256 at 300,000 rounds), and for 10 minutes while adding a
  device, with a `/link` code (60 random bits, same derivation). Codes are
  shown on screen and never sent.
- **On the device:** the master key and a decrypted copy of the log are kept
  in the browser's storage (or, for the terminal app, in files only your user
  can read: folder 700, files 600). Signing out removes both.

## From whom

- **Whoever runs the server, or anyone who gets a copy of the database,** can't
  read the log, settings or records. They do see your email address, how many
  entries and records you have, and when your devices write them (for live
  logging, roughly when you clock in).
- **Other signed-in users** can't read or change your rows: every table has
  row-level security limited to `auth.uid()`, and anonymous access is revoked
  (`supabase/schema.sql`).
- **A server that misbehaves on purpose** can't make the app upload in plain
  text (only the site's own `config.js` can allow that), and anything
  unencrypted it sends back is ignored rather than shown as yours.

## What isn't

- **The site's code is trusted.** The website is served by whoever hosts it:
  if that code were changed, it could read your log as you use it. This is
  true of every web app with end-to-end encryption; publishing this
  repository is how you can check what the site runs. The terminal app,
  once installed, runs the code you installed.
- **Your device is trusted.** Malware or someone with your unlocked device can
  read the decrypted copy and the key. Anything that could run its own
  script in the page could too; the site's content policy (`public/_headers`)
  lets the page run only its own scripts, and the app never inserts text it
  received as HTML.
- **The server can withhold or delete** your synced data, or hand back an
  older copy of an entry. It can't forge new entries or read them.
- **Ask AI** sends what a request needs (your categories, recent entries,
  open to-dos, the files you attach, what you type) to Anthropic with your
  own API key, from your device. Claude's answer is only a proposal: nothing
  changes until you press Apply, and it can't run anything beyond the listed
  kinds of change.
- **The Mac installer isn't signed or notarized by Apple** yet, so macOS warns
  when you open it. Get it only from this repository's Releases page.

## Found and fixed (October 2026 review)

- A server that claimed to have no `keyring` table would have been sent the
  log unencrypted by a newly signed-in device. Now sync stays off unless the
  site's config allows unencrypted sync.
- A device with the key accepted unencrypted entries and settings from the
  server as its own (and re-uploaded them encrypted). Now they're ignored.
- An unused `/link` copy of the key stayed on the server after it expired.
  Now it is removed on the next sync.
- The site had no security headers. It now sends a content policy (own
  scripts only; network access only to Supabase and Anthropic), and refuses
  to be framed.

## For the owner: settings to check in Supabase

- **Authentication → URL Configuration:** only your site's URL (and
  localhost for testing) under Redirect URLs.
- **Authentication → Providers → Email:** a short code/link lifetime, and
  rate limits on, so 6-digit codes can't be guessed.
- **Sign-ups:** anyone can currently make an account on your project (and use
  its storage; they can't see yours). Turn sign-ups off, or allow only
  invited emails, if it's just for you and people you choose.

## For a reviewer

- `public/vault.js`: the cryptography (small; no DOM access).
- `public/store.js`: what is uploaded and how it's read back (`sealRow`,
  `openRow`, `syncSettings`, `syncRecords`), key handling (`prepareVault`,
  `enableEncryption`, `verifyKey`, `createLink`, `unlockWith`,
  `resetEncryption`).
- `supabase/schema.sql`: row-level security and the database's own checks.
- `public/_headers`: the content policy.
- `public/ai.js` and `aiPlan` in `public/commands.js`: what goes to Anthropic
  and how its answer becomes changes.
- Tests: `test/vault.test.js` (the cryptography), and the browser
  tests `test/e2e/e2ee-e2e.js`, `strict-e2e.js` and `csp-e2e.js`.
