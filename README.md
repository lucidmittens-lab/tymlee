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

- **Every line is a clock-in and a clock-out.** Typing a line starts a new entry and ends the previous one. The newest entry keeps running, and the status bar at the bottom shows its live timer.
- **The first word is the category.** Everything before the first space is the category (`dev`, `mtg` above). The rest is a free-text note.
- **Tab completion.** Once a category has been used, typing its first letters shows the rest in grey. **Tab** or **→** accepts it, and pressing **Tab** again cycles through the other matches. You can also just type the whole word yourself. Commands complete the same way after `/`.
- **History.** **↑/↓** recalls earlier inputs, like a shell.

## Commands

| Command | |
|---|---|
| `/log [range]` | print the formatted readout (alias `/ls`) |
| `/undo` | remove the last entry (**Ctrl/Cmd+Z** on an empty line does the same) |
| `/rm <#>` | delete an entry by its number; its time goes to the entry before it |
| `/export [range] [csv]` | download the readout as `.txt`, or the raw rows as `.csv` |
| `/copy [range]` | copy the readout to the clipboard |
| `/clear` | clear the screen; the log is kept (**Ctrl+L**) |
| `/login <email>` | sign in to sync; emails you a sign-in link and code |
| `/code <code>` | finish signing in with the code from that email |
| `/whoami` | show the account and sync state |
| `/sync` | send and fetch changes now (this also happens automatically) |
| `/import` | add entries logged while signed out to your account |
| `/logout` | sign out and remove your synced log from this browser |
| `/help` | list commands |

Ranges: `today` (the default), `yesterday`, `week` (the last 7 days), `month` (the last 30 days), `all`, `Nd` (the last N days), `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD`.

The `.txt` export is exactly what `/log` prints. It groups entries by the day they started, gives each day a per-category summary, and adds an overall summary when the range covers more than one day. An entry counts toward the day it started on. The CSV has one row per entry: `n,start,end,minutes,category,note`, with ISO 8601 UTC timestamps.

## Storage and sync

Without any setup, entries are kept in the browser's `localStorage`, on that device only.

When Supabase is configured, each user signs in with `/login` and their log is stored in their own account. The app still works offline first:

- Every change is saved in the browser immediately and queued.
- The queue is sent to Supabase whenever you're signed in and online.
- The account's entries are pulled back when you run `/sync`, when you switch back to the tab, and every minute.
- The status bar shows `synced`, `waiting to sync (n)`, `offline` or `not synced`. `/whoami` shows the last error.
- Signing out removes that account's entries from the browser. `/logout` refuses while changes are still unsent, unless you use `/logout force`.

## Deploy

There is no build step. The site is the static files in this folder, and `vendor/supabase.js` (supabase-js 2.117.1, MIT) is loaded only when sync is configured.

```
npm start        # local server on http://localhost:8000
```

### 1. Create the Supabase project

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste in [`supabase/schema.sql`](supabase/schema.sql) and run it. This creates the `entries` table and row-level security rules so each user can only read and write their own rows.
3. Open **Authentication → Emails → Magic Link** and add the one-time code to the email body, for example `Or type /code {{ .Token }}`. That lets you sign in by typing the code, which helps when the email opens on a different device or browser from the app.
4. Open **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `config.js`:

   ```js
   window.TYMLEE_CONFIG = {
     supabaseUrl: 'https://abcdefghijkl.supabase.co',
     supabaseAnonKey: 'eyJhbGciOi...',
   };
   ```

   The anon key is meant to be public. The row-level security rules are what protect the data. Never put the `service_role` key in this file.

### 2. Host the files (Cloudflare Pages)

1. In Cloudflare, go to **Workers & Pages → Create → Pages → Connect to Git** and pick this repository.
2. Leave **Framework preset** as *None* and **Build command** empty. Set **Build output directory** to `/`.
3. Deploy. You get a URL like `https://tymlee.pages.dev`, and every push redeploys the site.

GitHub Pages, Netlify or any other static host works the same way.

### 3. Point Supabase at the site

Open **Authentication → URL Configuration**. Set **Site URL** to your deployed URL and add it under **Redirect URLs**, plus `http://localhost:8000` for local testing. Sign-in links only return to URLs listed there.

Supabase's built-in email sender is rate-limited to a few emails per hour and is meant for testing. For regular use by more than a few people, add your own SMTP provider under **Authentication → Emails → SMTP Settings**.

## Tests

`core.js` holds the pure logic: parsing, completion, durations, ranges, the report and CSV formatting, and the sync queue and merge rules. It is tested with Node's built-in test runner. The tests run under `TZ=UTC` so the formatted times are the same on every machine.

```
npm test
```
