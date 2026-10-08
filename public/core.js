// Pure time-log logic and report formatting. No DOM access here so it can be
// unit tested in Node. All dates are interpreted in the local time zone.
(function (root) {
  'use strict';

  // The app's version (the website and the terminal app share it; cli/package.json
  // says the same) and where its code is.
  const VERSION = '1.9.9';
  const REPO_URL = 'https://github.com/lucidmittens-lab/tymlee';

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const FULL_DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  // /off is stored as an entry with this text. Typed entries can never start
  // with "/" (that is a command), so it cannot clash with a real entry. Time
  // from an off marker to the next entry is not tracked.
  const OFF = '/off';
  // Breaks: an unpaid one is time off (not counted, like /off); a paid one
  // counts toward hours and pay, on a line of its own.
  const BREAK_PAID = '/break-paid';
  const BREAK_UNPAID = '/break-unpaid';
  // Entries that are commands rather than work, and how they're shown.
  const MARKERS = { [OFF]: '(off)', [BREAK_UNPAID]: '(unpaid break)', [BREAK_PAID]: '(paid break)' };
  const isMarker = (text) => Object.prototype.hasOwnProperty.call(MARKERS, text);
  const markerFor = (label) => Object.keys(MARKERS).find((k) => MARKERS[k] === label) || null;
  // Longest entry text and notes accepted (the server allows room for
  // encryption).
  const MAX_TEXT = 1000;
  const MAX_NOTES = 8000; // needs the 64000 limit in supabase/schema.sql (an encrypted entry holds text and notes)

  // Work orders: a short code per entry (no spaces or brackets), shown as
  // "[4471]" in a column before the start time.
  const MAX_WO = 40;
  const validWo = (wo) => typeof wo === 'string' && /^[^\s\[\]]{1,40}$/.test(wo);
  const woTag = (wo) => (wo ? `[${wo}]` : '');

  // Equipment: one or more names separated by commas ("ler-resolve-01,
  // ler-resolve-07"), set per entry with /eqpunch or per category and day
  // with /eqlink. Shown as "{ler-resolve-01, ler-resolve-07}".
  const eqTag = (eq) => (eq ? `{${eq}}` : '');
  const MAX_EQ = 200;
  const eqNames = (eq) => (eq ? String(eq).split(',').map((n) => n.trim()).filter(Boolean) : []);

  // Typed equipment -> "a, b" (repeats dropped), or null if a name is too
  // long or has brackets, or the list is too long.
  function normalizeEq(text) {
    const names = [];
    for (const raw of String(text || '').trim().replace(/^\{(.*)\}$/, '$1').split(',')) {
      const name = raw.trim().replace(/\s+/g, ' ');
      if (!name) continue;
      if (name.length > MAX_WO || /[[\]{}]/.test(name)) return null;
      if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    const eq = names.join(', ');
    return eq.length > MAX_EQ ? null : eq;
  }
  const EQ_RULES = `names up to ${MAX_WO} characters, separated by commas, no brackets`;

  // Entry IDs: a number each entry keeps for good, shown with six digits
  // ("015620"). New entries get the next multiple of 10; one added between
  // two others (in /edit, or from a backup) takes the next free number after
  // the one before it (015621 ... 015629) when there is room, and after
  // those, a three-digit code after the one before it: 015629-001, -002 ...
  // (stored as 15629.001, so IDs still sort as numbers).
  const sidBase = (n) => Math.floor(n + 1e-9);
  const sidSub = (n) => Math.round((n - sidBase(n)) * 1000);
  const validSid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 1
    && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;
  const idText = (n) => {
    const v = Number(n);
    const sub = sidSub(v);
    return `${String(sidBase(v)).padStart(6, '0')}${sub ? `-${String(sub).padStart(3, '0')}` : ''}`;
  };
  // "000049-002" (as shown, or typed: "49-2") -> 49.002; NaN if it isn't one.
  const idValue = (text) => {
    const m = String(text).match(/^(\d+)(?:-(\d{1,3}))?$/);
    return m ? +m[1] + (m[2] ? +m[2] / 1000 : 0) : NaN;
  };
  const ID_PATTERN = '\\d+(?:-\\d{1,3})?'; // for building regexes that read IDs
  // How an ID is shown: labelled, so it isn't taken for a work order.
  const idTag = (n) => `ID:${n}`;

  // Give entries without an ID one (and fix two entries sharing one, which
  // two devices offline can cause: the one with the lower internal id keeps
  // it). A log without any IDs (from before they existed) is numbered by
  // position x10, so every device numbers the same log the same way.
  // Returns { changed: [entries with a new ID], renumbered: count }.
  function assignIds(all) {
    const list = visible(all);
    const owner = new Map(); // sid -> entry keeping it
    for (const e of list) {
      if (!validSid(e.sid)) continue;
      const other = owner.get(e.sid);
      if (!other || e.id < other.id) owner.set(e.sid, e);
    }
    const keeps = (e) => validSid(e.sid) && owner.get(e.sid) === e;
    const renumbered = list.filter((e) => validSid(e.sid) && !keeps(e)).length;
    if (!owner.size) {
      return { changed: list.map((e, i) => makeEntry(e, { sid: (i + 1) * 10 })), renumbered: 0 };
    }
    let max = 0;
    for (const sid of owner.keys()) if (sid > max) max = sid;
    // The next entry keeping its ID, after each position (worked out once:
    // looking ahead from every entry would be slow for a long log).
    const nextKeep = new Array(list.length);
    for (let i = list.length - 1, ahead = null; i >= 0; i--) {
      nextKeep[i] = ahead;
      if (keeps(list[i])) ahead = list[i];
    }
    const changed = [];
    let prev = 0;
    list.forEach((e, i) => {
      if (keeps(e)) {
        prev = e.sid;
        return;
      }
      const next = nextKeep[i];
      let sid = null;
      if (next) {
        for (let c = sidBase(prev) + 1; c % 10 !== 0; c++) {
          if (c >= next.sid) break;
          if (!owner.has(c)) { sid = c; break; }
        }
        // No whole number left before the next one: a code after the one
        // before it (49 -> 49-001, 49-002 ...).
        if (sid == null && prev >= 1) {
          for (let sub = sidSub(prev) + 1; sub <= 999; sub++) {
            const c = Math.round(sidBase(prev) * 1000 + sub) / 1000;
            if (c >= next.sid) break;
            if (!owner.has(c)) { sid = c; break; }
          }
        }
      }
      if (sid == null) {
        sid = Math.floor(sidBase(max) / 10) * 10 + 10;
        max = sid;
      }
      owner.set(sid, e);
      prev = sid;
      changed.push(makeEntry(e, { sid }));
    });
    return { changed, renumbered };
  }

  // The entry an ID typed in a command means: all six digits for an exact
  // match; fewer for the latest entry whose ID ends with them ("450").
  function findById(spans, typed) {
    const t = String(typed == null ? '' : typed).trim().replace(/^(?:#|id:?)/i, '');
    const m = t.match(/^(\d+)(?:-(\d{1,3}))?$/);
    if (!m) return null;
    if (m[1].length >= 6) return spans.find((s) => idValue(s.n) === idValue(t)) || null;
    // Fewer digits: the latest whose number ends with them (and has the same
    // code after the dash, or none).
    const sub = m[2] ? +m[2] : 0;
    for (let i = spans.length - 1; i >= 0; i--) {
      const [base, code] = spans[i].n.split('-');
      if (base.endsWith(m[1]) && (code ? +code : 0) === sub) return spans[i];
    }
    return null;
  }

  // An entry with its optional fields set only when they have a value.
  function makeEntry(base, extra) {
    const e = { id: base.id, ts: base.ts, text: base.text };
    const x = { notes: base.notes, files: base.files, wo: base.wo, wl: base.wl, eq: base.eq, ql: base.ql, sid: base.sid, ...(extra || {}) };
    if (validSid(x.sid)) e.sid = x.sid;
    if (x.notes) e.notes = x.notes;
    if (x.files) e.files = x.files;
    if (x.wo) {
      e.wo = x.wo;
      if (x.wl) e.wl = true;
    }
    if (x.eq) {
      e.eq = x.eq;
      if (x.ql) e.ql = true;
    }
    return e;
  }

  // Notes are shown under their entry as lines starting with "> ", in /log,
  // /edit and text backups.
  function notesLines(notes, indent) {
    if (!notes) return [];
    return String(notes).split('\n').map((l) => `${indent}> ${l}`.trimEnd());
  }

  // File paths on an entry. Kept as full paths, one per line. Typed and
  // shown more compactly: a folder, then the names of files in it
  //   /Volumes/Work/SP/ stems.zip mix_v7.wav
  // (spaces or commas between them; "quotes" around a path with spaces).
  const MAX_FILES = 8000;

  // Words of a line: split on spaces and commas, "quoted" parts kept whole.
  function fileWords(line) {
    const out = [];
    const re = /"([^"]*)"|([^\s,"]+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] != null ? m[1] : m[2]);
    return out.filter(Boolean);
  }
  const isPath = (w) => w.includes('/') || w.startsWith('~');
  const quoteWord = (w) => (/[\s,"]/.test(w) ? `"${w.replace(/"/g, '')}"` : w);

  // Typed or pasted file paths -> full paths. A path followed by plain
  // names is their folder; a folder carries over to the next lines, so
  //   /Volumes/Work/SP/      or   /Volumes/Work/SP/ stems.zip mix_v7.wav
  //   stems.zip
  //   mix_v7.wav
  // both give /Volumes/Work/SP/stems.zip and /Volumes/Work/SP/mix_v7.wav.
  function parseFiles(text) {
    const out = [];
    let folder = '';
    let alone = ''; // a folder with no names after it yet: kept if none come
    const name = (w) => {
      out.push(folder ? folder + w : w);
      alone = '';
    };
    for (const line of String(text || '').split('\n')) {
      const words = fileWords(line);
      words.forEach((w, i) => {
        if (!isPath(w)) return name(w);
        if (alone) out.push(alone);
        alone = '';
        const next = words[i + 1];
        if (next && !isPath(next)) folder = w.endsWith('/') ? w : `${w}/`;
        else if (!next && w.endsWith('/')) folder = alone = w;
        else out.push(w);
      });
    }
    if (alone) out.push(alone);
    return [...new Set(out)];
  }

  // Full paths -> the compact form: paths in the same folder (next to each
  // other) as "folder/ name name", others whole. One string per group.
  function groupFiles(files) {
    const paths = String(files || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const dir = (p) => (p.includes('/') && !p.endsWith('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
    const groups = [];
    for (const p of paths) {
      const d = dir(p);
      const last = groups[groups.length - 1];
      if (d && last && last.dir === d) last.names.push(p.slice(d.length));
      else groups.push({ dir: d, path: p, names: d ? [p.slice(d.length)] : [] });
    }
    return groups.map((g) => (g.names.length > 1 ? [g.dir, ...g.names].map(quoteWord).join(' ') : quoteWord(g.path)));
  }

  // Shown under an entry as "@ " lines, apart from notes (forms use them on
  // their own: %{files}).
  function filesLines(files, indent) {
    if (!files) return [];
    return groupFiles(files).map((g) => `${indent}@ ${g}`.trimEnd());
  }

  // For a form: a folder on its line, its files indented under it.
  function filesList(files) {
    const out = [];
    for (const g of groupFiles(files)) {
      const words = fileWords(g);
      if (words.length > 1) out.push(words[0], ...words.slice(1).map((n) => `  ${n}`));
      else out.push(words[0] || g);
    }
    return out.join('\n');
  }

  // "@ /a/path" -> "/a/path" (null if the line isn't a file line).
  function filesLine(trimmed) {
    if (!trimmed.startsWith('@')) return null;
    return trimmed.slice(1).replace(/^ /, '');
  }

  // Lines of paths, in any of the forms above -> full paths, one per line.
  const joinFiles = (lines) => parseFiles(lines.join('\n')).join('\n');

  // "> some text" -> "some text" (null if the line isn't a notes line).
  function notesLine(trimmed) {
    if (!trimmed.startsWith('>')) return null;
    return trimmed.slice(1).replace(/^ /, '');
  }

  // Joined notes, or '' when there are none.
  function joinNotes(lines) {
    return lines.join('\n').replace(/\s+$/, '').replace(/^\s*\n/, '');
  }
  // Time that isn't counted: /off and unpaid breaks.
  const isOff = (e) => Boolean(e) && (e.text === OFF || e.text === BREAK_UNPAID);

  // /wolink stores "dev -> WO 4471 for this day" as a hidden entry with the
  // text "/wo dev", at the start of that day. It syncs like an entry but is
  // never shown, timed or numbered; new entries of that category that day
  // pick up its work order. /eqlink keeps equipment on the same entry.
  const LINK = '/wo ';
  const isLink = (e) => Boolean(e) && typeof e.text === 'string' && e.text.startsWith(LINK);
  const linkCategory = (e) => e.text.slice(LINK.length);
  const visible = (entries) => entries.filter((e) => !isLink(e));

  // "dev fixing login bug" -> { category: "dev", note: "fixing login bug" }
  // The category is everything before the first space.
  function parseInput(text) {
    const t = String(text).trim().replace(/\s+/g, ' ');
    const i = t.indexOf(' ');
    if (i === -1) return { category: t, note: '' };
    return { category: t.slice(0, i), note: t.slice(i + 1) };
  }

  // Unique categories, most recently used first. Matching is case-insensitive;
  // the casing of the most recent use wins.
  function knownCategories(entries) {
    const seen = new Map();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (isMarker(entries[i].text)) continue;
      const cat = isLink(entries[i]) ? linkCategory(entries[i]) : parseInput(entries[i].text).category;
      const key = cat.toLowerCase();
      if (cat && !seen.has(key)) seen.set(key, cat);
    }
    return Array.from(seen.values());
  }

  // Words from `candidates` that complete what has been typed so far. Only
  // offered while the user is still typing the first word (no space yet).
  function suggest(input, candidates, opts) {
    const { limit = 8, includeExact = false } = opts || {};
    if (/\s/.test(input)) return [];
    const p = input.toLowerCase();
    const out = [];
    for (const c of candidates) {
      if (c.toLowerCase().startsWith(p) && (includeExact || c !== input)) out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  // Each entry runs until the next one starts; the last one is still running.
  // `n` is the entry's 1-based position in the whole log. Off markers become
  // spans with `off: true`: gaps that are shown but never counted.
  function withSpans(all, now) {
    const entries = visible(all);
    return entries.map((e, i) => {
      const next = entries[i + 1];
      const end = next ? next.ts : now;
      const off = isOff(e);
      return {
        ...e,
        ...(isMarker(e.text) ? { category: MARKERS[e.text], note: '' } : parseInput(e.text)),
        off,
        n: idText(validSid(e.sid) ? e.sid : (i + 1) * 10),
        end,
        running: !next,
        duration: Math.max(0, end - e.ts),
      };
    });
  }

  // Sum durations per category (case-insensitive), largest first.
  function summarize(spans) {
    const totals = new Map();
    for (const s of spans) {
      if (s.off) continue;
      const key = s.category.toLowerCase();
      const cur = totals.get(key) || { category: s.category, ms: 0 };
      cur.ms += s.duration;
      cur.category = s.category;
      totals.set(key, cur);
    }
    return Array.from(totals.values()).sort((a, b) => b.ms - a.ms);
  }

  // ---- time helpers --------------------------------------------------------

  const pad2 = (n) => String(n).padStart(2, '0');

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function addDays(ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function ymd(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // "HH:MM", 24-hour: what you type (edits, /edit) and what's compared.
  function hhmm(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // The clock times are shown in: '24' ("14:30") or '12' ("2:30pm"). Set from
  // the account's settings (/clock) by whatever is showing them.
  let clock12 = false;
  function setClock(mode) { clock12 = mode === '12'; }
  function clockMode() { return clock12 ? '12' : '24'; }

  // A time to show: "14:30", or "2:30pm" on the 12-hour clock.
  function clock(ts) {
    if (!clock12) return hhmm(ts);
    const d = new Date(ts);
    const h = d.getHours();
    return `${h % 12 || 12}:${pad2(d.getMinutes())}${h < 12 ? 'am' : 'pm'}`;
  }

  // A time on a given clock, whatever the setting: for form tokens.
  function clockAs(mode, ts) {
    const was = clock12;
    clock12 = mode === '12';
    try { return clock(ts); } finally { clock12 = was; }
  }

  // The same, padded to one width so times line up in columns.
  const clockWidth = () => (clock12 ? 7 : 5);
  const clockCol = (ts) => clock(ts).padStart(clockWidth());
  const nowCol = () => 'now'.padEnd(clockWidth());

  // An hour on a time axis: "14:00", or "2pm".
  function hourLabel(hour) {
    const h = ((hour % 24) + 24) % 24;
    return clock12 ? `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}` : `${pad2(h)}:00`;
  }

  // 45 min -> "0:45", 26h 5m -> "26:05"
  function formatHM(ms) {
    const m = Math.floor(ms / 60000);
    return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
  }

  // Running-timer style: "0:12:34"
  function formatClock(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
  }

  // Turn a range word into [from, to). Returns null if it is not understood.
  //   today | yesterday | week (last 7 days) | month (last 30 days) | all
  //   Nd (last N days) | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD
  function parseRange(arg, now) {
    const a = (arg || 'today').toLowerCase();
    const today = startOfDay(now);
    const lastDays = (n, label) => ({ from: addDays(today, 1 - n), to: addDays(today, 1), label });
    if (a === 'today') return { from: today, to: addDays(today, 1), label: 'today' };
    if (a === 'yesterday') return { from: addDays(today, -1), to: today, label: 'yesterday' };
    if (a === 'week') return lastDays(7, 'week');
    if (a === 'month') return lastDays(30, 'month');
    // The calendar week (Sunday to Saturday) and month this is in.
    if (a === 'calweek') {
      const from = addDays(today, -new Date(today).getDay());
      return { from, to: addDays(from, 7), label: 'calweek' };
    }
    if (a === 'calmonth') {
      const d = new Date(today);
      return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(), label: 'calmonth' };
    }
    if (a === 'all') return { from: -Infinity, to: Infinity, label: 'all' };
    let m = a.match(/^(\d{1,4})d$/);
    if (m && +m[1] > 0) return lastDays(+m[1], `${+m[1]}d`);
    const date = (s) => {
      const p = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!p) return null;
      const d = new Date(+p[1], +p[2] - 1, +p[3]);
      return ymd(d.getTime()) === s ? d.getTime() : null;
    };
    m = a.match(/^(\S+?)\.\.(\S+)$/);
    if (m) {
      const from = date(m[1]);
      const to = date(m[2]);
      if (from == null || to == null || to < from) return null;
      return { from, to: addDays(to, 1), label: `${m[1]}..${m[2]}` };
    }
    const d = date(a);
    if (d != null) return { from: d, to: addDays(d, 1), label: a };
    // A day name: the latest one, today included ("tue", "tuesday").
    const wd = a.length >= 3 ? FULL_DAY_NAMES.findIndex((n) => n.startsWith(a)) : -1;
    if (wd >= 0) {
      let day = today;
      while (new Date(day).getDay() !== wd) day = addDays(day, -1);
      return { from: day, to: addDays(day, 1), label: ymd(day) };
    }
    return null;
  }

  // A day something is due, as "YYYY-MM-DD", or null if not understood:
  //   today | tomorrow | a day name (the next one, today included) |
  //   +N (in N days) | YYYY-MM-DD | MM-DD (this year's, unless that was more
  //   than two months ago: then next year's)
  function parseDue(arg, now) {
    const a = String(arg || '').toLowerCase().trim();
    const today = startOfDay(now);
    if (a === 'today') return ymd(today);
    if (a === 'tomorrow' || a === 'tmrw' || a === 'tom') return ymd(addDays(today, 1));
    let m = a.match(/^\+(\d{1,3})d?$/);
    if (m) return ymd(addDays(today, +m[1]));
    m = a.match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const at = (y) => new Date(y, +m[2] - 1, +m[3]).getTime();
      const y = m[1] ? +m[1] : new Date(today).getFullYear();
      let d = at(y);
      if (new Date(d).getMonth() !== +m[2] - 1) return null;
      if (!m[1] && d < addDays(today, -60)) d = at(y + 1);
      return ymd(d);
    }
    const wd = a.length >= 3 ? FULL_DAY_NAMES.findIndex((n) => n.startsWith(a)) : -1;
    if (wd >= 0) {
      let day = today;
      while (new Date(day).getDay() !== wd) day = addDays(day, 1);
      return ymd(day);
    }
    return null;
  }

  // How a due day reads next to a to-do: "due today", "due tomorrow",
  // "due Fri 10-09", "overdue, was due Wed 09-30". `late` is whether it's past.
  function dueLabel(due, now) {
    const today = ymd(startOfDay(now));
    const p = due.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]).getTime();
    const day = `${DAY_NAMES[new Date(d).getDay()]} ${due.slice(0, 4) === today.slice(0, 4) ? due.slice(5) : due}`;
    if (due < today) return { text: `overdue, was due ${day}`, late: true, soon: true };
    if (due === today) return { text: 'due today', late: false, soon: true };
    if (due === ymd(addDays(startOfDay(now), 1))) return { text: 'due tomorrow', late: false, soon: false };
    return { text: `due ${day}`, late: false, soon: false };
  }

  // ---- accent colors -------------------------------------------------------------
  // The accent the website uses (buttons, the running card, highlights): a
  // named one, each stepped for light and dark screens, or any #rrggbb (its
  // dark-screen step is mixed lighter). Text on it is white or near black,
  // whichever reads better.
  const ACCENTS = {
    indigo: ['#4f46e5', '#8b8cf8'],
    blue: ['#2563eb', '#60a5fa'],
    teal: ['#0f766e', '#2dd4bf'],
    green: ['#15803d', '#4ade80'],
    amber: ['#b45309', '#fbbf24'],
    rose: ['#e11d48', '#fb7185'],
    violet: ['#7c3aed', '#a78bfa'],
    slate: ['#475569', '#94a3b8'],
  };
  const DEFAULT_ACCENT = 'indigo';

  function hexRgb(hex) {
    const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  // WCAG relative luminance.
  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  function textOn(rgb) {
    const l = luminance(rgb);
    return contrast(l, 1) >= contrast(l, luminance([17, 19, 24])) ? '#ffffff' : '#111318';
  }

  // "teal", "#0a7d4f" or "" (the default) -> { name, light: { accent, on },
  // dark: { accent, on } }, or null when it isn't a color.
  function accentColors(value) {
    const v = String(value || DEFAULT_ACCENT).trim().toLowerCase();
    let pair = ACCENTS[v];
    let name = v;
    if (!pair) {
      const rgb = hexRgb(v);
      if (!rgb) return null;
      name = rgbHex(rgb);
      const lighter = rgb.map((c) => c + (255 - c) * 0.35);
      pair = [name, rgbHex(lighter)];
    }
    const step = (hex) => ({ accent: hex, on: textOn(hexRgb(hex)) });
    return { name, light: step(pair[0]), dark: step(pair[1]) };
  }

  // ---- report --------------------------------------------------------------

  function summaryLines(spans, catWidth) {
    const totals = summarize(spans);
    const all = totals.reduce((sum, t) => sum + t.ms, 0);
    const lines = totals.map((t) => {
      const pct = all ? Math.round((t.ms / all) * 100) : 0;
      return `  ${t.category.padEnd(catWidth)}  ${formatHM(t.ms).padStart(6)}  ${String(pct).padStart(3)}%`;
    });
    lines.push(`  ${'total'.padEnd(catWidth)}  ${formatHM(all).padStart(6)}`);
    return lines;
  }

  // Fixed-width, plain-text readout of the entries that start in [from, to).
  // Entries are grouped by the day they start on; each day gets a per-category
  // summary, and multi-day ranges get an overall summary at the end.
  // `compact` drops the end column (it is the next entry's start) to fit phones.
  function formatReport(entries, range, now, opts) {
    const compact = Boolean(opts && opts.compact);
    const RULE = '-'.repeat(compact ? 36 : 56);
    const spans = withSpans(entries, now).filter((s) => s.ts >= range.from && s.ts < range.to);
    if (!spans.length) return `no entries (${range.label})`;

    const numWidth = Math.max(...spans.map((s) => idTag(s.n).length));
    const catWidth = Math.min(16, Math.max(8, ...spans.map((s) => s.category.length)));
    // The work order column only appears when something in view has one.
    const woWidth = spans.some((s) => s.wo) ? Math.max(4, ...spans.map((s) => woTag(s.wo).length)) : 0;
    const woCell = (s) => (woWidth ? `${woTag(s.wo).padEnd(woWidth)}  ` : '');
    const days = [];
    for (const s of spans) {
      const key = ymd(s.ts);
      if (!days.length || days[days.length - 1].key !== key) days.push({ key, ts: s.ts, spans: [] });
      days[days.length - 1].spans.push(s);
    }

    const out = [];
    for (const day of days) {
      out.push(`${DAY_NAMES[new Date(day.ts).getDay()]} ${day.key}`);
      if (compact) {
        // Phones: two lines an entry (ID, start, duration and work order,
        // then what it was), so nothing wraps mid-column.
        for (const s of day.spans) {
          const dur = s.off ? '-' : formatHM(s.duration);
          out.push(`  ${idTag(s.n).padEnd(numWidth)}  ${clockCol(s.ts)}  ${dur.padStart(5)}  ${woTag(s.wo)}`.trimEnd());
          out.push(`${' '.repeat(numWidth + 4)}${s.category}${s.note ? ` ${s.note}` : ''}`);
          out.push(...notesLines(s.notes, ' '.repeat(numWidth + 4)));
          out.push(...filesLines(s.files, ' '.repeat(numWidth + 4)));
        }
        out.push(`  ${RULE}`);
        out.push(...summaryLines(day.spans, catWidth));
        out.push('');
        continue;
      }
      const woHead = woWidth ? `${'wo'.padEnd(woWidth)}  ` : '';
      out.push(`  ${''.padStart(numWidth)}  ${woHead}${'start'.padEnd(clockWidth())}  ${'end'.padEnd(clockWidth())}  ${'dur'.padStart(6)}  ${'category'.padEnd(catWidth)}  note`);
      for (const s of day.spans) {
        const end = `${s.running ? nowCol() : clockCol(s.end)}  `;
        const dur = s.off ? '-' : formatHM(s.duration);
        out.push(
          `  ${idTag(s.n).padEnd(numWidth)}  ${woCell(s)}${clockCol(s.ts)}  ${end}${dur.padStart(6)}  ` +
          `${s.category.padEnd(catWidth)}  ${s.note}`.trimEnd(),
        );
        out.push(...notesLines(s.notes, ' '.repeat(numWidth + 4)));
        out.push(...filesLines(s.files, ' '.repeat(numWidth + 4)));
      }
      out.push(`  ${RULE}`);
      out.push(...summaryLines(day.spans, catWidth));
      out.push('');
    }
    if (days.length > 1) {
      out.push(`${range.label}: ${days[0].key} .. ${days[days.length - 1].key}, ${days.length} days`);
      out.push(`  ${RULE}`);
      out.push(...summaryLines(spans, catWidth));
      out.push('');
    }
    return out.join('\n').trimEnd();
  }

  // Readout grouped by category instead of by time: categories largest
  // first, each with its total, share and entries (oldest first).
  function formatCategoryReport(entries, range, now) {
    const spans = withSpans(entries, now).filter((s) => !s.off && s.ts >= range.from && s.ts < range.to);
    if (!spans.length) return `no entries (${range.label})`;
    const multiDay = ymd(spans[0].ts) !== ymd(spans[spans.length - 1].ts);
    const numWidth = Math.max(...spans.map((s) => idTag(s.n).length));
    const all = spans.reduce((sum, s) => sum + s.duration, 0);
    const RULE = '-'.repeat(48);
    const first = ymd(spans[0].ts);
    const last = ymd(spans[spans.length - 1].ts);
    const woWidth = spans.some((s) => s.wo) ? Math.max(4, ...spans.map((s) => woTag(s.wo).length)) : 0;
    const out = [`report: ${range.label} (${first === last ? first : `${first} .. ${last}`})`, ''];
    for (const t of summarize(spans)) {
      const pct = all ? Math.round((t.ms / all) * 100) : 0;
      const mine = spans.filter((s) => s.category.toLowerCase() === t.category.toLowerCase());
      out.push(`${t.category.padEnd(20)}  ${formatHM(t.ms).padStart(6)}  ${String(pct).padStart(3)}%  ${plural(mine.length, 'entry', 'entries')}`);
      for (const s of mine) {
        // In and out: the next entry's start isn't always this one's end.
        const inOut = `${clockCol(s.ts)}-${s.running ? nowCol() : clock(s.end).padEnd(clockWidth())}`;
        const when = multiDay ? `${DAY_NAMES[new Date(s.ts).getDay()]} ${ymd(s.ts).slice(5)} ${inOut}` : inOut;
        const wo = woWidth ? `${woTag(s.wo).padEnd(woWidth)}  ` : '';
        out.push(`  ${idTag(s.n).padEnd(numWidth)}  ${wo}${when}  ${formatHM(s.duration).padStart(6)}  ${s.note}`.trimEnd());
        out.push(...notesLines(s.notes, ' '.repeat(numWidth + 4)));
        out.push(...filesLines(s.files, ' '.repeat(numWidth + 4)));
      }
      out.push('');
    }
    out.push(RULE);
    out.push(`${'total'.padEnd(20)}  ${formatHM(all).padStart(6)}        ${plural(spans.length, 'entry', 'entries')}`);
    return out.join('\n');
  }

  // Time per work order for a range, largest first; "(none)" collects time
  // without a work order.
  function formatWorkOrders(entries, range, now) {
    const spans = withSpans(entries, now).filter((s) => !s.off && s.ts >= range.from && s.ts < range.to);
    const links = entries.filter((e) => isLink(e) && e.wo && e.ts >= range.from && e.ts < range.to);
    if (!spans.length && !links.length) return `no entries (${range.label})`;
    const all = spans.reduce((sum, s) => sum + s.duration, 0);
    const dates = spans.map((s) => s.ts).concat(links.map((e) => e.ts)).sort((a, b) => a - b);
    const first = ymd(dates[0]);
    const last = ymd(dates[dates.length - 1]);
    const groups = new Map();
    const group = (key) => {
      if (!groups.has(key)) groups.set(key, { list: [], cats: [], days: [] });
      return groups.get(key);
    };
    for (const s of spans) group(s.wo || '').list.push(s);
    // Work orders scheduled with /wolink, whether or not time was logged.
    for (const e of links) {
      group(e.wo).cats.push(linkCategory(e));
      group(e.wo).days.push(e.ts);
    }
    const rows = Array.from(groups, ([wo, g]) => ({ wo, ...g, ms: g.list.reduce((sum, s) => sum + s.duration, 0) }))
      .sort((a, b) => (!a.wo) - (!b.wo) || b.ms - a.ms);
    const width = Math.max(8, ...rows.map((r) => (r.wo ? woTag(r.wo).length : 6)));
    const out = [`work orders: ${range.label} (${first === last ? first : `${first} .. ${last}`})`, ''];
    for (const r of rows) {
      const pct = all ? Math.round((r.ms / all) * 100) : 0;
      const cats = [];
      for (const c of r.list.map((s) => s.category).concat(r.cats)) if (!cats.some((x) => x.toLowerCase() === c.toLowerCase())) cats.push(c);
      const days = r.list.map((s) => s.ts).concat(r.days).sort((a, b) => a - b);
      const d1 = ymd(days[0]).slice(5);
      const d2 = ymd(days[days.length - 1]).slice(5);
      out.push(
        `${(r.wo ? woTag(r.wo) : '(none)').padEnd(width)}  ${formatHM(r.ms).padStart(6)}  ${String(pct).padStart(3)}%  ` +
        `${plural(r.list.length, 'entry', 'entries').padEnd(11)}  ${cats.join(', ')}${first === last ? '' : `  ${d1 === d2 ? d1 : `${d1} .. ${d2}`}`}`,
      );
    }
    out.push('-'.repeat(48));
    out.push(`${'total'.padEnd(width)}  ${formatHM(all).padStart(6)}        ${plural(spans.length, 'entry', 'entries')}`);
    return out.join('\n');
  }

  // Apply edited fields (from the GUI's entry card) to an entry. `fields` has
  // time ("HH:MM", on the entry's own day), wo, text and notes. Returns
  // { entry } or { error }, with the same rules as /edit.
  function editEntry(entry, fields, now) {
    const { category, note } = parseInput(fields.text || '');
    const text = note ? `${category} ${note}` : category;
    if (!text) return { error: 'the entry needs some text (a category at least)' };
    if (text.startsWith('/')) return { error: 'entries can\'t start with "/"' };
    if (text.length > MAX_TEXT) return { error: `entries are limited to ${MAX_TEXT} characters` };
    const wo = String(fields.wo || '').trim().replace(/^\[(.*)\]$/, '$1');
    if (wo && !validWo(wo)) return { error: `"${wo}" is not a valid work order (no spaces or brackets, up to ${MAX_WO} characters)` };
    const notes = String(fields.notes || '').split('\n').map((l) => l.trimEnd()).join('\n').trim();
    if (notes.length > MAX_NOTES) return { error: `notes are limited to ${MAX_NOTES} characters` };
    const m = String(fields.time || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) return { error: 'the start time should look like 14:30' };
    let ts = entry.ts;
    if (`${pad2(+m[1])}:${m[2]}` !== hhmm(entry.ts)) {
      const at = new Date(entry.ts);
      at.setHours(+m[1], +m[2], 0, 0);
      ts = at.getTime();
    }
    if (ts > now) return { error: `${hhmm(ts)} is in the future` };
    // A work order typed here applies to this entry only (like /wopunch),
    // unless it is the one it already had.
    const wl = Boolean(entry.wl && wo === (entry.wo || ''));
    // Equipment likewise, when the card has the field.
    const eq = fields.eq == null ? entry.eq || '' : normalizeEq(fields.eq);
    if (eq == null) return { error: `"${String(fields.eq).trim()}" is not valid equipment (${EQ_RULES})` };
    const ql = Boolean(entry.ql && eq === (entry.eq || ''));
    const files = fields.files == null ? entry.files || '' : joinFiles(String(fields.files).split('\n'));
    if (files.length > MAX_FILES) return { error: `file paths are limited to ${MAX_FILES} characters` };
    const next = makeEntry({ id: entry.id, ts, text, sid: entry.sid }, { notes, files, wo, wl, eq, ql });
    const same = next.ts === entry.ts && next.text === entry.text && (next.notes || '') === (entry.notes || '') &&
      (next.wo || '') === (entry.wo || '') && Boolean(next.wl) === Boolean(entry.wl) &&
      (next.eq || '') === (entry.eq || '') && Boolean(next.ql) === Boolean(entry.ql) && (next.files || '') === (entry.files || '');
    return { entry: next, changed: !same };
  }

  // ---- timeline ------------------------------------------------------------

  // Color slot per category, for the range on screen: its categories get
  // slots 0-7 in the order they first appear there, so a day (or week) with
  // up to 8 categories shows 8 distinct colors. More than that cycle back
  // through them; the labels and legend still tell them apart.
  const TIMELINE_SLOTS = 8;
  function categorySlots(spans) {
    const slots = new Map();
    for (const s of spans) {
      if (s.off) continue;
      const key = s.category.toLowerCase();
      if (!slots.has(key)) slots.set(key, slots.size % TIMELINE_SLOTS);
    }
    return slots;
  }

  // Days in [from, to) as blocks for a vertical timeline. Each block is an
  // entry (or off time) clipped to its day; `axisFrom`/`axisTo` are whole
  // hours (ms) spanning the logged time of every day, for a shared axis.
  function timelineDays(entries, range, now) {
    const spans = withSpans(entries, now).filter((s) => s.ts >= range.from && s.ts < range.to);
    const slots = categorySlots(spans);
    const days = [];
    for (const s of spans) {
      const key = ymd(s.ts);
      if (!days.length || days[days.length - 1].key !== key) {
        days.push({ key, label: `${DAY_NAMES[new Date(s.ts).getDay()]} ${key}`, start: startOfDay(s.ts), blocks: [] });
      }
      days[days.length - 1].blocks.push(s);
    }
    let axisFrom = Infinity;
    let axisTo = 0;
    for (const day of days) {
      const dayEnd = addDays(day.start, 1);
      const worked = day.blocks.filter((s) => !s.off);
      // Off time only shows between entries; trailing off time (evenings,
      // overnight) is left out.
      const lastEnd = worked.length ? Math.min(dayEnd, Math.max(...worked.map((s) => s.end))) : day.blocks[0].ts;
      day.blocks = day.blocks
        .map((s) => ({
          n: s.n, id: s.id, category: s.category, note: s.note, notes: s.notes || '', files: s.files || '', wo: s.wo || '', eq: s.eq || '',
          off: s.off, running: s.running, start: s.ts, end: Math.min(s.end, dayEnd, s.off ? lastEnd : Infinity),
          duration: s.duration, clipped: s.end > dayEnd,
          slot: s.off ? null : slots.get(s.category.toLowerCase()),
        }))
        .filter((b) => b.end > b.start || !b.off);
      day.totalMs = worked.reduce((sum, s) => sum + s.duration, 0);
      const first = new Date(day.blocks[0].start);
      const fromHour = first.getHours();
      const last = new Date(Math.max(lastEnd, day.blocks[0].start + 60000) - 1);
      const toHour = Math.min(24, last.getHours() + 1);
      // Axis in minutes from midnight, so days can share it (or use their own
      // when drawn one under another).
      day.axisTo = toHour * 60;
      day.axisFrom = Math.min(fromHour * 60, day.axisTo - 60);
      axisFrom = Math.min(axisFrom, fromHour * 60);
      axisTo = Math.max(axisTo, toHour * 60);
    }
    const legend = summarize(spans).map((t) => ({ ...t, slot: slots.get(t.category.toLowerCase()) }));
    return { days, axisFrom: Math.min(axisFrom, axisTo - 60), axisTo, legend };
  }

  // ---- pay -----------------------------------------------------------------
  // /rate, /otmin and /otrate. Each setting keeps its history, so changing
  // it later leaves the pay for earlier time as it was:
  //   { rate: [{ from, value }], otmin: [...], otrate: [...] }
  // A setting's first value also covers everything before it (from: 0), and
  // a value of null turns it off from then on.

  const PAY_KEYS = ['rate', 'otmin', 'otrate'];
  const DEFAULT_OT_FACTOR = 1.5;

  function payValue(settings, key, t) {
    const list = (settings && settings[key]) || [];
    let value = null;
    for (const step of list) if (step.from <= t) value = step.value;
    return value;
  }

  function setPay(settings, key, value, now) {
    const list = ((settings && settings[key]) || []).filter((s) => s.from < now);
    list.push({ from: list.length ? now : 0, value });
    return { ...(settings || {}), [key]: list };
  }

  // Merge two copies of the account settings (two devices changed them
  // before syncing): each pay setting keeps the steps of both.
  function mergeSettings(a, b) {
    const out = { ...b, ...a };
    const pa = (a && a.pay) || {};
    const pb = (b && b.pay) || {};
    if (a.pay || b.pay) {
      out.pay = {};
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        const steps = new Map();
        for (const step of [...(pb[k] || []), ...(pa[k] || [])]) steps.set(step.from, step);
        out.pay[k] = [...steps.values()].sort((x, y) => x.from - y.from);
      }
    }
    return out;
  }

  const hasPay = (settings) => Boolean(settings && (settings.rate || []).some((s) => s.value != null));

  // Sunday 00:00 of the week `ts` falls in (overtime counts per week, Sunday
  // to Saturday, like calweek).
  function weekStart(ts) {
    const day = startOfDay(ts);
    return addDays(day, -new Date(day).getDay());
  }

  // Pay for each worked span: its rate (the one in effect when it started),
  // with the part past the week's overtime threshold paid at the overtime
  // factor. Returns Map(id -> { money, ot }), money null without a rate;
  // `ot` is true once the span has gone into overtime.
  function earnings(entries, settings, now) {
    const out = new Map();
    const worked = new Map(); // week start -> ms worked so far
    for (const s of withSpans(entries, now)) {
      if (s.off) continue;
      const week = weekStart(s.ts);
      const before = worked.get(week) || 0;
      const after = before + s.duration;
      worked.set(week, after);
      const rate = payValue(settings, 'rate', s.ts);
      const otmin = payValue(settings, 'otmin', s.ts);
      const factor = payValue(settings, 'otrate', s.ts) || DEFAULT_OT_FACTOR;
      const limit = otmin == null ? Infinity : otmin * 3600000;
      const regular = Math.max(0, Math.min(after, limit) - before);
      const overtime = s.duration - regular;
      out.set(s.id, {
        money: rate == null ? null : (rate * (regular + overtime * factor)) / 3600000,
        ot: after > limit,
      });
    }
    return out;
  }

  function formatMoney(amount) {
    return `$${(Math.round(amount * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // "$32.50", "32.5", "1,200" -> number, or null.
  function parseAmount(text) {
    const t = String(text || '').trim().replace(/^\$/, '').replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    return Number(t);
  }

  // ---- forms -----------------------------------------------------------------
  // A form is your own text with tokens filled in from the log:
  //   %{hours}, %{in}, %{notes}, ...    worked out from the entries in scope
  //   %{each category} ... %{end}       repeated per category (or wo, equipment, entry)
  //   %{ask:System}                     asked for when the form is filled in
  // Outside any %{each} the scope is every entry in the range asked for;
  // inside, it is that one group's entries.

  const FORM_GROUPS = ['category', 'wo', 'equipment', 'entry'];
  const FORM_TOKENS = [
    ['date', 'the day asked for, e.g. 2026-09-29'],
    ['day', 'its weekday, e.g. Tuesday'],
    ['category', 'the categories, e.g. "dev, mtg"'],
    ['wo', 'the work orders'],
    ['equipment', 'the equipment (/eqlink, /eqpunch)'],
    ['in', 'the first start'],
    ['out', 'the last end ("now" if running)'],
    ['in12', 'the first start on the 12-hour clock, e.g. 2:30pm'],
    ['out12', 'the last end on the 12-hour clock'],
    ['in24', 'the first start on the 24-hour clock, e.g. 14:30'],
    ['out24', 'the last end on the 24-hour clock'],
    ['hours', 'the time logged'],
    ['dur', 'the same, e.g. one entry\'s duration inside %{each entry}'],
    ['down', 'time between in and out that was not logged here'],
    ['titles', 'the entry titles, or the category when there is none (%{title} works too)'],
    ['notes', 'the notes, one per line'],
    ['files', 'the file paths (/file): each folder, with its files under it'],
    ['paths', 'the file paths (/file), in full, one per line'],
    ['entries', 'how many entries'],
  ];
  const FORM_DIVIDER = '-'.repeat(40);

  // Template text -> { nodes, errors }. A %{each} or %{end} alone on its line
  // takes the whole line, so it leaves no blank line behind; so does a token
  // alone on its line that comes out empty (%{notes} with no notes).
  function parseForm(text) {
    const root = [];
    const stack = [{ body: root }];
    const errors = [];
    const top = () => stack[stack.length - 1].body;
    const re = /^([ \t]*)%\{([^}]*)\}[ \t]*(\r?\n|$)|%\{([^}]*)\}/gm;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) top().push({ text: text.slice(last, m.index) });
      last = re.lastIndex;
      const alone = m[2] != null;
      const tok = (alone ? m[2] : m[4]).trim();
      const each = tok.match(/^each\s+(\S+)$/i);
      if (each) {
        const key = { title: 'entry', titles: 'entry', entries: 'entry' }[each[1].toLowerCase()] || each[1].toLowerCase();
        if (!FORM_GROUPS.includes(key)) errors.push(`%{each ${each[1]}}: use %{each category}, %{each wo}, %{each equipment} or %{each entry}`);
        const node = { each: key, body: [] };
        top().push(node);
        stack.push(node);
      } else if (/^end$/i.test(tok)) {
        if (stack.length === 1) errors.push('%{end} without an %{each ...} before it');
        else stack.pop();
      } else {
        const at = tok.indexOf(':');
        const typed = (at < 0 ? tok : tok.slice(0, at)).trim().toLowerCase();
        const name = { title: 'titles', eq: 'equipment' }[typed] || typed;
        const arg = at < 0 ? '' : tok.slice(at + 1).trim();
        if (name === 'ask') {
          if (!arg) errors.push('%{ask:...} needs a label, e.g. %{ask:System}');
        } else if (!FORM_TOKENS.some(([t]) => t === name)) {
          errors.push(`unknown token %{${tok}} (/form tokens lists them)`);
        }
        top().push(alone ? { token: name, arg, line: { indent: m[1], nl: m[3] } } : { token: name, arg });
      }
    }
    if (last < text.length) top().push({ text: text.slice(last) });
    if (stack.length > 1) errors.push(`%{each ${stack[stack.length - 1].each}} without an %{end}`);
    return { nodes: root, errors };
  }

  // Entries grouped for %{each key}, in the order they were first logged;
  // time without a work order comes last.
  function formGroups(spans, key) {
    if (key === 'entry') return spans.map((s) => ({ spans: [s], where: idTag(s.n) }));
    const groups = new Map();
    for (const s of spans) {
      // An entry with several pieces of equipment goes under each of them.
      const values = key === 'wo' ? [s.wo || ''] : key === 'equipment' ? (s.eq ? eqNames(s.eq) : ['']) : [s.category];
      for (const value of values) {
        const k = value.toLowerCase();
        if (!groups.has(k)) groups.set(k, { value, spans: [] });
        groups.get(k).spans.push(s);
      }
    }
    const list = Array.from(groups.values());
    const coded = key === 'wo' || key === 'equipment';
    if (coded) list.sort((a, b) => (!a.value) - (!b.value));
    const tag = key === 'wo' ? woTag : eqTag;
    return list.map((g) => ({
      spans: g.spans,
      none: coded && !g.value ? key : '',
      eq: key === 'equipment' ? g.value : null,
      where: coded ? (g.value ? tag(g.value) : `no ${key === 'wo' ? 'work order' : 'equipment'}`) : g.value,
    }));
  }

  // `eq`: inside %{each equipment}, the one piece the section is for.
  function formValues(spans, range, now, none, eq) {
    const uniq = (xs) => {
      const out = [];
      for (const x of xs) if (x && !out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x);
      return out;
    };
    const first = spans[0];
    const last = spans[spans.length - 1];
    const ms = spans.reduce((sum, s) => sum + s.duration, 0);
    const oneDay = Number.isFinite(range.from) && addDays(range.from, 1) >= range.to;
    let date = oneDay ? ymd(range.from) : '';
    if (!oneDay && first) date = ymd(first.ts) === ymd(last.ts) ? ymd(first.ts) : `${ymd(first.ts)} .. ${ymd(last.ts)}`;
    const lastEnd = last ? (last.running ? now : last.end) : 0;
    return {
      date,
      day: oneDay ? FULL_DAY_NAMES[new Date(range.from).getDay()].replace(/^./, (c) => c.toUpperCase()) : '',
      category: uniq(spans.map((s) => s.category)).join(', '),
      wo: none === 'wo' ? '(none)' : uniq(spans.map((s) => s.wo)).join(', '),
      equipment: none === 'equipment' ? '(none)' : eq || uniq(spans.flatMap((s) => eqNames(s.eq))).join(', '),
      in: first ? clock(first.ts) : '',
      out: last ? (last.running ? 'now' : clock(last.end)) : '',
      in12: first ? clockAs('12', first.ts) : '',
      out12: last ? (last.running ? 'now' : clockAs('12', last.end)) : '',
      in24: first ? hhmm(first.ts) : '',
      out24: last ? (last.running ? 'now' : hhmm(last.end)) : '',
      hours: formatHM(ms),
      dur: formatHM(ms),
      down: first ? formatHM(Math.max(0, lastEnd - first.ts - ms)) : '0:00',
      titles: uniq(spans.map((s) => s.note || s.category)).join(', '),
      notes: spans.filter((s) => s.notes).map((s) => s.notes).join('\n'),
      files: filesList(spans.filter((s) => s.files).map((s) => s.files).join('\n')),
      paths: spans.filter((s) => s.files).map((s) => s.files).join('\n'),
      entries: String(spans.length),
    };
  }

  // Fill a template from the entries in `range`. answer(label, where) gives
  // the text for %{ask:label}; `where` names the group it is in ("dev",
  // "[4471]", "#3"), or '' outside any %{each}.
  // Returns { text, count } or { errors }.
  function fillForm(template, entries, range, now, answer) {
    const { nodes, errors } = parseForm(template);
    if (errors.length) return { errors };
    const spans = withSpans(entries, now).filter((s) => !s.off && s.ts >= range.from && s.ts < range.to);
    // Copies made by a top-level %{each} get a divider between them; nested
    // ones (entries inside a category, say) and entries, which are lines
    // rather than sections, just follow each other.
    const render = (list, scope, where, none, eq) => {
      let vals = null;
      return list.map((n) => {
        if (n.text != null) return n.text;
        if (n.each) {
          const copies = formGroups(scope, n.each).map((g) => render(n.body, g.spans, g.where, g.none, g.eq || eq));
          return list === nodes && n.each !== 'entry' ? copies.map((c) => c.replace(/\s+$/, '')).join(`\n\n${FORM_DIVIDER}\n\n`) + '\n' : copies.join('');
        }
        let value;
        if (n.token === 'ask') {
          value = answer ? answer(n.arg, where) || '' : '';
        } else {
          vals = vals || formValues(scope, range, now, none, eq);
          value = vals[n.token];
        }
        // Alone on its line: the line goes when there's nothing to show.
        // Its indent goes on every line of it (notes).
        if (n.line) return value ? `${value.split('\n').map((l) => n.line.indent + l).join('\n')}${n.line.nl}` : '';
        return value;
      }).join('');
    };
    return { text: render(nodes, spans, '', ''), count: spans.length };
  }

  // The %{ask:...} questions a template will ask, in order: [{ label, where }].
  function formQuestions(template, entries, range, now) {
    const seen = new Map();
    fillForm(template, entries, range, now, (label, where) => {
      const key = `${label}\n${where}`;
      if (!seen.has(key)) seen.set(key, { label, where });
      return '';
    });
    return Array.from(seen.values());
  }

  // Text timeline for the terminal: one row per `rowMinutes` (15 by
  // default), a colored bar per entry. `paint(slot, text)` colors a bar;
  // slot is 0-7, -1 for "other", or null for off time.
  function formatTimeline(entries, range, now, opts) {
    const { rowMinutes = 15, paint = (slot, t) => t, width = 80 } = opts || {};
    const { days, legend } = timelineDays(entries, range, now);
    if (!days.length) return `no entries (${range.label})`;
    const MAX_ROWS = 16; // a long block is drawn this tall at most
    const out = [];
    out.push(legend.map((t) => `${paint(t.slot, '■')} ${t.category} ${formatHM(t.ms)}`).join('   '));
    for (const day of days) {
      out.push('');
      out.push(`${day.label}   ${formatHM(day.totalMs)}`);
      for (const b of day.blocks) {
        const minutes = (b.end - b.start) / 60000;
        const want = Math.max(1, Math.round(minutes / rowMinutes));
        const rows = b.off ? Math.min(want, 2) : Math.min(want, MAX_ROWS);
        const bar = b.off ? paint(null, '┆ ') : paint(b.slot, '██');
        const label = b.off ? b.category.replace(/[()]/g, '') : `${b.wo ? `${woTag(b.wo)} ` : ''}${b.eq ? `${eqTag(b.eq)} ` : ''}${b.category}${b.note ? ` · ${b.note}` : ''}`;
        const dur = b.off ? formatHM(b.end - b.start) : `${formatHM(b.duration)}${b.running ? ' ▶' : ''}`;
        const room = Math.max(10, width - clockWidth() - 6 - dur.length - 2);
        const text = label.length > room ? `${label.slice(0, room - 1)}…` : label;
        out.push(`${clockCol(b.start)}  ${bar} ${text.padEnd(room)}  ${dur}`.trimEnd());
        const extra = [];
        if (b.notes) for (const l of b.notes.split('\n')) extra.push(`> ${l}`);
        for (let i = 1; i < rows || extra.length; i++) {
          const note = extra.shift();
          const more = i === rows - 1 && want > rows && !note ? ' ⋮' : '';
          out.push(`${' '.repeat(clockWidth() + 2)}${i < rows ? bar : '  '} ${note ? note.slice(0, room) : ''}${more}`.trimEnd());
          if (i >= rows && !extra.length) break;
        }
      }
    }
    return out.join('\n');
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function csvField(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // One row per entry; timestamps are ISO 8601 (UTC), running entries have no end.
  function toCSV(entries, range, now) {
    const rows = [['n', 'wo', 'start', 'end', 'minutes', 'category', 'note', 'notes', 'files']];
    for (const s of withSpans(entries, now)) {
      if (s.off || s.ts < range.from || s.ts >= range.to) continue;
      rows.push([
        s.n,
        s.wo || '',
        new Date(s.ts).toISOString(),
        s.running ? '' : new Date(s.end).toISOString(),
        (s.duration / 60000).toFixed(1),
        s.category,
        s.note,
        s.notes || '',
        s.files || '',
      ]);
    }
    return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
  }

  // ---- editing -------------------------------------------------------------
  // /edit shows entries as editable text, one per line, under day headers:
  //
  //   Thu 2026-09-24
  //     13  09:00  dev fixing login bug
  //
  // The leading number ties a line back to its entry. Lines without one are
  // new entries. Lines starting with # are comments.

  const EDIT_HELP = [
    '# change a time or text',
    '# delete a line to remove it',
    '# new line (no ID): 14:30 dev review',
    '# notes: "> text" under an entry; file paths: "@ /a/path"',
    '# work order: [4471] before the time',
  ];

  // Returns the text to edit and the entries it covers.
  function formatEditable(entries, range, now) {
    const items = withSpans(entries, now)
      .filter((s) => s.ts >= range.from && s.ts < range.to)
      .map((s) => ({ n: s.n, id: s.id, ts: s.ts, text: s.text, notes: s.notes || '', wo: s.wo || '', wl: Boolean(s.wl), eq: s.eq || '', ql: Boolean(s.ql), sid: s.sid, files: s.files || '' }));
    const lines = EDIT_HELP.slice();
    const numWidth = items.length ? Math.max(...items.map((it) => idTag(it.n).length)) : 1;
    let day = '';
    for (const it of items) {
      const d = ymd(it.ts);
      if (d !== day) {
        day = d;
        lines.push(`${DAY_NAMES[new Date(it.ts).getDay()]} ${d}`);
      }
      lines.push(`  ${idTag(it.n).padEnd(numWidth)}  ${it.wo ? `${woTag(it.wo)}  ` : ''}${hhmm(it.ts)}  ${it.text}`);
      lines.push(...notesLines(it.notes, ' '.repeat(numWidth + 11)));
      lines.push(...filesLines(it.files, ' '.repeat(numWidth + 11)));
    }
    if (!items.length) lines.push(`${DAY_NAMES[new Date(now).getDay()]} ${ymd(now)}`);
    return { text: lines.join('\n') + '\n', items };
  }

  // Turn edited text back into operations against the original entries.
  // Returns { ops, errors, changed, added, removed }; ops is empty on error.
  function parseEditable(text, items, now) {
    const byN = new Map(items.map((it) => [idValue(it.n), it]));
    const seen = new Set();
    const errors = [];
    const records = []; // one per entry line, with the notes lines under it
    let current = null;
    let day = startOfDay(now);

    String(text).split('\n').forEach((raw, i) => {
      const line = raw.trim();
      const where = `line ${i + 1}`;
      if (!line || line.startsWith('#')) return;

      const notes = notesLine(line);
      if (notes != null) {
        if (current) current.notes.push(notes);
        else errors.push(`${where}: notes (">") must go under an entry`);
        return;
      }
      const file = filesLine(line);
      if (file != null) {
        if (current) current.files.push(file);
        else errors.push(`${where}: file paths ("@") must go under an entry`);
        return;
      }
      current = null;

      const header = line.match(/^(?:[A-Za-z]{3}\s+)?(\d{4})-(\d{2})-(\d{2})$/);
      if (header) {
        const d = new Date(+header[1], +header[2] - 1, +header[3]);
        if (d.getMonth() !== +header[2] - 1) errors.push(`${where}: "${line}" is not a real date`);
        else day = d.getTime();
        return;
      }

      const m = line.match(/^(?:(?:ID:|#)?(\d+(?:-\d{1,3})?)\s+)?(?:\[([^\]]*)\]\s+)?(\d{1,2}):(\d{2})\s+(\S.*)$/i);
      if (!m) {
        errors.push(`${where}: expected "HH:MM text", e.g. "14:30 dev code review"`);
        return;
      }
      const wo = (m[2] || '').trim();
      if (wo && !validWo(wo)) {
        errors.push(`${where}: "[${wo}]" is not a valid work order (no spaces or brackets, up to ${MAX_WO} characters)`);
        return;
      }
      const h = +m[3];
      const min = +m[4];
      if (h > 23 || min > 59) {
        errors.push(`${where}: ${m[3]}:${m[4]} is not a valid time`);
        return;
      }
      const { category, note } = parseInput(m[5]);
      const entryText = note ? `${category} ${note}` : category;
      if (entryText.startsWith('/') && !isMarker(entryText)) {
        errors.push(`${where}: entries can't start with "/" (except ${Object.keys(MARKERS).join(', ')})`);
        return;
      }
      if (entryText.length > MAX_TEXT) {
        errors.push(`${where}: entries are limited to ${MAX_TEXT} characters`);
        return;
      }
      const at = new Date(day);
      at.setHours(h, min, 0, 0);
      let ts = at.getTime();

      let it = null;
      if (m[1] != null) {
        const n = idValue(m[1]);
        it = byN.get(n);
        if (!it) {
          errors.push(`${where}: there is no entry ${idTag(m[1])} in this list (remove the ID to add a new entry)`);
          return;
        }
        if (seen.has(n)) {
          errors.push(`${where}: entry ${idTag(it.n)} appears more than once`);
          return;
        }
        seen.add(n);
        // An unchanged time keeps its original seconds.
        if (ymd(it.ts) === ymd(ts) && hhmm(it.ts) === hhmm(ts)) ts = it.ts;
      }
      if (ts > now) {
        errors.push(`${where}: ${hhmm(ts)} on ${ymd(ts)} is in the future`);
        return;
      }
      current = { where, it, ts, text: entryText, wo, notes: [], files: [] };
      records.push(current);
    });

    const ops = [];
    let changed = 0;
    let added = 0;
    for (const r of records) {
      const notes = joinNotes(r.notes);
      if (notes.length > MAX_NOTES) {
        errors.push(`${r.where}: notes are limited to ${MAX_NOTES} characters`);
        continue;
      }
      const files = joinFiles(r.files);
      if (files.length > MAX_FILES) {
        errors.push(`${r.where}: file paths are limited to ${MAX_FILES} characters`);
        continue;
      }
      // A work order typed here applies to this entry only, unless it is
      // the one it already had (which keeps any /wolink).
      const keepsLink = Boolean(r.it && r.it.wl && r.wo === r.it.wo);
      // Equipment isn't in the text: an entry keeps its own.
      const entry = makeEntry({ id: r.it ? r.it.id : uuid(), ts: r.ts, text: r.text, sid: r.it ? r.it.sid : undefined }, { notes, files, wo: r.wo, wl: keepsLink, eq: r.it ? r.it.eq : '', ql: Boolean(r.it && r.it.ql) });
      if (!r.it) {
        ops.push({ op: 'put', entry });
        added++;
      } else if (r.ts !== r.it.ts || r.text !== r.it.text || notes !== (r.it.notes || '') || files !== (r.it.files || '') || r.wo !== (r.it.wo || '')) {
        ops.push({ op: 'put', entry });
        changed++;
      }
    }

    let removed = 0;
    for (const it of items) {
      if (!seen.has(idValue(it.n))) {
        ops.push({ op: 'del', id: it.id });
        removed++;
      }
    }
    if (errors.length) return { ops: [], errors, changed: 0, added: 0, removed: 0 };
    return { ops, errors, changed, added, removed };
  }

  // ---- restore from a backup -----------------------------------------------
  // Reads the formats tymlee writes: the /log or /export .txt readout (full
  // or compact), the /edit format, and the /export csv file.

  // Split CSV text into rows of fields (handles quotes, "" and newlines).
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // CSV headers written by /export over time (columns are found by name).
  const isCsvHeader = (line) => /^n,(wo,)?start,end,minutes,category,note(,notes(,files)?)?$/.test(line.trim());

  // The CSV leaves out off time, so an entry whose end is earlier than the
  // next start (or that ended with nothing after it) was followed by /off.
  function backupFromCSV(text) {
    const entries = [];
    const errors = [];
    const rows = parseCSV(text);
    const col = Object.fromEntries(rows[0].map((name, i) => [name.trim(), i]));
    const get = (r, name) => (col[name] == null ? '' : r[col[name]] || '');
    rows.slice(1).forEach((r, i) => {
      const where = `csv row ${i + 2}`;
      if (r.length === 1 && !r[0].trim()) return;
      if (r.length < 6) {
        errors.push(`${where}: expected at least 6 columns`);
        return;
      }
      const ts = Date.parse(get(r, 'start'));
      const end = get(r, 'end') ? Date.parse(get(r, 'end')) : null;
      const { category, note } = parseInput(`${get(r, 'category')} ${get(r, 'note')}`);
      if (Number.isNaN(ts) || Number.isNaN(end) || !category) {
        errors.push(`${where}: could not read the start, end or category`);
        return;
      }
      const entryText = note ? `${category} ${note}` : category;
      if (entryText.length > MAX_TEXT) {
        errors.push(`${where}: entries are limited to ${MAX_TEXT} characters`);
        return;
      }
      const notes = get(r, 'notes').trim();
      if (notes.length > MAX_NOTES) {
        errors.push(`${where}: notes are limited to ${MAX_NOTES} characters`);
        return;
      }
      const wo = get(r, 'wo').trim();
      if (wo && !validWo(wo)) {
        errors.push(`${where}: "${wo}" is not a valid work order (no spaces or brackets, up to ${MAX_WO} characters)`);
        return;
      }
      const files = get(r, 'files').split('\n').map((l) => l.trim()).filter(Boolean).join('\n'); // full paths, as written
      entries.push({ ts, end, text: markerFor(entryText) || entryText, notes, files, wo });
    });
    entries.sort((a, b) => a.ts - b.ts);
    const out = [];
    entries.forEach((e, i) => {
      out.push(stripEntry(e));
      const next = entries[i + 1];
      if (e.end != null && (!next || e.end < next.ts)) out.push({ ts: e.end, text: OFF });
    });
    return { entries: out, errors };
  }

  // { ts, text } plus notes / wo when set.
  function stripEntry(e) {
    const out = { ts: e.ts, text: e.text };
    if (e.notes) out.notes = e.notes;
    if (e.files) out.files = e.files;
    if (e.wo) out.wo = e.wo;
    return out;
  }

  // Returns { entries: [{ ts, text, notes? }], errors }.
  function parseBackup(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    // The phone layout of /log has two lines an entry (ID, start, duration,
    // work order; then what it was): join them back into one row.
    const T12 = '\\d{1,2}:\\d{2}(?:am|pm)?';
    const phoneRow = new RegExp(`^\\s*(?:ID:)?${ID_PATTERN}\\s+(${T12})\\s+(-|\\d+:\\d{2})(?:\\s+(\\[[^\\]\\s]+\\]))?\\s*$`);
    for (let i = 0; i + 1 < lines.length; i++) {
      const m = lines[i].match(phoneRow);
      const next = lines[i + 1].trim();
      if (!m || !next || notesLine(next) != null || filesLine(next) != null) continue;
      lines[i] = `  0  ${m[3] ? `${m[3]}  ` : ''}${m[1]}  ${m[2]}  ${next}`;
      lines[i + 1] = '';
    }
    const content = lines.filter((l) => !l.trim().startsWith('#'));
    const start = content.findIndex((l) => l.trim());
    if (start !== -1 && isCsvHeader(content[start])) return backupFromCSV(content.slice(start).join('\n'));

    const entries = [];
    const errors = [];
    let day = null;
    let last = null; // the entry that "> notes" lines belong to
    lines.forEach((raw, i) => {
      const line = raw.trim();
      const where = `line ${i + 1}`;
      // Blank lines, comments and the report's column headings carry nothing.
      if (!line || line.startsWith('#')) return;
      const notes = notesLine(line);
      if (notes != null) {
        if (last) last.notesLines.push(notes);
        else errors.push(`${where}: notes (">") must go under an entry`);
        return;
      }
      const file = filesLine(line);
      if (file != null) {
        if (last) last.filesLines.push(file);
        else errors.push(`${where}: file paths ("@") must go under an entry`);
        return;
      }
      last = null;
      // Rules, "no entries" notes and multi-day summaries carry no entries.
      if (/^-+$/.test(line) || /^no entries \(/.test(line)) return;
      // The report's column headings (older ones start with "#", skipped above).
      if (/^(?:wo\s+)?start\s+(?:end\s+)?dur\s+category\s+note$/.test(line)) return;
      if (/^\S+: \d{4}-\d{2}-\d{2} \.\. \d{4}-\d{2}-\d{2}, \d+ days?$/.test(line)) return;

      const header = line.match(/^(?:[A-Za-z]{3}\s+)?(\d{4})-(\d{2})-(\d{2})$/);
      if (header) {
        const d = new Date(+header[1], +header[2] - 1, +header[3]);
        if (d.getMonth() !== +header[2] - 1) errors.push(`${where}: "${line}" is not a real date`);
        else day = d.getTime();
        return;
      }

      // Report row:  3  [4471]  09:00  09:45    0:45  dev  note
      // (work order and end columns optional)
      const row = line.match(/^(?:ID:)?\d+(?:-\d{1,3})?\s+(?:\[([^\]\s]+)\]\s+)?(\d{1,2}):(\d{2})(am|pm)?\s+(?:(?:\d{1,2}:\d{2}(?:am|pm)?|now)\s+)?(?:-|\d+:\d{2})\s+(\S+)(?:\s+(.*))?$/);
      // /edit line:  3  [4471]  09:00  dev note   or   09:00 dev note
      const edit = !row && line.match(/^(?:(?:ID:)?\d+(?:-\d{1,3})?\s+)?(?:\[([^\]\s]+)\]\s+)?(\d{1,2}):(\d{2})(am|pm)?\s+(\S.*)$/);
      if (!row && !edit) {
        // Per-category summary lines:  dev   0:57   79%
        if (/^(?:\S+|\([a-z ]+\))\s+\d+:\d{2}(?:\s+\d+%)?$/.test(line)) return;
        errors.push(`${where}: not a tymlee log line: "${line.slice(0, 40)}"`);
        return;
      }
      const m = row || edit;
      const wo = m[1] || '';
      // 12-hour times (exported on the 12-hour clock) read as 24-hour.
      const h = m[4] ? (+m[2] % 12) + (m[4] === 'pm' ? 12 : 0) : +m[2];
      const min = +m[3];
      let entryText;
      if (row) {
        const label = [row[5], row[6]].filter(Boolean).join(' ');
        entryText = markerFor(label) || label;
      }
      else entryText = edit[5];
      if (wo && !validWo(wo)) {
        errors.push(`${where}: "${wo}" is not a valid work order`);
        return;
      }
      const { category, note } = parseInput(entryText);
      entryText = note ? `${category} ${note}` : category;
      if (h > 23 || min > 59) {
        errors.push(`${where}: ${h}:${String(min).padStart(2, '0')} is not a valid time`);
        return;
      }
      if (day == null) {
        errors.push(`${where}: no date above this line (expected a line like "Thu 2026-09-24")`);
        return;
      }
      if (entryText.startsWith('/') && !isMarker(entryText)) {
        errors.push(`${where}: entries can't start with "/" (except ${Object.keys(MARKERS).join(', ')})`);
        return;
      }
      if (entryText.length > MAX_TEXT) {
        errors.push(`${where}: entries are limited to ${MAX_TEXT} characters`);
        return;
      }
      const at = new Date(day);
      at.setHours(h, min, 0, 0);
      last = { ts: at.getTime(), text: entryText, wo, notesLines: [], filesLines: [], where };
      entries.push(last);
    });
    const out = entries.map(({ ts, text: t, wo, notesLines: nl, filesLines: fl, where }) => {
      const notes = joinNotes(nl);
      if (notes.length > MAX_NOTES) errors.push(`${where}: notes are limited to ${MAX_NOTES} characters`);
      return stripEntry({ ts, text: t, notes, files: joinFiles(fl), wo });
    });
    return { entries: out, errors };
  }

  // ---- search ---------------------------------------------------------------------

  // Entries where every word appears (any case) in the text, notes, file
  // paths, work order or equipment: newest first, grouped by day, with the
  // matching notes and path lines under each. At most `limit` entries.
  function formatSearch(entries, query, now, limit = 100, opts) {
    const compact = Boolean(opts && opts.compact); // phones: two lines an entry, like /log
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const hay = (s) => [s.text, s.notes, s.files, s.wo, s.eq].filter(Boolean).join('\n').toLowerCase();
    const hits = withSpans(entries, now).filter((s) => words.every((w) => hay(s).includes(w)));
    if (!hits.length) return { count: 0, text: `nothing found for "${query}"` };
    const shown = hits.slice(-limit).reverse();
    const numWidth = Math.max(...shown.map((s) => idTag(s.n).length));
    const has = (line) => words.some((w) => line.toLowerCase().includes(w));
    const out = [`found "${query}": ${plural(hits.length, 'entry', 'entries')}${hits.length > limit ? ` (the latest ${limit})` : ''}`];
    let day = '';
    for (const s of shown) {
      const d = ymd(s.ts);
      if (d !== day) {
        day = d;
        out.push('', `${DAY_NAMES[new Date(s.ts).getDay()]} ${d}`);
      }
      const dur = s.off ? '-' : formatHM(s.duration);
      const tags = `${s.wo ? `${woTag(s.wo)} ` : ''}${s.eq ? `${eqTag(s.eq)} ` : ''}`;
      const indent = ' '.repeat(numWidth + 4);
      if (compact) {
        out.push(`  ${idTag(s.n).padEnd(numWidth)}  ${clockCol(s.ts)}  ${dur.padStart(5)}  ${tags}`.trimEnd());
        out.push(`${indent}${s.category}${s.note ? ` ${s.note}` : ''}`);
      } else {
        out.push(`  ${idTag(s.n).padEnd(numWidth)}  ${clockCol(s.ts)}  ${dur.padStart(5)}  ${tags}${s.category}${s.note ? ` ${s.note}` : ''}`);
      }
      out.push(...notesLines(s.notes, indent).filter(has), ...filesLines(s.files, indent).filter(has));
    }
    return { count: hits.length, text: out.join('\n') };
  }

  // ---- full backups ------------------------------------------------------------
  // Everything in one JSON file: entries (with their IDs), records (forms,
  // answers, to-dos, checklists, trash) and settings. Restoring adds what's
  // missing and keeps what's there.

  function makeFullBackup({ entries, records, settings, now }) {
    return `${JSON.stringify({ tymlee: 'backup', format: 1, app: VERSION, made: new Date(now).toISOString(), entries, records, settings }, null, 1)}\n`;
  }

  // The parsed backup, or null when the text isn't one.
  function readFullBackup(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('{')) return null;
    try {
      const b = JSON.parse(t);
      if (!b || b.tymlee !== 'backup' || !Array.isArray(b.entries)) return null;
      return {
        made: b.made || '',
        entries: b.entries.filter((e) => e && typeof e.id === 'string' && typeof e.ts === 'number' && typeof e.text === 'string').map((e) => makeEntry(e)),
        records: (Array.isArray(b.records) ? b.records : []).filter((r) => r && typeof r.id === 'string' && typeof r.kind === 'string' && r.body),
        settings: b.settings && typeof b.settings === 'object' ? b.settings : {},
      };
    } catch (_) {
      return null;
    }
  }

  // Backup entries that are not already in the log, as new entries. Matching
  // is by start minute and text, so restoring the same backup twice is harmless.
  function mergeBackup(existing, backup) {
    const key = (e) => `${Math.floor(e.ts / 60000)}|${e.text.toLowerCase()}`;
    const seen = new Set(existing.map(key));
    const fresh = [];
    for (const e of backup) {
      const k = key(e);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(makeEntry({ id: uuid(), ...e }));
    }
    return fresh;
  }

  // ---- sync ----------------------------------------------------------------
  // Entries are { id, ts, text }. Local changes are recorded as a queue of
  // operations that are replayed against the server:
  //   { op: 'put', entry }   create or replace an entry
  //   { op: 'del', id }      delete an entry

  function uuid() {
    const c = root.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function sortEntries(entries) {
    return entries.slice().sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Apply queued operations on top of a list of entries.
  function applyOps(entries, queue) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const q of queue) {
      if (q.op === 'put') byId.set(q.entry.id, q.entry);
      else if (q.op === 'del') byId.delete(q.id);
    }
    return sortEntries(Array.from(byId.values()));
  }

  // Merge a partial download: `recent` holds every server entry with
  // ts >= since, so it replaces that part of the local list; older local
  // entries are kept as they are until the next full download.
  function mergeRecent(local, recent, since) {
    const byId = new Map(local.filter((e) => e.ts < since).map((e) => [e.id, e]));
    for (const e of recent) byId.set(e.id, e);
    return sortEntries(Array.from(byId.values()));
  }

  // Add an operation to the queue, dropping work that no longer matters.
  // The first `locked` operations may already be on their way to the server
  // and are left untouched.
  function enqueue(queue, op, locked) {
    return enqueueAll(queue, [op], locked);
  }

  // enqueue for many operations at once, in one pass over the queue (one
  // at a time, a long log's worth would take minutes). Same rules: a newer
  // operation for an entry replaces any waiting one and goes to the end.
  function enqueueAll(queue, ops, locked) {
    const idOf = (q) => (q.op === 'put' ? q.entry.id : q.id);
    const head = queue.slice(0, locked || 0);
    const sentBefore = new Set(head.filter((q) => q.op === 'put').map((q) => q.entry.id));
    const tail = new Map(); // id -> its waiting operation, in queue order
    for (const q of queue.slice(locked || 0)) {
      tail.delete(idOf(q));
      tail.set(idOf(q), q);
    }
    for (const op of ops) {
      const id = idOf(op);
      const had = tail.get(id);
      tail.delete(id);
      // Deleting an entry the server has never seen needs no request at all,
      // unless an earlier (locked) put for it may already have been sent.
      if (!(op.op === 'del' && had && had.op === 'put' && !sentBefore.has(id))) tail.set(id, op);
    }
    return head.concat([...tail.values()]);
  }

  // The next run of same-kind operations to send in a single request.
  function nextBatch(queue, max) {
    if (!queue.length) return null;
    const kind = queue[0].op;
    let n = 0;
    while (n < queue.length && n < (max || 500) && queue[n].op === kind) n++;
    return { kind, ops: queue.slice(0, n) };
  }

  const api = {
    parseInput, knownCategories, suggest, withSpans, summarize,
    startOfDay, addDays, ymd, hhmm, formatHM, formatClock,
    parseRange, parseDue, dueLabel, ACCENTS, DEFAULT_ACCENT, accentColors, formatReport, toCSV,
    uuid, sortEntries, applyOps, mergeRecent, enqueue, enqueueAll, nextBatch,
    formatEditable, parseEditable,
    VERSION, REPO_URL,
    PAY_KEYS, payValue, setPay, hasPay, mergeSettings, weekStart, earnings, formatMoney, parseAmount,
    clock, clockCol, setClock, clockMode, hourLabel,
    MAX_FILES, MARKERS, clockAs, joinFiles, parseFiles, groupFiles, filesList, OFF, BREAK_PAID, BREAK_UNPAID, isMarker, isOff, LINK, isLink, linkCategory, visible, categorySlots, timelineDays, formatTimeline, editEntry, MAX_TEXT, MAX_NOTES, MAX_WO, validWo, woTag, eqTag, idText, idValue, idTag, validSid, assignIds, findById, eqNames, normalizeEq, EQ_RULES, makeEntry, formatCategoryReport, formatWorkOrders,
    parseBackup, mergeBackup, formatSearch, makeFullBackup, readFullBackup,
    FORM_TOKENS, parseForm, fillForm, formQuestions,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tymlee = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
