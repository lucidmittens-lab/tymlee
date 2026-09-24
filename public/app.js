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

  // Narrow screens get the compact report; exports always use the full one.
  const narrow = window.matchMedia('(max-width: 600px)');

  // ---- the shared command shell (commands.js) ---------------------------------

  const shell = window.TymleeShell.createShell({
    store,
    T,
    V,
    io: {
      print,
      storage: window.localStorage,
      place: 'this browser',
      compact: () => narrow.matches,
      async save(name, body, type) {
        download(name, body, type);
        return name;
      },
      async copy(text) {
        if (!navigator.clipboard) throw new Error('clipboard not available here');
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          throw new Error('could not copy');
        }
      },
      clear: clearScreen,
      pickFile(args) {
        if (args[0].toLowerCase() !== 'file' || args.length > 1) {
          print('usage: /restore  or  /restore file', 'err');
          return Promise.resolve(null);
        }
        return chooseBackupFile();
      },
      restoreUsage: '/restore [file]',
      keys: [
        'Keys:   Tab / Right   complete category (Tab again to cycle)',
        '        Up / Down     previous inputs',
        '        Ctrl+Z        undo (on an empty line)',
        '        Ctrl+L        clear the screen',
        '        Ctrl+Enter    save (while editing)',
      ],
      linkSignIn: true,
      editor: {
        open: openTextBox,
        isOpen: () => Boolean(editor),
        mode: () => editor && editor.mode,
        value: () => editor && editor.el.value,
        items: () => editor && editor.items,
        close: closeEditor,
      },
    },
  });

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

  // Let the user pick a backup file; resolves with its text.
  function chooseBackupFile() {
    return new Promise((resolve) => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.txt,.csv,text/plain,text/csv';
      picker.hidden = true;
      picker.addEventListener('change', () => {
        const file = picker.files && picker.files[0];
        picker.remove();
        if (!file) return resolve(null);
        if (file.size > 5 * 1024 * 1024) {
          print(`${file.name} is too large to be a tymlee backup`, 'err');
          return resolve(null);
        }
        file.text().then(resolve, () => {
          print(`could not read ${file.name}`, 'err');
          resolve(null);
        });
      });
      document.body.append(picker);
      picker.click();
    });
  }

  function openTextBox({ text, items, mode, label }) {
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
    el.setSelectionRange(el.value.length, el.value.length);
    scrollToPrompt();
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
      list = shell.completions(typed);
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
      const matches = shell.completions(typed, { includeExact: true, limit: 20 });
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
      complete(shell.completions(input.value)[0]);
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
    const done = shell.run(line);
    if (history[history.length - 1] !== line) history.push(line);
    histIdx = history.length;
    draft = '';
    renderStatus();
    scrollToPrompt();
    done.then(() => {
      renderStatus();
      scrollToPrompt();
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const line = shell.route(input.value);
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

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function renderStatus() {
    const st = shell.status(Date.now());
    const left = span('now', '');
    let today = null;
    if (st.state === 'idle') {
      left.append(span('what', st.text));
    } else if (st.state === 'off') {
      left.append(span('stopped', '■ off'), span('what dim', `  since ${st.since}`));
      today = span('today', st.today);
    } else {
      left.append(span('run', `▶ ${st.clock}`), span('what', `  ${st.what}`));
      today = span('today', st.today);
      today.append(span('since', ` · since ${st.since}`));
    }
    const right = span('sync sync-' + st.sync.status, st.sync.label);
    statusEl.replaceChildren(...[left, today, right].filter(Boolean));
  }

  // ---- boot ----------------------------------------------------------------

  print('tymlee · type what you are starting and press Enter · /help for commands', 'dim');
  fitToViewport();
  renderStatus();
  renderHints();
  setInterval(renderStatus, 1000);
  store.init().catch((err) => print(`startup error: ${err.message || err}`, 'err')).then(() => {
    history.push(...shell.recentTexts(100));
    histIdx = history.length;
    if (store.entries.length) {
      print(T.formatReport(store.entries, T.parseRange('today', Date.now()), Date.now(), { compact: narrow.matches }), 'report');
    }
    renderStatus();
    scrollToPrompt();
  });
})();
