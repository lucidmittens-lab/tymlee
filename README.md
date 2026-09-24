# tymlee

A lightweight, text-only time tracker. Type what you're starting, press Enter.

```
dev fixing the login bug
mtg standup
dev code review
lunch
```

- **Every entry is a clock-in and a clock-out.** Each line starts a new event and ends the previous one. The newest entry keeps running.
- **The first word is the category.** Everything before the first space is the category (`dev`, `mtg`, `lunch` above); the rest is a free-text note.
- **Category autocomplete.** Once a category has been used, typing its first letters shows it as an inline completion and a suggestion chip. Press **Tab** (or **→**) to accept, **↑/↓** to pick another, or just keep typing to enter it by hand.
- **Undo.** The Undo button, or **Ctrl/Cmd+Z** on an empty input, removes the last entry and reopens the one before it. Any entry can also be deleted with its `×` button; its time goes to the entry before it.
- **Today's totals** per category and a day-by-day log.
- **Export** downloads the log as plain text (`ISO-timestamp<TAB>entry` per line).

Data is stored in the browser's `localStorage`, so it stays on the device and browser you use.

## Hosting

No build step and no dependencies: it is four static files (`index.html`, `style.css`, `core.js`, `app.js`). Serve the folder from any static host (GitHub Pages, Netlify, Cloudflare Pages, S3, nginx…) or just open `index.html` directly.

To run locally:

```
npm start        # python3 -m http.server 8000
```

## Tests

`core.js` holds the pure logic (parsing, autocomplete, durations, totals) and is tested with Node's built-in test runner:

```
npm test
```
