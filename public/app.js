(function () {
  'use strict';

  const T = window.Tymlee;
  const V = window.TymleeVault;

  const $ = (id) => document.getElementById(id);
  const appEl = $('app');
  const scrollEl = $('scroll');
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
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function nearBottom() {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 40;
  }

  // Keep the app sized to the visible area. On phones the on-screen keyboard
  // shrinks that area; resizing (rather than letting the keyboard cover the
  // page) keeps the prompt and status bar just above it.
  const viewport = window.visualViewport;
  function fitToViewport() {
    const stick = nearBottom();
    const height = viewport ? viewport.height : window.innerHeight;
    appEl.style.height = `${height}px`;
    // iOS may scroll the page to reveal the input; follow the visible area.
    appEl.style.transform = viewport && viewport.offsetTop ? `translateY(${viewport.offsetTop}px)` : '';
    document.documentElement.classList.toggle('kb', window.innerHeight - height > 120);
    if (stick) scrollToPrompt();
  }
  if (viewport) {
    viewport.addEventListener('resize', fitToViewport);
    viewport.addEventListener('scroll', fitToViewport);
  }
  window.addEventListener('resize', fitToViewport);
  // iOS scrolls the whole page when focusing an input; undo that.
  window.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });

  // ---- entries -------------------------------------------------------------

  // Narrow screens get the compact report; exports always use the full one.
  const narrow = window.matchMedia('(max-width: 600px)');
  function screenFormat() {
    return { compact: narrow.matches };
  }

  function describe(s) {
    if (s.off) return 'off';
    return s.note ? `${s.category} ${s.note}` : s.category;
  }

  function add(text) {
    if (text.length > T.MAX_TEXT) return print(`entries are limited to ${T.MAX_TEXT} characters`, 'err');
    const { category, note } = T.parseInput(text);
    const before = store.entries;
    const entry = store.add(note ? `${category} ${note}` : category);
    const prev = before.length ? T.withSpans(before, entry.ts).pop() : null;
    const parts = [T.hhmm(entry.ts)];
    if (prev && !prev.off) parts.push(`out ${prev.category} (${T.formatHM(prev.duration)})`);
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
          '        Ctrl+Enter    save (while editing)',
        ].join('\n'), 'report dim');
      },
    },
    log: {
      usage: '/log [range]',
      about: 'print the log for a range',
      run(args) {
        const range = rangeFrom(args);
        if (range) print(T.formatReport(store.entries, range, Date.now(), screenFormat()), 'report');
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
        const cur = T.withSpans(store.entries, now).pop();
        if (cur) msg.push(cur.off ? 'still off' : `resumed ${describe(cur)}`);
        print(msg.join('  '), 'ok');
      },
    },
    off: {
      usage: '/off',
      about: 'clock out without starting anything new',
      run() {
        const before = T.withSpans(store.entries, Date.now());
        const cur = before[before.length - 1];
        if (!cur || cur.off) return print('not clocked in', 'err');
        const entry = store.add(T.OFF);
        print(`${T.hhmm(entry.ts)}  out ${cur.category} (${T.formatHM(entry.ts - cur.ts)})  off`, 'ok');
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
      about: 'sign in to sync across devices (emails you a link and a code)',
      async run(args) {
        const email = (args[0] || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return print('usage: /login you@example.com', 'err');
        if (store.user) return print(`already signed in as ${store.user.email}; /logout first`, 'err');
        await store.login(email);
        rememberLoginEmail(email);
        print(`sent a sign-in email to ${email}. Type /code <code from the email>, or open the link in it on this device.`, 'ok');
      },
    },
    code: {
      usage: '/code <code>',
      about: 'finish signing in with the code from the email',
      async run(args) {
        const code = (args[0] || '').trim();
        const email = loginEmail();
        if (store.user) return print(`already signed in as ${store.user.email}`, 'err');
        if (!email) return print('run /login <email> first', 'err');
        if (!/^\d{6,10}$/.test(code)) return print('usage: /code 123456  (the number from the sign-in email)', 'err');
        await store.verify(email, code);
        rememberLoginEmail('');
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
    encrypt: {
      usage: '/encrypt',
      about: 'turn on end-to-end encryption for your account',
      async run() {
        print('setting up encryption…', 'dim');
        await store.enableEncryption();
      },
    },
    link: {
      usage: '/link [code]',
      about: 'add a device: /link here shows a code; type /link <code> on the new one',
      async run(args) {
        const code = args.join('');
        if (!code) {
          const shown = await store.createLink();
          print([
            'On your other device, sign in, then type:',
            '',
            `  /link ${shown}`,
            '',
            'The code works once, for 10 minutes, and only for someone signed in to your account.',
          ].join('\n'), 'key');
          return;
        }
        if (!V.looksLikeCode(code, 12)) return print('usage: /link XXXX-XXXX-XXXX  (the code shown by /link on your other device)', 'err');
        print('checking the code…', 'dim');
        await store.unlockWith('link', code);
        print('this device is set up: entries are decrypted here and encrypted on upload', 'ok');
      },
    },
    recover: {
      usage: '/recover <key>',
      about: 'set up this device with your recovery key',
      async run(args) {
        const code = args.join('');
        if (!V.looksLikeCode(code, 20)) return print('usage: /recover XXXXX-XXXXX-XXXXX-XXXXX  (your recovery key)', 'err');
        print('checking the recovery key…', 'dim');
        await store.unlockWith('recovery', code);
        print('this device is set up: entries are decrypted here and encrypted on upload', 'ok');
      },
    },
    recovery: {
      usage: '/recovery',
      about: 'make a new recovery key (the old one stops working)',
      async run() {
        print(await store.newRecoveryKey(), 'key');
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
        const crypt = {
          ready: 'encrypted: this device has the key',
          locked: "encrypted: this device doesn't have the key yet (/link or /recover)",
          plain: 'not encrypted: the server is not set up for it yet',
          none: 'not encrypted: type /encrypt to turn it on',
          pending: 'encryption: checking…',
        }[store.encryption] || '';
        print(`${store.user.email} · ${store.entries.length} entries · ${state}\n${crypt}${err}`, 'dim');
      },
    },
    sync: {
      usage: '/sync',
      about: 'send and fetch changes now',
      async run() {
        if (!store.user) return print('not signed in; /login <email> to sync', 'err');
        await store.sync({ full: true });
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
    edit: {
      usage: '/edit [range]',
      about: 'edit entries as text (default: the last 24 hours)',
      run(args) {
        if (editor) return print('already editing; /save or /cancel first', 'err');
        const now = Date.now();
        const range = args.length ? rangeFrom(args) : { from: now - 86400000, to: Infinity, label: 'last 24 hours' };
        if (range) openEditor(range);
      },
    },
    restore: {
      usage: '/restore [file]',
      about: 'add entries from a backup: paste it, or pick a .txt/.csv file',
      run(args) {
        if (editor) return print('already editing; /save or /cancel first', 'err');
        if (args[0] && args[0].toLowerCase() !== 'file') return print('usage: /restore  or  /restore file', 'err');
        if (args[0]) chooseBackupFile();
        else openRestore('');
      },
    },
    save: {
      usage: '/save',
      about: 'apply /edit changes or add /restore entries (Ctrl+Enter)',
      run() {
        if (!editor) return print('nothing to save; start with /edit or /restore', 'err');
        if (editor.mode === 'restore') return saveRestore();
        const result = T.parseEditable(editor.el.value, editor.items, Date.now());
        if (result.errors.length) {
          print([...result.errors, 'nothing was saved; fix the lines above and /save again'].join('\n'), 'err');
          return;
        }
        store.apply(result.ops);
        closeEditor();
        const parts = [];
        if (result.changed) parts.push(`${result.changed} changed`);
        if (result.added) parts.push(`${result.added} added`);
        if (result.removed) parts.push(`${result.removed} removed`);
        print(parts.length ? `saved: ${parts.join(', ')}` : 'no changes', 'ok');
      },
    },
    cancel: {
      usage: '/cancel',
      about: 'close /edit or /restore without changing anything',
      run() {
        if (!editor) return print('nothing to cancel', 'err');
        const what = editor.mode === 'restore' ? 'restore' : 'edit';
        closeEditor();
        print(`${what} cancelled; nothing was changed`, 'ok');
      },
    },
    clear: {
      usage: '/clear',
      about: 'clear the screen (the log is kept)',
      run() { clearScreen(); },
    },
  };
  const ALIASES = { ls: 'log', h: 'help', '?': 'help', z: 'undo' };
  const COMMAND_WORDS = Object.keys(COMMANDS).map((c) => '/' + c);

  // The address used with /login, kept so /code still works if the page
  // reloads while you fetch the code (phones often reload background tabs).
  // It expires with the emailed code (an hour).
  const LOGIN_EMAIL_KEY = 'tymlee.loginEmail';
  const LOGIN_CODE_TTL_MS = 60 * 60 * 1000;
  function rememberLoginEmail(email) {
    try {
      if (email) localStorage.setItem(LOGIN_EMAIL_KEY, JSON.stringify({ email, at: Date.now() }));
      else localStorage.removeItem(LOGIN_EMAIL_KEY);
    } catch (_) { /* storage unavailable; /code needs /login in this page */ }
  }
  function loginEmail() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOGIN_EMAIL_KEY));
      return saved && Date.now() - saved.at < LOGIN_CODE_TTL_MS ? saved.email : '';
    } catch (_) {
      return '';
    }
  }

  // Clean up what was typed or pasted: text copied from an email can carry
  // invisible characters, and some keyboards produce a full-width slash.
  function cleanLine(raw) {
    return raw.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').replace(/\uFF0F/g, '/').trim();
  }

  // Sign-in codes must never be logged as entries. Catch the ways a code
  // arrives without a clean "/code" in front: the keyboard's one-time-code
  // suggestion (just the digits), "code 123456", or a whole pasted email line.
  function asCodeCommand(line) {
    if (line.startsWith('/')) return null;
    const pasted = line.match(/(?:^|\s)\/code\s+(\d{6,10})(?:\s|$)/i);
    if (pasted) return `/code ${pasted[1]}`;
    if (store.user || !loginEmail()) return null;
    const bare = line.match(/^(?:code\s*:?\s*)?(\d{6,10})$/i);
    return bare ? `/code ${bare[1]}` : null;
  }

  function saveRestore() {
    const { entries, errors } = T.parseBackup(editor.el.value);
    if (errors.length) {
      const shown = errors.slice(0, 10);
      if (errors.length > shown.length) shown.push(`…and ${errors.length - shown.length} more`);
      print([...shown, 'nothing was added; fix the lines above and /save again'].join('\n'), 'err');
      return;
    }
    if (!entries.length) return print('no entries found in the text; paste a backup, or /cancel', 'err');
    const fresh = T.mergeBackup(store.entries, entries);
    store.apply(fresh.map((entry) => ({ op: 'put', entry })));
    closeEditor();
    const skipped = entries.length - fresh.length;
    const msg = `restored ${fresh.length} entr${fresh.length === 1 ? 'y' : 'ies'}`;
    print(skipped ? `${msg} (${skipped} already in your log)` : msg, 'ok');
  }

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

  function clearScreen() {
    out.replaceChildren();
    if (editor) out.append(editor.el); // keep an open editor
  }

  // ---- editor (/edit) ------------------------------------------------------

  // The open text box: its textarea, what it is for ('edit' or 'restore'),
  // and for /edit the entries it was opened with.
  let editor = null;

  function fitEditor(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }

  function openEditor(range) {
    const { text, items } = T.formatEditable(store.entries, range, Date.now());
    print(`editing ${range.label} (${items.length} entr${items.length === 1 ? 'y' : 'ies'}) · /save to apply, /cancel to discard`, 'dim');
    openTextBox({ text, items, mode: 'edit', label: `Edit entries (${range.label})`, cursorAtEnd: true });
  }

  const RESTORE_HELP = [
    '# paste a backup below',
    '# (.txt or .csv from /export)',
    '# duplicates are skipped',
    '',
  ].join('\n');

  function openRestore(text) {
    print('restoring from a backup · /save to add the entries, /cancel to discard', 'dim');
    openTextBox({ text: RESTORE_HELP + (text || ''), mode: 'restore', label: 'Backup to restore', cursorAtEnd: true });
  }

  // Let the user pick a backup file, then show its contents for review.
  function chooseBackupFile() {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.txt,.csv,text/plain,text/csv';
    picker.hidden = true;
    picker.addEventListener('change', () => {
      const file = picker.files && picker.files[0];
      picker.remove();
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return print(`${file.name} is too large to be a tymlee backup`, 'err');
      file.text().then(
        (text) => { if (!editor) { openRestore(text); scrollToPrompt(); } },
        () => print(`could not read ${file.name}`, 'err'),
      );
    });
    document.body.append(picker);
    picker.click();
  }

  function openTextBox({ text, items, mode, label, cursorAtEnd }) {
    const el = document.createElement('textarea');
    el.className = 'editor';
    el.value = text;
    el.spellcheck = false;
    el.wrap = 'off';
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('aria-label', label);
    el.addEventListener('input', () => fitEditor(el));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit('/save');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.focus();
      }
    });
    out.append(el);
    editor = { el, items, mode };
    fitEditor(el);
    input.placeholder = `${mode === 'restore' ? 'restoring' : 'editing'} · /save or /cancel`;
    el.focus();
    if (cursorAtEnd) el.setSelectionRange(el.value.length, el.value.length);
  }

  // Leave the edited text on screen as a read-only record.
  function closeEditor() {
    if (editor.mode === 'restore') {
      editor.el.remove();
    } else {
      const pre = document.createElement('pre');
      pre.className = 'report dim';
      pre.textContent = editor.el.value.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').trimEnd();
      editor.el.replaceWith(pre);
    }
    editor = null;
    input.placeholder = '';
    input.focus();
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
      clearScreen();
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
    const typed = cleanLine(input.value);
    const line = asCodeCommand(typed) || typed;
    input.value = '';
    cycle = null;
    renderHints();
    if (line) submit(line);
  });

  // Clicking the scrollback focuses the prompt, unless selecting text. Not on
  // touch screens, where a tap to scroll would pop up the keyboard.
  const finePointer = window.matchMedia('(pointer: fine)');
  scrollEl.addEventListener('click', (e) => {
    if (e.target.closest('.editor')) return;
    if (finePointer.matches && !String(window.getSelection())) input.focus();
  });
  $('dock').addEventListener('click', (e) => {
    if (e.target !== input && !e.target.closest('#matches span')) input.focus();
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
    locked: 'locked · /link',
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
    let today = null;
    if (!store.entries.length) {
      left.append(span('what', 'not clocked in · type /help'));
    } else {
      const spans = T.withSpans(store.entries, now);
      const cur = spans[spans.length - 1];
      // Same rule as the report: an entry counts toward the day it started on.
      const dayStart = T.startOfDay(now);
      const todayMs = spans.reduce((sum, s) => sum + (s.ts >= dayStart && !s.off ? s.duration : 0), 0);
      if (cur.off) {
        left.append(span('stopped', '■ off'), span('what dim', `  since ${T.hhmm(cur.ts)}`));
        today = span('today', `today ${T.formatHM(todayMs)}`);
      } else {
        left.append(span('run', `▶ ${T.formatClock(cur.duration)}`), span('what', `  ${describe(cur)}`));
        today = span('today', `today ${T.formatHM(todayMs)}`);
        today.append(span('since', ` · since ${T.hhmm(cur.ts)}`));
      }
    }
    const right = span('sync sync-' + store.status, syncLabel());
    statusEl.replaceChildren(...[left, today, right].filter(Boolean));
  }

  // ---- boot ----------------------------------------------------------------

  print('tymlee · type what you are starting and press Enter · /help for commands', 'dim');
  fitToViewport();
  renderStatus();
  renderHints();
  setInterval(renderStatus, 1000);
  store.init().catch((err) => print(`startup error: ${err.message || err}`, 'err')).then(() => {
    history.push(...store.entries.slice(-100).map((e) => e.text));
    histIdx = history.length;
    if (store.entries.length) {
      print(T.formatReport(store.entries, T.parseRange('today', Date.now()), Date.now(), screenFormat()), 'report');
    }
    renderStatus();
    scrollToPrompt();
  });
})();
