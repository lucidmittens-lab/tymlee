(function () {
  'use strict';

  const T = window.Tymlee;
  const STORAGE_KEY = 'tymlee.entries.v1';

  const $ = (id) => document.getElementById(id);
  const form = $('entry-form');
  const input = $('entry');
  const ghost = $('ghost');
  const list = $('suggestions');
  const undoBtn = $('undo');
  const exportBtn = $('export');
  const currentEl = $('current');
  const totalsEl = $('totals');
  const logEl = $('log');

  let entries = load();
  let suggestions = [];
  let selected = 0;

  // ---- storage -------------------------------------------------------------

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(data) ? data.filter((e) => e && typeof e.ts === 'number' && typeof e.text === 'string') : [];
    } catch (_) {
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (_) {
      // Storage full or blocked; the in-memory log still works for this tab.
    }
  }

  // Keep multiple open tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      entries = load();
      render();
    }
  });

  // ---- actions -------------------------------------------------------------

  function add(text) {
    const clean = T.parseInput(text);
    if (!clean.category) return;
    const ts = Math.max(Date.now(), entries.length ? entries[entries.length - 1].ts + 1 : 0);
    entries.push({ ts, text: clean.note ? `${clean.category} ${clean.note}` : clean.category });
    save();
    render();
  }

  function undo() {
    if (!entries.length) return;
    entries.pop();
    save();
    render();
  }

  function remove(ts) {
    const i = entries.findIndex((e) => e.ts === ts);
    if (i === -1) return;
    if (i !== entries.length - 1 && !confirm(`Delete "${entries[i].text}"?\nIts time will be added to the entry before it.`)) return;
    entries.splice(i, 1);
    save();
    render();
  }

  function exportLog() {
    const blob = new Blob([T.toText(entries)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tymlee-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- category autocomplete ----------------------------------------------

  function updateSuggestions() {
    suggestions = T.suggest(input.value, T.knownCategories(entries));
    selected = 0;
    renderSuggestions();
  }

  function renderSuggestions() {
    list.replaceChildren(...suggestions.map((c, i) => {
      const li = document.createElement('li');
      li.textContent = c;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === selected));
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        accept(i);
      });
      return li;
    }));

    // Inline completion for the highlighted category, only once typing has begun.
    const typed = input.value;
    const pick = suggestions[selected];
    ghost.replaceChildren();
    if (typed && pick) {
      const span = document.createElement('span');
      span.className = 'typed';
      span.textContent = typed;
      ghost.append(span, pick.slice(typed.length));
    }
  }

  function accept(i) {
    const pick = suggestions[i];
    if (!pick) return false;
    input.value = pick + ' ';
    input.setSelectionRange(input.value.length, input.value.length);
    updateSuggestions();
    return true;
  }

  input.addEventListener('input', updateSuggestions);
  input.addEventListener('scroll', () => { ghost.scrollLeft = input.scrollLeft; });

  input.addEventListener('keydown', (e) => {
    const atEnd = input.selectionStart === input.value.length;
    if (e.key === 'Tab' && !e.shiftKey && suggestions.length) {
      e.preventDefault();
      accept(selected);
    } else if (e.key === 'ArrowRight' && atEnd && input.value && suggestions.length) {
      e.preventDefault();
      accept(selected);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      selected = (selected + step + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (e.key === 'Escape') {
      suggestions = [];
      renderSuggestions();
    } else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !input.value) {
      e.preventDefault();
      undo();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    add(input.value);
    input.value = '';
    updateSuggestions();
  });

  undoBtn.addEventListener('click', () => { undo(); input.focus(); });
  exportBtn.addEventListener('click', exportLog);

  // ---- rendering -----------------------------------------------------------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function label(span) {
    const frag = document.createDocumentFragment();
    frag.append(el('span', 'cat', span.category));
    if (span.note) frag.append(' ', el('span', 'note', span.note));
    return frag;
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function renderCurrent(spans) {
    const cur = spans[spans.length - 1];
    currentEl.hidden = !cur;
    if (!cur) return;
    currentEl.replaceChildren(
      el('span', null),
      el('span', 'timer', T.formatDuration(cur.duration)),
    );
    currentEl.firstChild.append(label(cur));
  }

  function renderTotals(now) {
    const from = startOfDay(now);
    const totals = T.totalsByCategory(entries, from, from + 86400000, now);
    if (!totals.length) {
      totalsEl.replaceChildren(el('li', 'empty', 'Nothing tracked yet today.'));
      return;
    }
    totalsEl.replaceChildren(...totals.map((t) => {
      const li = el('li');
      li.append(el('span', 'cat', t.category), el('span', null, T.formatDuration(t.ms)));
      return li;
    }));
  }

  function renderLog(spans) {
    if (!spans.length) {
      logEl.replaceChildren(el('p', 'log-empty', 'Type what you are starting and press Enter. The first word is the category.'));
      return;
    }
    const days = [];
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i];
      const day = startOfDay(s.ts);
      if (!days.length || days[days.length - 1].day !== day) days.push({ day, rows: [] });
      days[days.length - 1].rows.push(s);
    }
    logEl.replaceChildren(...days.map(({ day, rows }) => {
      const sec = el('div', 'day');
      sec.append(el('h3', null, dayFmt.format(day)));
      for (const s of rows) {
        const row = el('div', 'row' + (s.running ? ' running' : ''));
        const text = el('span');
        text.append(label(s));
        const del = el('button', 'del', '×');
        del.type = 'button';
        del.title = 'Delete entry';
        del.addEventListener('click', () => remove(s.ts));
        row.append(el('span', 'time', timeFmt.format(s.ts)), text, el('span', 'dur', T.formatDuration(s.duration)), del);
        sec.append(row);
      }
      return sec;
    }));
  }

  function render() {
    const now = Date.now();
    const spans = T.withSpans(entries, now);
    renderCurrent(spans);
    renderTotals(now);
    renderLog(spans);
    undoBtn.disabled = !entries.length;
    exportBtn.disabled = !entries.length;
    updateSuggestions();
  }

  // Live-update only the running parts every second.
  function tick() {
    if (!entries.length) return;
    const now = Date.now();
    const spans = T.withSpans(entries, now);
    renderCurrent(spans);
    renderTotals(now);
    const runningDur = logEl.querySelector('.row.running .dur');
    if (runningDur) runningDur.textContent = T.formatDuration(spans[spans.length - 1].duration);
  }

  render();
  setInterval(tick, 1000);
})();
