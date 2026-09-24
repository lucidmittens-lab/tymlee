// Pure time-log logic and report formatting. No DOM access here so it can be
// unit tested in Node. All dates are interpreted in the local time zone.
(function (root) {
  'use strict';

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
      const cat = parseInput(entries[i].text).category;
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
  // `n` is the entry's 1-based position in the whole log.
  function withSpans(entries, now) {
    return entries.map((e, i) => {
      const next = entries[i + 1];
      const end = next ? next.ts : now;
      return {
        ...e,
        ...parseInput(e.text),
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
      out.push(`  ${'#'.padStart(numWidth)}  start  ${endHead}${'dur'.padStart(6)}  ${'category'.padEnd(catWidth)}  note`);
      for (const s of day.spans) {
        const end = compact ? '' : `${s.running ? 'now  ' : hhmm(s.end)}  `;
        out.push(
          `  ${String(s.n).padStart(numWidth)}  ${hhmm(s.ts)}  ${end}${formatHM(s.duration).padStart(6)}  ` +
          `${s.category.padEnd(catWidth)}  ${s.note}`.trimEnd(),
        );
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

  function csvField(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // One row per entry; timestamps are ISO 8601 (UTC), running entries have no end.
  function toCSV(entries, range, now) {
    const rows = [['n', 'start', 'end', 'minutes', 'category', 'note']];
    for (const s of withSpans(entries, now)) {
      if (s.ts < range.from || s.ts >= range.to) continue;
      rows.push([
        s.n,
        new Date(s.ts).toISOString(),
        s.running ? '' : new Date(s.end).toISOString(),
        (s.duration / 60000).toFixed(1),
        s.category,
        s.note,
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
  ];

  // Returns the text to edit and the entries it covers.
  function formatEditable(entries, range, now) {
    const items = withSpans(entries, now)
      .filter((s) => s.ts >= range.from && s.ts < range.to)
      .map((s) => ({ n: s.n, id: s.id, ts: s.ts, text: s.text }));
    const lines = EDIT_HELP.slice();
    const numWidth = items.length ? String(items[items.length - 1].n).length : 1;
    let day = '';
    for (const it of items) {
      const d = ymd(it.ts);
      if (d !== day) {
        day = d;
        lines.push(`${DAY_NAMES[new Date(it.ts).getDay()]} ${d}`);
      }
      lines.push(`  ${String(it.n).padStart(numWidth)}  ${hhmm(it.ts)}  ${it.text}`);
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
    const ops = [];
    let changed = 0;
    let added = 0;
    let day = startOfDay(now);

    String(text).split('\n').forEach((raw, i) => {
      const line = raw.trim();
      const where = `line ${i + 1}`;
      if (!line || line.startsWith('#')) return;

      const header = line.match(/^(?:[A-Za-z]{3}\s+)?(\d{4})-(\d{2})-(\d{2})$/);
      if (header) {
        const d = new Date(+header[1], +header[2] - 1, +header[3]);
        if (d.getMonth() !== +header[2] - 1) errors.push(`${where}: "${line}" is not a real date`);
        else day = d.getTime();
        return;
      }

      const m = line.match(/^(?:(\d+)\s+)?(\d{1,2}):(\d{2})\s+(\S.*)$/);
      if (!m) {
        errors.push(`${where}: expected "HH:MM text", e.g. "14:30 dev code review"`);
        return;
      }
      const h = +m[2];
      const min = +m[3];
      if (h > 23 || min > 59) {
        errors.push(`${where}: ${m[2]}:${m[3]} is not a valid time`);
        return;
      }
      const { category, note } = parseInput(m[4]);
      const entryText = note ? `${category} ${note}` : category;
      const at = new Date(day);
      at.setHours(h, min, 0, 0);
      let ts = at.getTime();

      if (m[1] != null) {
        const n = +m[1];
        const it = byN.get(n);
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
        if (ts > now) {
          errors.push(`${where}: ${hhmm(ts)} on ${ymd(ts)} is in the future`);
          return;
        }
        if (ts !== it.ts || entryText !== it.text) {
          ops.push({ op: 'put', entry: { id: it.id, ts, text: entryText } });
          changed++;
        }
      } else {
        if (ts > now) {
          errors.push(`${where}: ${hhmm(ts)} on ${ymd(ts)} is in the future`);
          return;
        }
        ops.push({ op: 'put', entry: { id: uuid(), ts, text: entryText } });
        added++;
      }
    });

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
    uuid, sortEntries, applyOps, enqueue, nextBatch,
    formatEditable, parseEditable,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tymlee = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
