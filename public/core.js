// Pure time-log logic and report formatting. No DOM access here so it can be
// unit tested in Node. All dates are interpreted in the local time zone.
(function (root) {
  'use strict';

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // /off is stored as an entry with this text. Typed entries can never start
  // with "/" (that is a command), so it cannot clash with a real entry. Time
  // from an off marker to the next entry is not tracked.
  const OFF = '/off';
  // Longest entry text and notes accepted (the server allows room for
  // encryption).
  const MAX_TEXT = 1000;
  const MAX_NOTES = 1000;

  // Work orders: a short code per entry (no spaces or brackets), shown as
  // "[4471]" in a column before the start time.
  const MAX_WO = 40;
  const validWo = (wo) => typeof wo === 'string' && /^[^\s\[\]]{1,40}$/.test(wo);
  const woTag = (wo) => (wo ? `[${wo}]` : '');

  // An entry with its optional fields set only when they have a value.
  function makeEntry(base, extra) {
    const e = { id: base.id, ts: base.ts, text: base.text };
    const x = { notes: base.notes, wo: base.wo, wl: base.wl, ...(extra || {}) };
    if (x.notes) e.notes = x.notes;
    if (x.wo) {
      e.wo = x.wo;
      if (x.wl) e.wl = true;
    }
    return e;
  }

  // Notes are shown under their entry as lines starting with "> ", in /log,
  // /edit and text backups.
  function notesLines(notes, indent) {
    if (!notes) return [];
    return String(notes).split('\n').map((l) => `${indent}> ${l}`.trimEnd());
  }

  // "> some text" -> "some text" (null if the line isn't a notes line).
  function notesLine(trimmed) {
    if (!trimmed.startsWith('>')) return null;
    return trimmed.slice(1).replace(/^ /, '');
  }

  // Joined notes, or '' when there are none.
  function joinNotes(lines) {
    return lines.join('\n').replace(/\s+$/, '').replace(/^\s*\n/, '');
  }
  const isOff = (e) => Boolean(e) && e.text === OFF;

  // /wolink stores "dev -> WO 4471 for this day" as a hidden entry with the
  // text "/wo dev", at the start of that day. It syncs like an entry but is
  // never shown, timed or numbered; new entries of that category that day
  // pick up its work order.
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
      if (isOff(entries[i])) continue;
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
        ...(off ? { category: '(off)', note: '' } : parseInput(e.text)),
        off,
        n: i + 1,
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

  function hhmm(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
    return null;
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

    const numWidth = Math.max(1, String(spans[spans.length - 1].n).length);
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
      const endHead = compact ? '' : 'end    ';
      const woHead = woWidth ? `${'wo'.padEnd(woWidth)}  ` : '';
      out.push(`  ${'#'.padStart(numWidth)}  ${woHead}start  ${endHead}${'dur'.padStart(6)}  ${'category'.padEnd(catWidth)}  note`);
      for (const s of day.spans) {
        const end = compact ? '' : `${s.running ? 'now  ' : hhmm(s.end)}  `;
        const dur = s.off ? '-' : formatHM(s.duration);
        out.push(
          `  ${String(s.n).padStart(numWidth)}  ${woCell(s)}${hhmm(s.ts)}  ${end}${dur.padStart(6)}  ` +
          `${s.category.padEnd(catWidth)}  ${s.note}`.trimEnd(),
        );
        out.push(...notesLines(s.notes, ' '.repeat(numWidth + 4)));
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
    const numWidth = Math.max(1, String(spans[spans.length - 1].n).length);
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
        const when = multiDay ? `${DAY_NAMES[new Date(s.ts).getDay()]} ${ymd(s.ts).slice(5)} ${hhmm(s.ts)}` : hhmm(s.ts);
        const wo = woWidth ? `${woTag(s.wo).padEnd(woWidth)}  ` : '';
        out.push(`  ${String(s.n).padStart(numWidth)}  ${wo}${when}  ${formatHM(s.duration).padStart(6)}  ${s.note}`.trimEnd());
        out.push(...notesLines(s.notes, ' '.repeat(numWidth + 4)));
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

  // ---- timeline ------------------------------------------------------------

  // Color slot per category: the first 8 categories ever used get slots 0-7
  // in the order they first appeared, so a category keeps its color and a new
  // one never repaints the others. Later categories share slot -1 ("other").
  const TIMELINE_SLOTS = 8;
  function categorySlots(entries) {
    const slots = new Map();
    for (const e of visible(entries)) {
      if (isOff(e)) continue;
      const key = parseInput(e.text).category.toLowerCase();
      if (!slots.has(key)) slots.set(key, slots.size < TIMELINE_SLOTS ? slots.size : -1);
    }
    return slots;
  }

  // Days in [from, to) as blocks for a vertical timeline. Each block is an
  // entry (or off time) clipped to its day; `axisFrom`/`axisTo` are whole
  // hours (ms) spanning the logged time of every day, for a shared axis.
  function timelineDays(entries, range, now) {
    const slots = categorySlots(entries);
    const spans = withSpans(entries, now).filter((s) => s.ts >= range.from && s.ts < range.to);
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
          n: s.n, id: s.id, category: s.category, note: s.note, notes: s.notes || '', wo: s.wo || '',
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
      // Axis in minutes from midnight, so days can share it.
      axisFrom = Math.min(axisFrom, fromHour * 60);
      axisTo = Math.max(axisTo, toHour * 60);
    }
    const legend = summarize(spans).map((t) => ({ ...t, slot: slots.get(t.category.toLowerCase()) }));
    return { days, axisFrom: Math.min(axisFrom, axisTo - 60), axisTo, legend };
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
        const label = b.off ? 'off' : `${b.wo ? `${woTag(b.wo)} ` : ''}${b.category}${b.note ? ` · ${b.note}` : ''}`;
        const dur = b.off ? formatHM(b.end - b.start) : `${formatHM(b.duration)}${b.running ? ' ▶' : ''}`;
        const room = Math.max(10, width - 8 - 3 - dur.length - 2);
        const text = label.length > room ? `${label.slice(0, room - 1)}…` : label;
        out.push(`${hhmm(b.start)}  ${bar} ${text.padEnd(room)}  ${dur}`.trimEnd());
        const extra = [];
        if (b.notes) for (const l of b.notes.split('\n')) extra.push(`> ${l}`);
        for (let i = 1; i < rows || extra.length; i++) {
          const note = extra.shift();
          const more = i === rows - 1 && want > rows && !note ? ' ⋮' : '';
          out.push(`       ${i < rows ? bar : '  '} ${note ? note.slice(0, room) : ''}${more}`.trimEnd());
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
    const rows = [['n', 'wo', 'start', 'end', 'minutes', 'category', 'note', 'notes']];
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
    '# new line: 14:30 dev review',
    '# notes: "> text" under an entry',
    '# work order: [4471] before the time',
  ];

  // Returns the text to edit and the entries it covers.
  function formatEditable(entries, range, now) {
    const items = withSpans(entries, now)
      .filter((s) => s.ts >= range.from && s.ts < range.to)
      .map((s) => ({ n: s.n, id: s.id, ts: s.ts, text: s.text, notes: s.notes || '', wo: s.wo || '', wl: Boolean(s.wl) }));
    const lines = EDIT_HELP.slice();
    const numWidth = items.length ? String(items[items.length - 1].n).length : 1;
    let day = '';
    for (const it of items) {
      const d = ymd(it.ts);
      if (d !== day) {
        day = d;
        lines.push(`${DAY_NAMES[new Date(it.ts).getDay()]} ${d}`);
      }
      lines.push(`  ${String(it.n).padStart(numWidth)}  ${it.wo ? `${woTag(it.wo)}  ` : ''}${hhmm(it.ts)}  ${it.text}`);
      lines.push(...notesLines(it.notes, ' '.repeat(numWidth + 11)));
    }
    if (!items.length) lines.push(`${DAY_NAMES[new Date(now).getDay()]} ${ymd(now)}`);
    return { text: lines.join('\n') + '\n', items };
  }

  // Turn edited text back into operations against the original entries.
  // Returns { ops, errors, changed, added, removed }; ops is empty on error.
  function parseEditable(text, items, now) {
    const byN = new Map(items.map((it) => [it.n, it]));
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
      current = null;

      const header = line.match(/^(?:[A-Za-z]{3}\s+)?(\d{4})-(\d{2})-(\d{2})$/);
      if (header) {
        const d = new Date(+header[1], +header[2] - 1, +header[3]);
        if (d.getMonth() !== +header[2] - 1) errors.push(`${where}: "${line}" is not a real date`);
        else day = d.getTime();
        return;
      }

      const m = line.match(/^(?:(\d+)\s+)?(?:\[([^\]]*)\]\s+)?(\d{1,2}):(\d{2})\s+(\S.*)$/);
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
      if (entryText.startsWith('/') && entryText !== OFF) {
        errors.push(`${where}: entries can't start with "/" (the only exception is ${OFF})`);
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
        const n = +m[1];
        it = byN.get(n);
        if (!it) {
          errors.push(`${where}: there is no entry #${n} in this list (remove the number to add a new entry)`);
          return;
        }
        if (seen.has(n)) {
          errors.push(`${where}: entry #${n} appears more than once`);
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
      current = { where, it, ts, text: entryText, wo, notes: [] };
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
      // A work order typed here applies to this entry only, unless it is
      // the one it already had (which keeps any /wolink).
      const keepsLink = Boolean(r.it && r.it.wl && r.wo === r.it.wo);
      const entry = makeEntry({ id: r.it ? r.it.id : uuid(), ts: r.ts, text: r.text }, { notes, wo: r.wo, wl: keepsLink });
      if (!r.it) {
        ops.push({ op: 'put', entry });
        added++;
      } else if (r.ts !== r.it.ts || r.text !== r.it.text || notes !== (r.it.notes || '') || r.wo !== (r.it.wo || '')) {
        ops.push({ op: 'put', entry });
        changed++;
      }
    }

    let removed = 0;
    for (const it of items) {
      if (!seen.has(it.n)) {
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
  const isCsvHeader = (line) => /^n,(wo,)?start,end,minutes,category,note(,notes)?$/.test(line.trim());

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
      entries.push({ ts, end, text: entryText, notes, wo });
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
    if (e.wo) out.wo = e.wo;
    return out;
  }

  // Returns { entries: [{ ts, text, notes? }], errors }.
  function parseBackup(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
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
      last = null;
      // Rules, "no entries" notes and multi-day summaries carry no entries.
      if (/^-+$/.test(line) || /^no entries \(/.test(line)) return;
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
      const row = line.match(/^\d+\s+(?:\[([^\]\s]+)\]\s+)?(\d{1,2}):(\d{2})\s+(?:(?:\d{1,2}:\d{2}|now)\s+)?(?:-|\d+:\d{2})\s+(\S+)(?:\s+(.*))?$/);
      // /edit line:  3  [4471]  09:00  dev note   or   09:00 dev note
      const edit = !row && line.match(/^(?:\d+\s+)?(?:\[([^\]\s]+)\]\s+)?(\d{1,2}):(\d{2})\s+(\S.*)$/);
      if (!row && !edit) {
        // Per-category summary lines:  dev   0:57   79%
        if (/^\S+\s+\d+:\d{2}(?:\s+\d+%)?$/.test(line)) return;
        errors.push(`${where}: not a tymlee log line: "${line.slice(0, 40)}"`);
        return;
      }
      const m = row || edit;
      const wo = m[1] || '';
      const [h, min] = [+m[2], +m[3]];
      let entryText;
      if (row) entryText = row[4] === '(off)' ? OFF : [row[4], row[5]].filter(Boolean).join(' ');
      else entryText = edit[4];
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
      if (entryText.startsWith('/') && entryText !== OFF) {
        errors.push(`${where}: entries can't start with "/" (the only exception is ${OFF})`);
        return;
      }
      if (entryText.length > MAX_TEXT) {
        errors.push(`${where}: entries are limited to ${MAX_TEXT} characters`);
        return;
      }
      const at = new Date(day);
      at.setHours(h, min, 0, 0);
      last = { ts: at.getTime(), text: entryText, wo, notesLines: [], where };
      entries.push(last);
    });
    const out = entries.map(({ ts, text: t, wo, notesLines: nl, where }) => {
      const notes = joinNotes(nl);
      if (notes.length > MAX_NOTES) errors.push(`${where}: notes are limited to ${MAX_NOTES} characters`);
      return stripEntry({ ts, text: t, notes, wo });
    });
    return { entries: out, errors };
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
    const head = queue.slice(0, locked || 0);
    let tail = queue.slice(locked || 0);
    const id = op.op === 'put' ? op.entry.id : op.id;
    const hadPut = tail.some((q) => q.op === 'put' && q.entry.id === id);
    tail = tail.filter((q) => (q.op === 'put' ? q.entry.id : q.id) !== id);
    // Deleting an entry the server has never seen needs no request at all,
    // unless an earlier (locked) put for it may already have been sent.
    const sentBefore = head.some((q) => q.op === 'put' && q.entry.id === id);
    if (!(op.op === 'del' && hadPut && !sentBefore)) tail.push(op);
    return head.concat(tail);
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
    parseRange, formatReport, toCSV,
    uuid, sortEntries, applyOps, mergeRecent, enqueue, nextBatch,
    formatEditable, parseEditable,
    OFF, isOff, LINK, isLink, linkCategory, visible, categorySlots, timelineDays, formatTimeline, MAX_TEXT, MAX_NOTES, MAX_WO, validWo, woTag, makeEntry, formatCategoryReport, formatWorkOrders,
    parseBackup, mergeBackup,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tymlee = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
