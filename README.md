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
| `/help` | list commands |

Ranges: `today` (the default), `yesterday`, `week` (the last 7 days), `month` (the last 30 days), `all`, `Nd` (the last N days), `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD`.

The `.txt` export is exactly what `/log` prints. It groups entries by the day they started, gives each day a per-category summary, and adds an overall summary when the range covers more than one day. An entry counts toward the day it started on. The CSV has one row per entry: `n,start,end,minutes,category,note`, with ISO 8601 UTC timestamps.

Data is stored in the browser's `localStorage`, so it stays on the device and browser you use. Use `/export` to back it up.

## Hosting

There is no build step and there are no dependencies. The app is four static files (`index.html`, `style.css`, `core.js`, `app.js`). Serve the folder from any static host (GitHub Pages, Netlify, Cloudflare Pages, S3, nginx…) or open `index.html` directly.

```
npm start        # python3 -m http.server 8000
```

## Tests

`core.js` holds the pure logic: parsing, completion, durations, ranges, and the report and CSV formatting. It is tested with Node's built-in test runner. The tests run under `TZ=UTC` so the formatted times are the same on every machine.

```
npm test
```
