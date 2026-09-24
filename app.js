(function () {
  'use strict';

  const T = window.Tymlee;
  const STORAGE_KEY = 'tymlee.entries.v1';

  const $ = (id) => document.getElementById(id);
  const out = $('out');
  const form = $('prompt');
  const input = $('entry');
  const ghost = $('ghost');
  const matchesEl = $('matches');
  const statusEl = $('status');

  let entries = load();

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
      print('warning: could not save to browser storage; this session is not persisted', 'err');
    }
  }

  // Keep multiple open tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      entries = load();
      renderStatus();
    }
  });

  // ---- output --------------------------------------------------------------

  function print(text, cls) {
    const pre = document.createElement('pre');
    if (cls) pre.className = cls;
    pre.textContent = text;
    out.append(pre);
    return pre;
  }

  function echo(text) {
    const pre = print('', 'echo');
    const b = document.createElement('b');
    b.textContent = text;
    pre.append('> ', b);
  }

  // Like a terminal, jump to the bottom after every command.
  function scrollToPrompt() {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }

  // ---- entries -------------------------------------------------------------

  function describe(s) {
    return s.note ? `${s.category} ${s.note}` : s.category;
  }

  function add(text) {
    const { category, note } = T.parseInput(text);
    const now = Math.max(Date.now(), entries.length ? entries[entries.length - 1].ts + 1 : 0);
    const prev = entries.length ? T.withSpans(entries, now).pop() : null;
    entries.push({ ts: now, text: note ? `${category} ${note}` : category });
    save();
    const parts = [T.hhmm(now)];
    if (prev) parts.push(`out ${prev.category} (${T.formatHM(prev.duration)})`);
    parts.push(`in #${entries.length} ${describe(T.parseInput(text))}`);
    print(parts.join('  '), 'ok');
  }

  // ---- commands ------------------------------------------------------------

  const COMMANDS = {
    help: {
      usage: '/help',
      about: 'show this help',
      run() {
        print([
          'Type what you are starting and press Enter. That clocks you in to the new',
          'entry and out of the previous one. The first word is the category.',
          '',
          '  dev fixing the login bug',
          '  mtg standup',
          '',
          'Commands:',
          ...Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(26)}${c.about}`),
          '',
          'Ranges: today (default), yesterday, week, month, all, Nd (last N days),',
          '        YYYY-MM-DD, or YYYY-MM-DD..YYYY-MM-DD',
          '',
          'Keys:   Tab / Right   complete category (Tab again to cycle)',
          '        Up / Down     previous inputs',
          '        Ctrl+Z        undo (on an empty line)',
          '        Ctrl+L        clear the screen',
        ].join('\n'), 'report dim');
      },
    },
    log: {
      usage: '/log [range]',
      about: 'print the log for a range',
      run(args) {
        const range = rangeFrom(args);
        if (range) print(T.formatReport(entries, range, Date.now()), 'report');
      },
    },
    undo: {
      usage: '/undo',
      about: 'remove the last entry',
      run() {
        if (!entries.length) return print('nothing to undo', 'err');
        const now = Date.now();
        const last = T.withSpans(entries, now).pop();
        entries.pop();
        save();
        const msg = [`undid #${last.n} ${T.hhmm(last.ts)} ${describe(last)}`];
        if (entries.length) msg.push(`resumed ${describe(T.withSpans(entries, now).pop())}`);
        print(msg.join('  '), 'ok');
      },
    },
    rm: {
      usage: '/rm <#>',
      about: 'delete an entry by number (its time goes to the one before)',
      run(args) {
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 1 || n > entries.length) {
          return print(`usage: /rm <#>   (# between 1 and ${entries.length || 1}, see /log)`, 'err');
        }
        const s = T.withSpans(entries, Date.now())[n - 1];
        entries.splice(n - 1, 1);
        save();
        print(`removed #${n} ${T.ymd(s.ts)} ${T.hhmm(s.ts)} ${describe(s)}`, 'ok');
      },
    },
    export: {
      usage: '/export [range] [csv]',
      about: 'download the log as .txt (or .csv)',
      run(args) {
        const csv = args.some((a) => a.toLowerCase() === 'csv');
        const range = rangeFrom(args.filter((a) => a.toLowerCase() !== 'csv'));
        if (!range) return;
        const now = Date.now();
        const count = entries.filter((e) => e.ts >= range.from && e.ts < range.to).length;
        if (!count) return print(`no entries (${range.label})`, 'err');
        const body = csv ? T.toCSV(entries, range, now) : T.formatReport(entries, range, now) + '\n';
        const name = `tymlee-${range.label === 'today' ? T.ymd(now) : range.label}.${csv ? 'csv' : 'txt'}`;
        download(name, body, csv ? 'text/csv' : 'text/plain');
        print(`exported ${count} entr${count === 1 ? 'y' : 'ies'} -> ${name}`, 'ok');
      },
    },
    copy: {
      usage: '/copy [range]',
      about: 'copy the log to the clipboard',
      run(args) {
        const range = rangeFrom(args);
        if (!range) return;
        const text = T.formatReport(entries, range, Date.now());
        if (!navigator.clipboard) return print('clipboard not available here; use /export', 'err');
        navigator.clipboard.writeText(text).then(
          () => print(`copied ${range.label} to clipboard`, 'ok'),
          () => print('could not copy; use /export', 'err'),
        );
      },
    },
    clear: {
      usage: '/clear',
      about: 'clear the screen (the log is kept)',
      run() { out.replaceChildren(); },
    },
  };
  const ALIASES = { ls: 'log', h: 'help', '?': 'help', z: 'undo' };
  const COMMAND_WORDS = Object.keys(COMMANDS).map((c) => '/' + c);

  function rangeFrom(args) {
    const word = args.join('');
    const range = T.parseRange(word, Date.now());
    if (!range) print(`unknown range "${word}"; try today, yesterday, week, month, all, 3d or 2026-01-31`, 'err');
    return range;
  }

  function runCommand(line) {
    const [word, ...args] = line.slice(1).trim().split(/\s+/);
    const name = ALIASES[word.toLowerCase()] || word.toLowerCase();
    const cmd = COMMANDS[name];
    if (!cmd) return print(`unknown command "/${word}"; type /help`, 'err');
    cmd.run(args);
  }

  function download(name, body, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- input: completion ---------------------------------------------------

  // Candidates for the first word: commands after "/", categories otherwise.
  function candidates(text) {
    return text.startsWith('/') ? COMMAND_WORDS : T.knownCategories(entries);
  }

  // Tab cycling state: the list being cycled and the current position.
  let cycle = null;

  function renderHints() {
    const typed = input.value;
    ghost.replaceChildren();
    let list = [];
    let sel = -1;
    if (cycle) {
      list = cycle.matches;
      sel = cycle.idx;
    } else if (typed) {
      list = T.suggest(typed, candidates(typed));
      sel = 0;
      if (list[0]) {
        const span = document.createElement('span');
        span.className = 'typed';
        span.textContent = typed;
        ghost.append(span, list[0].slice(typed.length));
      }
    }
    matchesEl.replaceChildren(...list.map((m, i) => {
      const span = document.createElement('span');
      span.textContent = m;
      if (i === sel) span.className = 'sel';
      span.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        complete(m);
      });
      return span;
    }));
  }

  function complete(word) {
    input.value = word + ' ';
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function tab() {
    if (cycle && input.value === cycle.matches[cycle.idx] + ' ') {
      cycle.idx = (cycle.idx + 1) % cycle.matches.length;
    } else {
      const typed = input.value;
      const matches = T.suggest(typed, candidates(typed), { includeExact: true, limit: 20 });
      if (!matches.length) return;
      cycle = { matches, idx: 0 };
    }
    complete(cycle.matches[cycle.idx]);
    renderHints();
  }

  // ---- input: history ------------------------------------------------------

  const history = entries.slice(-100).map((e) => e.text);
  let histIdx = history.length;
  let draft = '';

  function recall(step) {
    const next = histIdx + step;
    if (next < 0 || next > history.length) return;
    if (histIdx === history.length) draft = input.value;
    histIdx = next;
    input.value = histIdx === history.length ? draft : history[histIdx];
    input.setSelectionRange(input.value.length, input.value.length);
    cycle = null;
    renderHints();
  }

  // ---- input: events -------------------------------------------------------

  input.addEventListener('input', () => {
    cycle = null;
    renderHints();
  });
  input.addEventListener('scroll', () => { ghost.scrollLeft = input.scrollLeft; });

  input.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const atEnd = input.selectionStart === input.value.length;
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      tab();
    } else if (e.key === 'ArrowRight' && atEnd && ghost.textContent) {
      e.preventDefault();
      complete(T.suggest(input.value, candidates(input.value))[0]);
      cycle = null;
      renderHints();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      recall(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      recall(1);
    } else if (e.key === 'Escape') {
      input.value = '';
      cycle = null;
      renderHints();
    } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !input.value) {
      e.preventDefault();
      submit('/undo');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      out.replaceChildren();
    }
  });

  function submit(line) {
    echo(line);
    if (line.startsWith('/')) runCommand(line);
    else add(line);
    if (history[history.length - 1] !== line) history.push(line);
    histIdx = history.length;
    draft = '';
    renderStatus();
    scrollToPrompt();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const line = input.value.trim();
    input.value = '';
    cycle = null;
    renderHints();
    if (line) submit(line);
  });

  // Clicking anywhere in the terminal focuses the prompt, unless selecting text.
  $('term').addEventListener('click', () => {
    if (!String(window.getSelection())) input.focus();
  });

  // ---- status bar ----------------------------------------------------------

  function renderStatus() {
    const now = Date.now();
    if (!entries.length) {
      statusEl.textContent = 'not clocked in · type /help';
      return;
    }
    const spans = T.withSpans(entries, now);
    const cur = spans[spans.length - 1];
    // Same rule as the report: an entry counts toward the day it started on.
    const today = T.startOfDay(now);
    const todayMs = spans.reduce((sum, s) => sum + (s.ts >= today ? s.duration : 0), 0);
    const run = document.createElement('span');
    run.className = 'run';
    run.textContent = `▶ ${T.formatClock(cur.duration)}`;
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = `   today ${T.formatHM(todayMs)} · since ${T.hhmm(cur.ts)}`;
    statusEl.replaceChildren(run, `  ${describe(cur)}`, dim);
  }

  // ---- boot ----------------------------------------------------------------

  print('tymlee · type what you are starting and press Enter · /help for commands', 'dim');
  if (entries.length) {
    print(T.formatReport(entries, T.parseRange('today', Date.now()), Date.now()), 'report');
  }
  renderStatus();
  renderHints();
  setInterval(renderStatus, 1000);
})();
