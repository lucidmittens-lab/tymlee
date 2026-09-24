(function () {
  'use strict';

  const T = window.Tymlee;

  const $ = (id) => document.getElementById(id);
  const out = $('out');
  const form = $('prompt');
  const input = $('entry');
  const ghost = $('ghost');
  const matchesEl = $('matches');
  const statusEl = $('status');

  const store = window.TymleeStore.createStore({
    onChange: () => renderStatus(),
    onNotice: (text, cls) => { print(text, cls); scrollToPrompt(); },
  });

  // Keep multiple open tabs showing the same log.
  window.addEventListener('storage', (e) => {
    if (e.key === store.storageKey()) store.reloadFromStorage();
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
    const before = store.entries;
    const entry = store.add(note ? `${category} ${note}` : category);
    const prev = before.length ? T.withSpans(before, entry.ts).pop() : null;
    const parts = [T.hhmm(entry.ts)];
    if (prev) parts.push(`out ${prev.category} (${T.formatHM(prev.duration)})`);
    parts.push(`in #${store.entries.length} ${describe(T.parseInput(entry.text))}`);
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
        if (range) print(T.formatReport(store.entries, range, Date.now()), 'report');
      },
    },
    undo: {
      usage: '/undo',
      about: 'remove the last entry',
      run() {
        if (!store.entries.length) return print('nothing to undo', 'err');
        const now = Date.now();
        const last = T.withSpans(store.entries, now).pop();
        store.remove(last.id);
        const msg = [`undid #${last.n} ${T.hhmm(last.ts)} ${describe(last)}`];
        if (store.entries.length) msg.push(`resumed ${describe(T.withSpans(store.entries, now).pop())}`);
        print(msg.join('  '), 'ok');
      },
    },
    rm: {
      usage: '/rm <#>',
      about: 'delete an entry by number (its time goes to the one before)',
      run(args) {
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 1 || n > store.entries.length) {
          return print(`usage: /rm <#>   (# between 1 and ${store.entries.length || 1}, see /log)`, 'err');
        }
        const s = T.withSpans(store.entries, Date.now())[n - 1];
        store.remove(s.id);
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
        const count = store.entries.filter((e) => e.ts >= range.from && e.ts < range.to).length;
        if (!count) return print(`no entries (${range.label})`, 'err');
        const body = csv ? T.toCSV(store.entries, range, now) : T.formatReport(store.entries, range, now) + '\n';
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
        const text = T.formatReport(store.entries, range, Date.now());
        if (!navigator.clipboard) return print('clipboard not available here; use /export', 'err');
        navigator.clipboard.writeText(text).then(
          () => print(`copied ${range.label} to clipboard`, 'ok'),
          () => print('could not copy; use /export', 'err'),
        );
      },
    },
    login: {
      usage: '/login <email>',
      about: 'sign in to sync across devices (emails you a link and code)',
      async run(args) {
        const email = (args[0] || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return print('usage: /login you@example.com', 'err');
        if (store.user) return print(`already signed in as ${store.user.email}; /logout first`, 'err');
        await store.login(email);
        pendingEmail = email;
        print(`sent a sign-in email to ${email}. Open the link, or type /code <code from the email>`, 'ok');
      },
    },
    code: {
      usage: '/code <code>',
      about: 'finish signing in with the code from the email',
      async run(args) {
        const code = (args[0] || '').trim();
        if (!pendingEmail) return print('run /login <email> first', 'err');
        if (!/^\d{6,10}$/.test(code)) return print('usage: /code 123456', 'err');
        await store.verify(pendingEmail, code);
        pendingEmail = '';
      },
    },
    logout: {
      usage: '/logout',
      about: 'sign out and remove your synced log from this browser',
      async run(args) {
        if (!store.user) return print('not signed in', 'err');
        if (store.pending && args[0] !== 'force') {
          return print(`${store.pending} change(s) have not synced yet. Try /sync, or /logout force to discard them.`, 'err');
        }
        const email = store.user.email;
        await store.logout();
        print(`signed out of ${email}`, 'ok');
      },
    },
    whoami: {
      usage: '/whoami',
      about: 'show the account and sync state',
      run() {
        if (!store.configured) return print('local only: entries are kept in this browser (sync not configured)', 'dim');
        if (!store.user) return print('signed out: entries are kept in this browser. /login <email> to sync', 'dim');
        const state = store.pending ? `${store.pending} change(s) waiting to sync` : 'all changes synced';
        const err = store.lastError ? `\nlast error: ${store.lastError}` : '';
        print(`${store.user.email} · ${store.entries.length} entries · ${state}${err}`, 'dim');
      },
    },
    sync: {
      usage: '/sync',
      about: 'send and fetch changes now',
      async run() {
        if (!store.user) return print('not signed in; /login <email> to sync', 'err');
        await store.sync();
        if (store.status === 'synced') print(`synced · ${store.entries.length} entries`, 'ok');
        else print(`sync failed: ${store.lastError || store.status}`, 'err');
      },
    },
    import: {
      usage: '/import',
      about: 'add entries logged while signed out to your account',
      run() {
        const n = store.importLocal();
        print(n ? `imported ${n} entr${n === 1 ? 'y' : 'ies'}` : 'nothing to import', 'ok');
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
  let pendingEmail = '';

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
    try {
      const result = cmd.run(args);
      if (result && result.then) {
        result.catch((err) => print(err.message || String(err), 'err')).then(scrollToPrompt);
      }
    } catch (err) {
      print(err.message || String(err), 'err');
    }
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
    return text.startsWith('/') ? COMMAND_WORDS : T.knownCategories(store.entries);
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

  const history = [];
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

  const SYNC_LABELS = {
    'local-only': 'local',
    'signed-out': 'local · /login to sync',
    syncing: 'syncing…',
    synced: 'synced',
    pending: 'waiting to sync',
    offline: 'offline',
    error: 'not synced · /whoami',
  };

  function syncLabel() {
    const label = SYNC_LABELS[store.status] || store.status;
    return store.user && store.pending && store.status !== 'synced' ? `${label} (${store.pending})` : label;
  }

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function renderStatus() {
    const now = Date.now();
    const left = span('now', '');
    if (!store.entries.length) {
      left.textContent = 'not clocked in · type /help';
    } else {
      const spans = T.withSpans(store.entries, now);
      const cur = spans[spans.length - 1];
      // Same rule as the report: an entry counts toward the day it started on.
      const today = T.startOfDay(now);
      const todayMs = spans.reduce((sum, s) => sum + (s.ts >= today ? s.duration : 0), 0);
      left.append(
        span('run', `▶ ${T.formatClock(cur.duration)}`),
        `  ${describe(cur)}`,
        span('dim', `   today ${T.formatHM(todayMs)} · since ${T.hhmm(cur.ts)}`),
      );
    }
    const right = span('sync sync-' + store.status, syncLabel());
    statusEl.replaceChildren(left, right);
  }

  // ---- boot ----------------------------------------------------------------

  print('tymlee · type what you are starting and press Enter · /help for commands', 'dim');
  renderStatus();
  renderHints();
  setInterval(renderStatus, 1000);
  store.init().catch((err) => print(`startup error: ${err.message || err}`, 'err')).then(() => {
    history.push(...store.entries.slice(-100).map((e) => e.text));
    histIdx = history.length;
    if (store.entries.length) {
      print(T.formatReport(store.entries, T.parseRange('today', Date.now()), Date.now()), 'report');
    }
    renderStatus();
    scrollToPrompt();
  });
})();
