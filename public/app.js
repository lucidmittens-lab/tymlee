(function () {
  'use strict';

  const T = window.Tymlee;
  const V = window.TymleeVault;

  const $ = (id) => document.getElementById(id);
  const appEl = $('app');
  const scrollEl = $('scroll');
  const out = $('out');
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
    if (e.key === store.storageKey() || e.key === store.settingsKey()) store.reloadFromStorage();
  });

  // iOS zooms the page in when an input with text under 16px gets the focus.
  // Turn that off there (people can still pinch to zoom on iOS); other
  // browsers keep the default so pinch zoom is never blocked.
  if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && !/maximum-scale/.test(meta.content)) meta.content += ', maximum-scale=1';
  }

  // ---- output --------------------------------------------------------------

  function print(text, cls) {
    const pre = document.createElement('pre');
    if (cls) pre.className = cls;
    if (/\breport\b/.test(cls || '')) appendLines(pre, text);
    else pre.textContent = text;
    out.append(pre);
    // In the GUI view, bigger output (reports, help, keys) opens the console
    // tray up to show it, instead of taking the timeline's place.
    pinned = /\b(report|key)\b/.test(cls || '') ? pre : null;
    if (view === 'gui' && pinned) showInTray();
    if (view === 'gui') scrollToPrompt();
    return pre;
  }

  // Reports are columns of text. On a narrow screen their lines wrap rather
  // than scroll sideways, and a wrapped line continues under its last column
  // (the entry's text, say) so the columns stay readable.
  function charsPerLine() {
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(20);
    probe.style.visibility = 'hidden';
    out.append(probe);
    const width = probe.getBoundingClientRect().width / 20;
    probe.remove();
    return width ? Math.floor((out.clientWidth - 32) / width) : 80;
  }

  function appendLines(pre, text) {
    const maxHang = Math.max(4, Math.floor(charsPerLine() / 2)); // at most halfway across
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const row = document.createElement('span');
      row.className = 'ln';
      // Keep the line breaks in the text, for copying.
      row.textContent = `${line}${i < lines.length - 1 ? '\n' : ''}` || ' ';
      const lead = line.length - line.trimStart().length;
      let hang = lead + 2;
      const gaps = [...line.matchAll(/\S( {2,})(?=\S)/g)];
      if (gaps.length) {
        const last = gaps[gaps.length - 1];
        hang = last.index + 1 + last[1].length;
      }
      row.style.setProperty('--hang', `${Math.min(hang, maxHang)}ch`);
      pre.append(row);
    });
  }

  function echo(text) {
    const pre = print('', 'echo');
    const b = document.createElement('b');
    b.textContent = text;
    pre.append('> ', b);
  }

  // Like a terminal, jump to the bottom after every command.
  // The last report printed, while it is the last thing in the console: the
  // GUI view's tray shows it from its top (with the command that made it).
  let pinned = null;

  function pinnedTop() {
    if (!pinned || out.lastElementChild !== pinned) return null;
    const before = pinned.previousElementSibling;
    return before && before.classList.contains('echo') ? before : pinned;
  }

  function scrollToPrompt() {
    // In the GUI view the console is its own pane under the timeline.
    if (view !== 'gui') {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      return;
    }
    const top = pinnedTop();
    out.scrollTop = top ? top.offsetTop - 4 : out.scrollHeight;
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
    if (view === 'gui') applyConsole();
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
      // Opened from the Home Screen, the emailed link would sign in the
      // browser instead of this app, so only the code is offered.
      linkSignIn: !(window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches),
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
  // The view picked with the CLI | GUI switch (Ctrl/Cmd+G). A new key: the
  // old one also saved switches made by commands, so it starts over at GUI.
  const VIEW_KEY = 'tymlee.view2';
  let view = 'cli';
  // What the GUI shows: a day, a (Monday to Sunday) week or a calendar month,
  // `back` of them before the current one; or, with unit null, `guiRange`
  // (from /timeline <range>).
  const UNITS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
  let guiUnit = 'day';
  let guiBack = 0;
  let guiRange = null;
  let guiTimeline = null;

  const DAY_MS = 86400000;
  const isOneDay = (r) => r && r.to - r.from <= DAY_MS + 3600000 && r.to - r.from >= DAY_MS - 3600000; // DST days

  function unitRange(unit, back, now) {
    const today = T.startOfDay(now);
    if (unit === 'day') {
      const from = T.addDays(today, -back);
      return { from, to: T.addDays(from, 1), label: T.ymd(from) };
    }
    if (unit === 'week') {
      const monday = T.addDays(today, -((new Date(today).getDay() + 6) % 7));
      const from = T.addDays(monday, -7 * back);
      return { from, to: T.addDays(from, 7), label: `week of ${T.ymd(from)}` };
    }
    const d = new Date(today);
    const from = new Date(d.getFullYear(), d.getMonth() - back, 1).getTime();
    const to = new Date(d.getFullYear(), d.getMonth() - back + 1, 1).getTime();
    return { from, to, label: T.ymd(from).slice(0, 7) };
  }

  function guiRangeNow() {
    return guiUnit ? unitRange(guiUnit, guiBack, Date.now()) : guiRange;
  }

  // Step a day, week or month forward (+1) or back (-1), not past now.
  function step(delta) {
    if (!guiUnit || guiBack - delta < 0) return false;
    guiBack -= delta;
    renderGui(delta > 0 ? 'next' : 'prev');
    scrollToNow();
    return true;
  }

  function showUnit(unit, back = 0) {
    guiUnit = unit;
    guiBack = back;
    renderGui();
    scrollToNow();
  }

  // Days between today and `ts` (a day's start).
  const daysBack = (ts) => Math.round((T.startOfDay(Date.now()) - T.startOfDay(ts)) / DAY_MS);

  function guiButton(label, onClick, { pressed, title, cls } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    if (typeof label === 'string') b.textContent = label;
    else b.append(...label);
    if (cls) b.className = cls;
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    if (pressed != null) b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the prompt
    b.addEventListener('click', onClick);
    return b;
  }

  function span2(cls, text) {
    const e = document.createElement('span');
    e.className = cls;
    e.textContent = text;
    return e;
  }

  function periodLabel(range) {
    const from = new Date(range.from);
    if (guiUnit === 'day') return from.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (guiUnit === 'week') {
      const last = new Date(T.addDays(range.to, -1));
      const md = { month: 'short', day: 'numeric' };
      return from.getMonth() === last.getMonth()
        ? `${from.toLocaleDateString(undefined, md)}–${last.getDate()}`
        : `${from.toLocaleDateString(undefined, md)}–${last.toLocaleDateString(undefined, md)}`;
    }
    return from.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }

  // The bar on top of the timeline, one line: Day | Week | Month (D W M on
  // a phone), then ‹ the period and its total ›. Tapping the period goes
  // back to the current one.
  function guiBar(range, days) {
    const bar = document.createElement('div');
    bar.className = 'gui-bar';
    const units = document.createElement('div');
    units.className = 'gui-presets';
    for (const [key, label] of UNITS) {
      units.append(guiButton([span2('tl-long', label), span2('tl-short', label[0])], () => showUnit(key), {
        pressed: guiUnit === key, title: label,
      }));
    }
    bar.append(units);
    const total = days.reduce((sum, d) => sum + d.totalMs, 0);
    const steps = document.createElement('div');
    steps.className = 'gui-steps';
    if (guiUnit) {
      const noun = guiUnit;
      const label = guiButton([span2('gui-period', periodLabel(range)), span2('tl-muted gui-total', total ? `  ${T.formatHM(total)}` : '')],
        () => showUnit(guiUnit), { cls: 'gui-day', title: guiBack ? `Back to this ${noun}` : `This ${noun}` });
      const next = guiButton('›', () => step(1), { title: `Next ${noun}`, cls: 'gui-step' });
      next.disabled = guiBack === 0;
      steps.append(guiButton('‹', () => step(-1), { title: `Previous ${noun}`, cls: 'gui-step' }), label, next);
    } else {
      steps.append(span2('gui-day gui-range', range.label), span2('tl-muted gui-total', total ? `  ${T.formatHM(total)}` : ''));
    }
    bar.append(steps);
    return bar;
  }

  function renderGui(slide) {
    const range = guiRangeNow();
    const mode = guiUnit || (isOneDay(range) ? 'day' : range.to - range.from <= 8 * DAY_MS ? 'week' : 'month');
    closeEntryEditor();
    guiTimeline = window.TymleeTimeline.render({
      store,
      range,
      mode,
      onSelect: openEntryEditor,
      onDay: (key) => showUnit('day', daysBack(T.parseRange(key, Date.now()).from)),
      header: (days) => guiBar(range, days),
    });
    if (slide) guiTimeline.el.classList.add(`tl-slide-${slide}`);
    guiEl.replaceChildren(guiTimeline.el);
  }

  // Swipe sideways on the timeline to step through days, weeks or months.
  (function swipe() {
    let start = null;
    guiEl.addEventListener('touchstart', (e) => {
      start = e.touches.length === 1 && !e.target.closest('.entry-card')
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
    }, { passive: true });
    guiEl.addEventListener('touchend', (e) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const quick = Date.now() - start.t < 600;
      start = null;
      if (quick && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
    }, { passive: true });
  })();

  // ---- GUI: the console tray ------------------------------------------------
  // In the GUI view the scrollback is a tray under the timeline, above the
  // prompt. Drag its divider to resize it, or click/tap the divider to fold
  // it to a single line and back. Phones start folded (a one-line peek).

  const divider = $('divider');
  const CONSOLE_KEY = 'tymlee.console';
  const lineHeight = () => parseFloat(getComputedStyle(out).lineHeight) || 20;
  const peekHeight = () => Math.ceil(lineHeight() + 10);
  let consoleHeight = null; // px; null: the default for the screen size
  try { consoleHeight = JSON.parse(localStorage.getItem(CONSOLE_KEY)); } catch (_) { /* default */ }
  let consoleOpen = !narrow.matches; // phones start with the peek

  function maxConsole() {
    return Math.max(peekHeight(), scrollEl.clientHeight - 140);
  }

  function applyConsole() {
    if (view !== 'gui') {
      out.style.height = '';
      return;
    }
    const full = consoleHeight || (narrow.matches ? scrollEl.clientHeight * 0.55 : lineHeight() * 6 + 12);
    const h = consoleOpen ? Math.min(Math.max(full, peekHeight()), maxConsole()) : peekHeight();
    out.style.height = `${Math.round(h)}px`;
    appEl.classList.toggle('console-folded', !consoleOpen);
    divider.setAttribute('aria-expanded', String(consoleOpen));
    out.scrollTop = out.scrollHeight;
  }

  // Open the tray as far as the report needs, up to about two thirds of
  // the space; it goes back to its size when you enter something next.
  let trayGrown = false;

  function showInTray() {
    const top = pinnedTop();
    if (!top) return;
    const need = out.scrollHeight - top.offsetTop + 12;
    const current = out.getBoundingClientRect().height;
    const h = Math.min(Math.max(need, current), Math.max(current, scrollEl.clientHeight * 0.66));
    consoleOpen = true;
    appEl.classList.remove('console-folded');
    divider.setAttribute('aria-expanded', 'true');
    if (h > current + 1) {
      appEl.classList.add('console-anim');
      out.style.height = `${Math.round(h)}px`;
      setTimeout(() => appEl.classList.remove('console-anim'), 250);
      trayGrown = true;
    }
  }

  function shrinkTray() {
    if (!trayGrown) return;
    trayGrown = false;
    if (narrow.matches) consoleOpen = false; // phones go back to the one-line peek
    applyConsole();
  }

  function toggleConsole(open = !consoleOpen) {
    consoleOpen = open;
    appEl.classList.add('console-anim');
    applyConsole();
    setTimeout(() => appEl.classList.remove('console-anim'), 250);
  }

  (function dragDivider() {
    let drag = null;
    divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, h: out.getBoundingClientRect().height, moved: false };
    });
    divider.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = drag.y - e.clientY;
      if (!drag.moved && Math.abs(dy) < 6) return;
      drag.moved = true;
      consoleOpen = true;
        trayGrown = false;
      const h = Math.min(Math.max(drag.h + dy, peekHeight()), maxConsole());
      out.style.height = `${h}px`;
      out.scrollTop = out.scrollHeight;
    });
    const end = (e) => {
      if (!drag) return;
      const { moved, h: before } = drag;
      drag = null;
      if (!moved) return toggleConsole();
      const h = out.getBoundingClientRect().height;
      if (h <= peekHeight() + 4) {
        consoleOpen = false; // dragged all the way down: fold it
      } else if (narrow.matches && e.type === 'pointerup' && h < before && before - h > 40 && h < scrollEl.clientHeight * 0.3) {
        consoleOpen = false; // a swipe down on a phone folds it
      } else {
        consoleHeight = h;
        try { localStorage.setItem(CONSOLE_KEY, JSON.stringify(Math.round(h))); } catch (_) { /* convenience */ }
      }
      applyConsole();
    };
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
    divider.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleConsole();
      }
    });
    // Tapping the one-line peek opens the console too.
    out.addEventListener('click', () => {
      if (view === 'gui' && !consoleOpen && !String(window.getSelection())) toggleConsole(true);
    });
  })();

  // ---- GUI: editing an entry by clicking its block ----------------------------

  let editCard = null; // { el, id }

  function closeEntryEditor() {
    if (!editCard) return;
    const { el, backdrop } = editCard;
    editCard = null;
    if (!backdrop) return el.remove();
    // Phones: slide the sheet away.
    el.classList.add('sheet-out');
    backdrop.classList.add('sheet-out');
    setTimeout(() => { el.remove(); backdrop.remove(); }, 180);
  }

  function field(labelText, control) {
    const label = document.createElement('label');
    label.className = 'ec-field';
    const name = document.createElement('span');
    name.textContent = labelText;
    label.append(name, control);
    return label;
  }

  // After the card closes, type on: the prompt gets the focus back, except
  // on touch screens, where that would pop up the keyboard.
  function backToPrompt() {
    if (!window.matchMedia('(pointer: coarse)').matches) focusPrompt();
  }

  // The prompt, or the notes box while notes are being typed.
  function focusPrompt() {
    (modal && modal.multiline ? notesBox : input).focus();
  }

  function openEntryEditor(b, blockEl) {
    closeEntryEditor();
    const entry = store.entries.find((e) => e.id === b.id);
    if (!entry) return;
    const card = document.createElement('form');
    card.className = 'entry-card';
    card.setAttribute('aria-label', `Edit entry #${b.n}`);

    const title = document.createElement('div');
    title.className = 'ec-title';
    title.textContent = `#${b.n} · ${T.ymd(entry.ts)} · ${T.formatHM(b.duration)}${b.running ? ' so far' : ''}`;

    const time = document.createElement('input');
    time.type = 'time';
    time.step = 60;
    time.value = T.hhmm(entry.ts);
    const wo = document.createElement('input');
    wo.type = 'text';
    wo.value = entry.wo || '';
    wo.placeholder = 'none';
    wo.spellcheck = false;
    const text = document.createElement('input');
    text.type = 'text';
    text.value = entry.text;
    text.spellcheck = false;
    const notes = document.createElement('textarea');
    notes.rows = 3;
    notes.value = entry.notes || '';
    notes.placeholder = 'notes';
    for (const c of [wo, text, notes]) c.setAttribute('autocapitalize', 'off');
    // Not a login or address form: keep browser autofill bars away.
    card.setAttribute('autocomplete', 'off');
    for (const c of [time, wo, text, notes]) c.setAttribute('autocomplete', 'off');

    const error = document.createElement('div');
    error.className = 'ec-error';
    error.setAttribute('role', 'alert');

    const buttons = document.createElement('div');
    buttons.className = 'ec-buttons';
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ec-delete';
    del.textContent = 'Delete';
    buttons.append(save, cancel, del);

    const row = document.createElement('div');
    row.className = 'ec-row';
    row.append(field('Start', time), field('Work order', wo));
    card.append(title, row, field('Entry', text), field('Notes', notes), error, buttons);

    // Notes and work orders need server support when signed in.
    for (const [name, control] of [['notes', notes], ['wo', wo]]) {
      store.supports(name).then((ok) => {
        if (ok) return;
        control.disabled = true;
        control.placeholder = 'needs the latest supabase/schema.sql';
      });
    }

    card.addEventListener('submit', (e) => {
      e.preventDefault();
      const current = store.entries.find((x) => x.id === b.id);
      if (!current) return closeEntryEditor();
      const r = T.editEntry(current, { time: time.value, wo: wo.value, text: text.value, notes: notes.value }, Date.now());
      if (r.error) {
        error.textContent = r.error;
        return;
      }
      closeEntryEditor();
      backToPrompt();
      if (!r.changed) return;
      store.apply([{ op: 'put', entry: r.entry }]);
      print(`updated #${b.n} ${r.entry.wo ? `${T.woTag(r.entry.wo)} ` : ''}${T.hhmm(r.entry.ts)} ${r.entry.text}`, 'ok');
    });
    cancel.addEventListener('click', () => {
      closeEntryEditor();
      backToPrompt();
    });
    del.addEventListener('click', () => {
      if (del.dataset.armed !== 'yes') {
        del.dataset.armed = 'yes';
        del.textContent = 'Delete? Click again';
        return;
      }
      closeEntryEditor();
      backToPrompt();
      store.remove(b.id);
      print(`removed #${b.n} ${T.hhmm(entry.ts)} ${entry.text}`, 'ok');
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeEntryEditor();
        backToPrompt();
      } else if (e.key === 'Enter' && e.target === notes && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        card.requestSubmit();
      }
    });

    if (narrow.matches) {
      // Phones: a bottom sheet over a dimmed timeline. Tap outside or swipe it
      // down to close. The keyboard stays down until a field is tapped.
      card.classList.add('sheet');
      const grip = document.createElement('div');
      grip.className = 'sheet-grip';
      card.prepend(grip);
      const backdrop = document.createElement('div');
      backdrop.className = 'sheet-backdrop';
      backdrop.addEventListener('click', () => closeEntryEditor());
      appEl.append(backdrop, card);
      editCard = { el: card, id: b.id, backdrop };
      let drag = null;
      card.addEventListener('touchstart', (e) => {
        if (e.target.closest('input, textarea, button') || card.scrollTop > 0) return;
        drag = { y: e.touches[0].clientY, dy: 0 };
      }, { passive: true });
      card.addEventListener('touchmove', (e) => {
        if (!drag) return;
        drag.dy = Math.max(0, e.touches[0].clientY - drag.y);
        card.style.transform = `translateY(${drag.dy}px)`;
      }, { passive: true });
      card.addEventListener('touchend', () => {
        if (!drag) return;
        const { dy } = drag;
        drag = null;
        card.style.transform = '';
        if (dy > 80) closeEntryEditor();
      });
      return;
    }

    // Place the card next to the block, inside the scrolling timeline.
    guiEl.append(card);
    const g = guiEl.getBoundingClientRect();
    const r = blockEl.getBoundingClientRect();
    const width = Math.min(380, g.width - 24);
    card.style.width = `${width}px`;
    const left = Math.min(Math.max(12, r.left - g.left + 24), g.width - width - 12);
    card.style.left = `${left}px`;
    card.style.top = `${r.top - g.top + guiEl.scrollTop + Math.min(24, r.height)}px`;
    editCard = { el: card, id: b.id };
    card.scrollIntoView({ block: 'nearest' });
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }

  // Show the top of the GUI (range buttons and legend), scrolling down only
  // as far as needed to bring the "now" line into view.
  function scrollToNow() {
    guiEl.scrollTop = 0;
    const now = guiEl.querySelector('.tl-now');
    if (!now) return;
    const t = now.getBoundingClientRect();
    const box = guiEl.getBoundingClientRect();
    const below = t.bottom - (box.top + box.height * 0.8);
    if (below > 0) guiEl.scrollTop = below;
  }

  let chosenView = 'gui'; // the view picked with the switch (commands can show the other for a while)

  function setView(next, { save = true } = {}) {
    view = next;
    if (save) chosenView = next;
    guiEl.hidden = view !== 'gui';
    divider.hidden = view !== 'gui';
    appEl.classList.toggle('gui-mode', view === 'gui');
    if (save) {
      try { localStorage.setItem(VIEW_KEY, view); } catch (_) { /* a per-browser convenience */ }
    }
    if (view === 'gui') {
      renderGui();
      scrollToNow();
    } else {
      closeEntryEditor();
      guiTimeline = null;
      guiEl.replaceChildren();
    }
    applyConsole();
    scrollToPrompt();
    renderStatus();
  }

  // /timeline [range]: open the GUI view on that range.
  function showTimeline(range) {
    guiBack = 0;
    guiRange = null;
    if (isOneDay(range)) {
      guiUnit = 'day';
      guiBack = Math.max(0, daysBack(range.from));
    } else if (range.label === 'week' || range.label === 'month') {
      guiUnit = range.label;
    } else {
      guiUnit = null;
      guiRange = range;
    }
    setView('gui');
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

  // /clear, Ctrl+L: also back to the chosen view, after a command (/log,
  // /help, ...) switched to the CLI view to show its output.
  function clearScreen() {
    out.replaceChildren();
    pinned = null;
    shrinkTray();
    if (editor) out.append(editor.el); // keep an open editor
    else if (view !== chosenView) setView(chosenView, { save: false });
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
    if (view === 'gui') setView('cli', { save: false }); // /edit and /restore need the text view
    const el = document.createElement('textarea');
    el.className = 'editor';
    el.value = text;
    el.spellcheck = false;
    el.wrap = narrow.matches ? 'soft' : 'off'; // no sideways scrolling on phones
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

  // Notes get a real multi-line box in place of the one-line prompt:
  // Enter saves, Shift+Enter (or the "new line" button) starts a new line.
  const notesBox = document.createElement('textarea');
  notesBox.id = 'notes-box';
  notesBox.rows = 1;
  notesBox.hidden = true;
  notesBox.spellcheck = false;
  notesBox.setAttribute('autocomplete', 'off');
  notesBox.setAttribute('aria-label', 'Notes');
  input.after(notesBox);

  function fitNotesBox() {
    notesBox.style.height = 'auto';
    notesBox.style.height = `${notesBox.scrollHeight}px`;
    scrollToPrompt();
  }

  function newNotesLine() {
    notesBox.setRangeText('\n', notesBox.selectionStart, notesBox.selectionEnd, 'end');
    fitNotesBox();
  }

  notesBox.addEventListener('input', fitNotesBox);
  notesBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitPrompt();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      endModal(null);
    }
  });

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
      if (multiline) {
        input.hidden = true;
        ghost.hidden = true;
        notesBox.hidden = false;
        notesBox.value = initial || '';
        notesBox.placeholder = 'type notes · Shift+Enter: new line · Enter: save · Esc: cancel';
        renderHints();
        fitNotesBox();
        notesBox.focus();
        notesBox.setSelectionRange(notesBox.value.length, notesBox.value.length);
        return;
      }
      input.value = initial || '';
      input.placeholder = 'Enter: save · Esc: cancel';
      renderHints();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  function endModal(value) {
    const m = modal;
    modal = null;
    if (m.multiline) {
      notesBox.hidden = true;
      notesBox.value = '';
      input.hidden = false;
      ghost.hidden = false;
      input.focus();
    }
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
        hintButton(`${choices[idx].label}  (${idx + 1}/${choices.length})`, 'sel', () => submitPrompt()),
        hintButton('newer ›', 'btn', () => movePick(-1)),
        hintButton('select', 'btn', () => submitPrompt()),
        hintButton('cancel', 'btn', () => endModal(null)),
      );
    } else {
      matchesEl.replaceChildren(
        hintButton(modal.label, 'sel', () => {}),
        ...(modal.multiline ? [hintButton('new line', 'btn', newNotesLine)] : []),
        hintButton('save', 'btn', () => submitPrompt()),
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
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submitPrompt();
      return;
    }
    if (modal) {
      const older = (e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowUp';
      const newer = (e.key === 'Tab' && e.shiftKey) || e.key === 'ArrowDown';
      if (e.key === 'Escape') {
        e.preventDefault();
        endModal(null);
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
    } else if (e.key === 'Escape' && editCard && !input.value) {
      closeEntryEditor();
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
    shrinkTray();
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

  // The prompt is not a <form>, so browsers don't offer to autofill it
  // (Chrome on iOS shows a passwords bar over the keyboard for form fields).
  // Enter submits it here instead.
  function submitPrompt() {
    if (modal) {
      if (modal.kind === 'pick') {
        const choice = modal.choices[modal.idx];
        echo(choice.label);
        endModal(choice);
      } else {
        const value = modal.multiline ? notesBox.value : input.value;
        echo(value.trim() || '(nothing)');
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
  }

  // Clicking the scrollback focuses the prompt, unless selecting text. Not on
  // touch screens, where a tap to scroll would pop up the keyboard.
  const finePointer = window.matchMedia('(pointer: fine)');
  scrollEl.addEventListener('click', (e) => {
    if (e.target.closest('.editor, .entry-card')) return;
    if (finePointer.matches && !String(window.getSelection())) focusPrompt();
  });
  $('dock').addEventListener('click', (e) => {
    if (e.target !== input && e.target !== notesBox && !e.target.closest('#matches span')) focusPrompt();
  });

  // ---- about: version and source, floating above the CLI | GUI switch -----

  (function about() {
    const el = $('about');
    const link = document.createElement('a');
    link.href = T.REPO_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'GitHub';
    link.title = 'The code for tymlee';
    el.append(`tymlee v${T.VERSION} · `, link);
  })();

  // ---- status bar ----------------------------------------------------------

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  let lastStatusHeight = '';

  function renderStatus() {
    const st = shell.status(Date.now());
    const left = span('now', '');
    let today = null;
    if (st.state === 'idle') {
      left.append(span('what', st.text));
    } else if (st.state === 'off') {
      left.append(span('stopped', '■ off'), span('what dim', `  since ${st.since}`));
      today = span('today', st.today);
      if (st.todayMoney) today.append(span('money', `  ${st.todayMoney}`));
    } else {
      left.append(span('run', `▶ ${st.clock}`));
      if (st.money) left.append(span(`money${st.ot ? ' ot' : ''}`, `  ${st.money}${st.ot ? ' OT' : ''}`));
      left.append(span('what', `  ${st.what}`));
      today = span('today', st.today);
      if (st.todayMoney) today.append(span('money', `  ${st.todayMoney}`));
      today.append(span('since', ` · since ${st.since}`));
    }
    const right = span('sync sync-' + st.sync.status, st.sync.label);
    statusEl.replaceChildren(...[left, today, right, viewToggle()].filter(Boolean));
    const h = `${statusEl.offsetHeight}px`;
    if (h !== lastStatusHeight) $('dock').style.setProperty('--status-h', (lastStatusHeight = h));
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
    let saved = 'gui';
    try { saved = localStorage.getItem(VIEW_KEY) || 'gui'; } catch (_) { /* default view */ }
    chosenView = saved === 'cli' ? 'cli' : 'gui';
    if (chosenView === 'gui') setView('gui', { save: false });
  });
})();
