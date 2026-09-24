// Pure time-log logic. No DOM access here so it can be unit tested in Node.
(function (root) {
  'use strict';

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

  // Categories that complete what has been typed so far. Only offered while the
  // user is still typing the first word (no space yet).
  function suggest(input, categories, limit) {
    if (/\s/.test(input)) return [];
    const p = input.toLowerCase();
    const out = [];
    for (const c of categories) {
      if (c.toLowerCase().startsWith(p) && c !== input) out.push(c);
      if (out.length >= (limit || 6)) break;
    }
    return out;
  }

  // Each entry runs until the next one starts; the last one is still running.
  function withSpans(entries, now) {
    return entries.map((e, i) => {
      const next = entries[i + 1];
      const end = next ? next.ts : now;
      return {
        ...e,
        ...parseInput(e.text),
        end,
        running: !next,
        duration: Math.max(0, end - e.ts),
      };
    });
  }

  // Total time per category that falls within [from, to).
  function totalsByCategory(entries, from, to, now) {
    const totals = new Map();
    for (const s of withSpans(entries, now)) {
      const start = Math.max(s.ts, from);
      const end = Math.min(s.end, to);
      if (end <= start) continue;
      const key = s.category.toLowerCase();
      const cur = totals.get(key) || { category: s.category, ms: 0 };
      cur.ms += end - start;
      cur.category = s.category;
      totals.set(key, cur);
    }
    return Array.from(totals.values()).sort((a, b) => b.ms - a.ms);
  }

  function formatDuration(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  // Plain text export: one "ISO-timestamp<TAB>text" line per entry.
  function toText(entries) {
    return entries.map((e) => `${new Date(e.ts).toISOString()}\t${e.text}`).join('\n') + '\n';
  }

  const api = { parseInput, knownCategories, suggest, withSpans, totalsByCategory, formatDuration, toText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tymlee = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
