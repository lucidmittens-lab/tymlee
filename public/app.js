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
    onChange: () => { renderStatus(); refreshTimelines(); },
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
    // In the GUI view short messages flash above the prompt; bigger output
    // (reports, help, keys) switches back to the CLI view to show it.
    if (view === 'gui' && cls !== 'echo') {
      if (/\b(report|key)\b/.test(cls || '')) setView('cli');
      else flash(text, cls);
    }
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
        '        Ctrl/Cmd+G    switch between the CLI and GUI (timeline) views',
      ],
      linkSignIn: true,
      showTimeline,
      pickEntry,
      ask,
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

  // ---- views: CLI (the scrollback) and GUI (a live timeline) -----------------
  // Switched with the CLI | GUI toggle in the status bar, Ctrl/Cmd+G, or
  // /timeline [range]. The prompt works the same in both.

  const guiEl = $('gui');
  const flashEl = $('flash');
  const VIEW_KEY = 'tymlee.view';
  const PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Week'], ['month', 'Month']];
  let view = 'cli';
  let guiPreset = 'today'; // one of PRESETS, or null for guiRange
  let guiRange = null;
  let guiTimeline = null;

  function guiRangeNow() {
    return guiPreset ? T.parseRange(guiPreset, Date.now()) : guiRange;
  }

  function renderGui() {
    const bar = document.createElement('div');
    bar.className = 'gui-bar';
    for (const [key, label] of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(guiPreset === key));
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the prompt
      b.addEventListener('click', () => {
        guiPreset = key;
        renderGui();
        scrollToNow();
      });
      bar.append(b);
    }
    if (!guiPreset && guiRange) {
      const custom = document.createElement('span');
      custom.className = 'gui-range';
      custom.textContent = guiRange.label;
      bar.append(custom);
    }
    guiTimeline = window.TymleeTimeline.render({ store, range: guiRangeNow(), onSelect: showDetails });
    guiEl.replaceChildren(bar, guiTimeline.el);
  }

  function showDetails(b) {
    const end = b.running ? 'now' : T.hhmm(b.start + b.duration);
    const lines = [`#${b.n} ${b.wo ? `${T.woTag(b.wo)} ` : ''}${T.hhmm(b.start)}–${end}  ${T.formatHM(b.duration)}  ${b.category}${b.note ? ` ${b.note}` : ''}`];
    if (b.notes) lines.push(...b.notes.split('\n').map((l) => `  > ${l}`));
    print(lines.join('\n'), 'dim');
  }

  // Show the top of the GUI (range buttons and legend), scrolling down only
  // as far as needed to bring the "now" line into view.
  function scrollToNow() {
    scrollEl.scrollTop = 0;
    const now = guiEl.querySelector('.tl-now');
    if (!now) return;
    const t = now.getBoundingClientRect();
    const box = scrollEl.getBoundingClientRect();
    const below = t.bottom - (box.top + box.height * 0.8);
    if (below > 0) scrollEl.scrollTop = below;
  }

  function setView(next, { save = true } = {}) {
    view = next;
    guiEl.hidden = view !== 'gui';
    out.hidden = view === 'gui';
    if (save) {
      try { localStorage.setItem(VIEW_KEY, view); } catch (_) { /* a per-browser convenience */ }
    }
    if (view === 'gui') {
      renderGui();
      scrollEl.scrollTop = 0;
      scrollToNow();
    } else {
      guiTimeline = null;
      guiEl.replaceChildren();
      flash('');
      scrollToPrompt();
    }
    renderStatus();
  }

  // /timeline [range]: open the GUI view on that range.
  function showTimeline(range) {
    const preset = PRESETS.find(([key]) => key === range.label);
    guiPreset = preset ? preset[0] : null;
    guiRange = range;
    setView('gui');
  }

  let flashTimer = null;
  function flash(text, cls) {
    clearTimeout(flashTimer);
    flashEl.className = cls || '';
    flashEl.textContent = String(text).split('\n').slice(0, 3).join('\n');
    if (text) flashTimer = setTimeout(() => { flashEl.textContent = ''; }, 8000);
  }

  let refreshQueued = false;
  function refreshTimelines() {
    if (refreshQueued || !guiTimeline) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      if (guiTimeline && view === 'gui') guiTimeline.refresh();
    }, 250);
  }
  setInterval(refreshTimelines, 30000);

  function viewToggle() {
    const wrap = span('view-toggle', '');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'View');
    for (const v of ['cli', 'gui']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = v.toUpperCase();
      b.setAttribute('aria-pressed', String(view === v));
      b.title = v === 'gui' ? 'Timeline view (Ctrl/Cmd+G)' : 'Command view (Ctrl/Cmd+G)';
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the prompt
      b.addEventListener('click', () => { if (view !== v) setView(v); });
      wrap.append(b);
    }
    return wrap;
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
    if (view === 'gui') setView('cli'); // /edit and /restore need the text view
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

  // ---- input: /note's entry picker and notes prompt --------------------------
  // Both take over the prompt line until Enter (or Esc to cancel).

  let modal = null; // { kind: 'pick', choices, idx, resolve } or { kind: 'ask', label, multiline, resolve }

  // Line breaks in notes are shown as ↵ on the one-line prompt.
  const BREAK = '↵';

  function pickEntry(choices) {
    return new Promise((resolve) => {
      modal = { kind: 'pick', choices, idx: 0, resolve };
      input.value = '';
      input.placeholder = 'Tab: older · Shift+Tab: newer · Enter: select · Esc: cancel';
      renderHints();
      input.focus();
    });
  }

  function ask(label, initial, name) {
    return new Promise((resolve) => {
      const multiline = name === 'notes';
      modal = { kind: 'ask', label, multiline, resolve };
      input.value = (initial || '').split('\n').join(BREAK);
      input.placeholder = multiline ? 'type notes · Shift+Enter: new line · Enter: save · Esc: cancel' : 'Enter: save · Esc: cancel';
      renderHints();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  function endModal(value) {
    const m = modal;
    modal = null;
    input.value = '';
    input.placeholder = '';
    renderHints();
    m.resolve(value);
  }

  function movePick(step) {
    modal.idx = Math.min(modal.choices.length - 1, Math.max(0, modal.idx + step));
    renderHints();
  }

  function hintButton(text, cls, onPress) {
    const b = document.createElement('span');
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the input
      onPress();
    });
    return b;
  }

  function renderModal() {
    ghost.replaceChildren();
    if (modal.kind === 'pick') {
      const { choices, idx } = modal;
      matchesEl.replaceChildren(
        hintButton('‹ older', 'btn', () => movePick(1)),
        hintButton(`${choices[idx].label}  (${idx + 1}/${choices.length})`, 'sel', () => form.requestSubmit()),
        hintButton('newer ›', 'btn', () => movePick(-1)),
        hintButton('select', 'btn', () => form.requestSubmit()),
        hintButton('cancel', 'btn', () => endModal(null)),
      );
    } else {
      matchesEl.replaceChildren(
        hintButton(modal.label, 'sel', () => {}),
        hintButton('save', 'btn', () => form.requestSubmit()),
        hintButton('cancel', 'btn', () => endModal(null)),
      );
    }
  }

  function renderHints() {
    if (modal) return renderModal();
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
    if (modal) {
      const older = (e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowUp';
      const newer = (e.key === 'Tab' && e.shiftKey) || e.key === 'ArrowDown';
      if (e.key === 'Escape') {
        e.preventDefault();
        endModal(null);
      } else if (modal.kind === 'ask' && modal.multiline && e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        input.setRangeText(BREAK, input.selectionStart, input.selectionEnd, 'end');
      } else if (modal.kind === 'pick' && (older || newer)) {
        e.preventDefault();
        movePick(older ? 1 : -1);
      } else if (modal.kind === 'pick' && e.key !== 'Enter') {
        e.preventDefault(); // choosing, not typing
      } else if (e.key === 'Tab') {
        e.preventDefault();
      }
      return;
    }
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
    } else if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      setView(view === 'gui' ? 'cli' : 'gui');
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
    if (modal) {
      if (modal.kind === 'pick') {
        const choice = modal.choices[modal.idx];
        echo(choice.label);
        endModal(choice);
      } else {
        const value = input.value.split(BREAK).join('\n');
        echo(value || '(nothing)');
        endModal(value);
      }
      scrollToPrompt();
      return;
    }
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
    statusEl.replaceChildren(...[left, today, right, viewToggle()].filter(Boolean));
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
    // Reopen the view used last (after printing today's log into the scrollback).
    let saved = 'cli';
    try { saved = localStorage.getItem(VIEW_KEY) || 'cli'; } catch (_) { /* default view */ }
    if (saved === 'gui') setView('gui', { save: false });
  });
})();
