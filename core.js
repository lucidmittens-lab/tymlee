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

  const RULE = '-'.repeat(56);

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
  function formatReport(entries, range, now) {
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
      out.push(`  ${'#'.padStart(numWidth)}  start  end    ${'dur'.padStart(6)}  ${'category'.padEnd(catWidth)}  note`);
      for (const s of day.spans) {
        const end = s.running ? 'now  ' : hhmm(s.end);
        out.push(
          `  ${String(s.n).padStart(numWidth)}  ${hhmm(s.ts)}  ${end}  ${formatHM(s.duration).padStart(6)}  ` +
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

  const api = {
    parseInput, knownCategories, suggest, withSpans, summarize,
    startOfDay, addDays, ymd, hhmm, formatHM, formatClock,
    parseRange, formatReport, toCSV,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tymlee = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
