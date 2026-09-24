# tymlee

A lightweight, text-only time tracker that works like a command line in the browser.

```
> dev fixing the login bug
09:00  in #3 dev fixing the login bug
> mtg standup
09:45  out dev (0:45)  in #4 mtg standup
> dev code review
10:00  out mtg (0:15)  in #5 dev code review
> /log
Thu 2026-09-24
  #  start  end       dur  category  note
  3  09:00  09:45    0:45  dev       fixing login bug
  4  09:45  10:00    0:15  mtg       standup
  5  10:00  now      0:12  dev       code review
  --------------------------------------------------------
  dev         0:57   79%
  mtg         0:15   21%
  total       1:12
```

## How it works

- **Every line is a clock-in and a clock-out.** Typing a line starts a new entry and ends the previous one. The newest entry keeps running, and the status bar at the bottom shows its live timer. To stop without starting something new, use `/off`. The time until your next entry is shown in the log as `(off)` and isn't counted in any totals.
- **The first word is the category.** Everything before the first space is the category (`dev`, `mtg` above). The rest is a free-text note.
- **Tab completion.** Once a category has been used, typing its first letters shows the rest in grey. **Tab** or **→** accepts it, and pressing **Tab** again cycles through the other matches. You can also just type the whole word yourself. Commands complete the same way after `/`.
- **History.** **↑/↓** recalls earlier inputs, like a shell.

## Commands

| Command | |
|---|---|
| `/log [range]` | print the formatted readout (alias `/ls`) |
| `/undo` | remove the last entry (**Ctrl/Cmd+Z** on an empty line does the same) |
| `/off` | clock out without starting anything new; off time isn't counted |
| `/rm <#>` | delete an entry by its number; its time goes to the entry before it |
| `/edit [range]` | edit entries as text; defaults to the last 24 hours |
| `/restore [file]` | add entries from a backup: paste it in, or `/restore file` to pick a `.txt`/`.csv` |
| `/save` | apply `/edit` changes or add `/restore` entries (**Ctrl/Cmd+Enter** in the box) |
| `/cancel` | close `/edit` or `/restore` without changing anything |
| `/export [range] [csv]` | download the readout as `.txt`, or the raw rows as `.csv` |
| `/copy [range]` | copy the readout to the clipboard |
| `/clear` | clear the screen; the log is kept (**Ctrl+L**) |
| `/login <email>` | sign in to sync; emails you a sign-in link and code |
| `/code <code>` | finish signing in by typing the code from that email |
| `/whoami` | show the account and sync state |
| `/sync` | send and fetch changes now (this also happens automatically) |
| `/import` | add entries logged while signed out to your account |
| `/logout` | sign out and remove your synced log from this browser |
| `/link [code]` | add a device: `/link` on a set-up device shows a code, `/link <code>` on the new one uses it |
| `/recover <key>` | set up this device with your recovery key |
| `/recovery` | make a new recovery key (the old one stops working) |
| `/help` | list commands |

Ranges: `today` (the default), `yesterday`, `week` (the last 7 days), `month` (the last 30 days), `all`, `Nd` (the last N days), `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD`.

The `.txt` export is exactly what `/log` prints. It groups entries by the day they started, gives each day a per-category summary, and adds an overall summary when the range covers more than one day. An entry counts toward the day it started on. The CSV has one row per entry: `n,start,end,minutes,category,note`, with ISO 8601 UTC timestamps.

## Editing

`/edit` opens the last 24 hours (or any range, such as `/edit yesterday`) as text:

```
# change a time or text
# delete a line to remove it
# new line: 14:30 dev review
Thu 2026-09-24
  3  09:00  dev fixing login bug
  4  09:45  mtg standup
  5  10:00  dev code review
```

- Change the time or text on a line to update that entry.
- Delete a line to remove the entry.
- Add a line without a number, such as `09:30 email inbox`, to insert an entry. It goes on the day of the header above it.
- The number at the start of a line links it to its entry, so don't change it.

`/save` applies everything at once. If any line has a problem, such as a bad time, a time in the future, or an unknown number, nothing is saved and the problems are listed so you can fix them and `/save` again. `/cancel` leaves the log untouched.

## Backups

`/export all` downloads your whole log as text, and `/export all csv` as a spreadsheet file. Either one can be read back with `/restore`:

- `/restore file` opens a file picker, or `/restore` gives you a box to paste text into. Text copied from `/log` or `/edit` works too.
- The entries are shown for review first. Nothing is added until you `/save`.
- Restoring only adds entries. Anything already in your log (same start minute and text) is skipped, so restoring the same backup twice is harmless and nothing gets deleted.
- If any line can't be read, nothing is added and the problem lines are listed.

Times in the `.txt` backup are in the time zone of the device that exported it, to the minute. The CSV uses UTC timestamps and leaves out off rows, which `/restore` rebuilds from the start and end times.

## Storage and sync

Without any setup, entries are kept in the browser's `localStorage`, on that device only.

When Supabase is configured, each user signs in with `/login` and their log is stored in their own account. The app still works offline first:

- Every change is saved in the browser immediately and queued.
- The queue is sent to Supabase whenever you're signed in and online.
- The account's entries are fetched again every minute, when you switch back to the tab, and when you reconnect. These routine checks only download the last two weeks of entries, so they stay small however long the log gets.
- The whole log is downloaded when the page loads, when you sign in, when you run `/sync`, and at least every six hours. An edit to an older entry made on another device appears then.
- The status bar shows `synced`, `waiting to sync (n)`, `offline` or `not synced`. `/whoami` shows the last error.
- Signing out removes that account's entries from the browser. `/logout` refuses while changes are still unsent, unless you use `/logout force`.

## Encryption

When you're signed in, entry text is encrypted in your browser before it's uploaded, so the database only holds ciphertext. That includes whoever runs the Supabase project. Entry times, the number of entries and your email address are not encrypted.

- **One master key per account.** The first device to sign in creates it and shows a **recovery key** (`XXXXX-XXXXX-XXXXX-XXXXX`). Save that somewhere safe. Nobody can recover it for you.
- **The server stores the master key only in locked form:** once locked with the recovery key, and for 10 minutes locked with a `/link` code while you add a device. The codes are shown on screen and never sent anywhere.
- **Adding a device:** sign in on it (it says it's locked), type `/link` on a device that's already set up, then type the code it shows on the new device. You can use `/recover <key>` instead.
- **Signing out** removes the key from that browser. Signing in again means linking again.
- **Losing every device and the recovery key** means the log can't be decrypted by anyone.
- **`/export`, `/log` and `/restore`** work on the decrypted copy in your browser, so exports are plain text.

The code is in [`public/vault.js`](public/vault.js). It uses AES-GCM with a 256-bit master key, bound to each entry's id, and PBKDF2-SHA-256 (300,000 rounds) for the recovery and link codes. The site's code is served by whoever hosts it, so publishing this repository is how users can check what it does.

While the server hasn't been updated with the `keyring` table from `supabase/schema.sql`, the app keeps syncing without encryption. Encryption switches on at the next full sync after the script has been run.

## Deploy

There is no build step. The website is the static files in `public/`, and `public/vendor/supabase.js` (supabase-js 2.117.1, MIT) is loaded only when sync is configured.

```
npm start        # local server on http://localhost:8000
```

### 1. Create the Supabase project

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste in the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. It is safe to run again after updates; it only adds what's missing. You should see "Success. No rows returned". This creates the `entries` table and row-level security rules so each user can only read and write their own rows.
3. Check that **Project Settings → Data API** is enabled.
4. Click **Connect** at the top of the project (or open **Project Settings → Data API** and **API Keys**). Copy the **Project URL** and the **publishable** key (`sb_publishable_...`, or the legacy `anon` key) into `public/config.js`:

   ```js
   window.TYMLEE_CONFIG = {
     supabaseUrl: 'https://abcdefghijkl.supabase.co',
     supabaseAnonKey: 'sb_publishable_...',
   };
   ```

   The publishable key is meant to be public. The row-level security rules are what protect the data. Never put a **secret** or `service_role` key in this file.

To sign in, type `/login you@example.com`, then either type `/code 123456` with the code from the email, or click the link in it. The link signs in whichever browser opens it, so the code is easier when the email is on a different device.

The code needs the email templates to include it, and Supabase only allows editing templates with a custom email provider. tymlee.date uses [Resend](https://resend.com):

1. In Resend, add and verify the domain, then create an API key with sending access.
2. In Supabase, open **Authentication → Emails → SMTP Settings**, turn on custom SMTP, and fill in:
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: the API key
   - Sender: an address at the verified domain
3. In the **Magic Link** and **Confirm signup** templates, add: `<p>Or type this at the tymlee prompt: <strong>/code {{ .Token }}</strong></p>`

Custom SMTP also lifts Supabase's built-in limit of a few emails per hour. The limit is then set under **Authentication → Rate Limits**.

### 2. Host the files on Cloudflare

The repository contains a `wrangler.jsonc` that tells Cloudflare to publish the `public/` folder as-is.

1. In Cloudflare, go to **Workers & Pages → Create** and choose **Continue with GitHub** (or **Import a repository**). Allow access to this repository and select it.
2. Leave the **Build command** empty. Leave the **Deploy command** as `npx wrangler deploy`.
3. Deploy. You get a URL like `https://tymlee.<your-subdomain>.workers.dev`, and every push redeploys the site.

If you use the older **Pages** flow instead, set the framework preset to *None*, leave the build command empty, and set the output directory to `public`. GitHub Pages, Netlify and other static hosts work the same way: publish the `public/` folder.

### 3. Point Supabase at the site

Open **Authentication → URL Configuration**. Set **Site URL** to your deployed URL and add it under **Redirect URLs**, plus `http://localhost:8000` for local testing. Sign-in links only return to URLs listed there.

Supabase's built-in email sender is rate-limited to a few emails per hour and is meant for testing. For regular use by more than a few people, add your own SMTP provider under **Authentication → Emails → SMTP Settings**.

## Tests

`public/core.js` holds the pure logic: parsing, completion, durations, ranges, the report and CSV formatting, and the sync queue and merge rules. It is tested with Node's built-in test runner. The tests run under `TZ=UTC` so the formatted times are the same on every machine.

```
npm test
```
