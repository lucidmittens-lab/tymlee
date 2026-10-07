(async function () {
  'use strict';

  const T = window.Tymlee;
  const BUILD = window.TYMLEE_BUILD && /^[0-9a-f]{7,40}$/.test(window.TYMLEE_BUILD.commit) ? window.TYMLEE_BUILD : null;
  const V = window.TymleeVault;

  const $ = (id) => document.getElementById(id);
  const appEl = $('app');
  const scrollEl = $('scroll');
  const out = $('out');
  const input = $('entry');
  const ghost = $('ghost');
  const matchesEl = $('matches');
  const statusEl = $('status');

  let gui = null; // the GUI view (gui.js), set up once the shell exists

  // The log lives in IndexedDB (idb.js), read in before anything shows.
  const storage = await window.TymleeIdb.createStorage();
  window.tymleeStorage = storage; // for checking what's stored, from the browser console

  // Keep a copy of the site's files so it opens with no signal (sw.js).
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const store = window.TymleeStore.createStore({
    storage,
    onChange: () => { renderStatus(); refreshTimelines(); },
    onNotice: (text, cls) => { print(text, cls); scrollToPrompt(); },
  });

  // Keep multiple open tabs showing the same log.
  storage.onChange((keys) => {
    if (keys.some((k) => store.watchedKeys().includes(k))) store.reloadFromStorage();
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
    if (gui) gui.output(text, cls); // the GUI view shows it as a toast or a sheet
    // In the GUI view, bigger output (reports, help, keys) shows in the
    // console tray from its top; the tray keeps its size (scroll to read on).
    pinned = /\b(report|key)\b/.test(cls || '') ? pre : null;
    if (view === 'gui') scrollToPrompt();
    return pre;
  }

  // Reports are columns of text. On a narrow screen their lines wrap rather
  // than scroll sideways, and a wrapped line continues under its last column
  // (the entry's text, say) so the columns stay readable.
  // How many characters fit across `box` (the console, or a GUI sheet).
  function charsPerLine(box = out, padding = 32) {
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(20);
    probe.style.visibility = 'hidden';
    box.append(probe);
    const width = probe.getBoundingClientRect().width / 20;
    probe.remove();
    return width && box.clientWidth ? Math.floor((box.clientWidth - padding) / width) : 80;
  }

  function appendLines(pre, text, box, padding) {
    const maxHang = Math.max(4, Math.floor(charsPerLine(box, padding) / 2)); // at most halfway across
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
    dockBase = 0; // measured again for the new size
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
      // /ai: the Claude SDK loads the first time it's used; requests go from
      // this browser straight to Anthropic with the person's own key.
      ai: {
        module: window.TymleeAi,
        fileUsage: '/ai file [what to do]',
        tools: { toBase64, inflateRaw },
        async client(key) {
          await loadScript('vendor/anthropic.js');
          return new window.TymleeAnthropic({ apiKey: key, dangerouslyAllowBrowser: true });
        },
        async files(args) {
          if ((args[0] || '').toLowerCase() !== 'file') return { files: [], rest: args };
          const files = await chooseFiles();
          return files.length ? { files, rest: args.slice(1) } : null;
        },
      },
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
      helpFooter: ['', `Terminal app for Mac: ${T.REPO_URL}/releases/latest/download/tymlee.pkg`],
      build: BUILD ? BUILD.commit.slice(0, 7) : '',
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

  // ---- the GUI view (gui.js) --------------------------------------------------

  // Run a line as if typed (without echoing it), for the GUI's buttons and menu.
  async function runLine(line, { undo = false } = {}) {
    gui.markStart(undo);
    try {
      await shell.run(shell.route(line));
    } finally {
      gui.markStart(false);
    }
    renderStatus();
  }

  gui = window.TymleeGui.createGui({
    T,
    store,
    shell,
    appEl,
    dockEl: $('dock'),
    run: runLine,
    readAiFile: (f) => readAiFile(f),
    // The Timeline tab: today, at the top of the view.
    home: () => showUnit(guiUnit || 'day', 0),
    // /edit and /restore need the text box: the CLI view, then back.
    openCli(line) {
      setView('cli', { save: false });
      submit(line);
    },
    setView: (v) => setView(v),
    // Reports in a sheet wrap like in the console (continuing under their
    // last column).
    formatReport(pre, text) {
      pre.replaceChildren();
      appendLines(pre, text, pre, 0);
    },
    about: { version: T.VERSION, build: BUILD ? BUILD.commit.slice(0, 7) : '', repo: T.REPO_URL },
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
  // What the GUI shows: a day, a (Sunday to Saturday, like calweek) week or a calendar month,
  // `back` of them before the current one; or, with unit null, `guiRange`
  // (from /timeline <range>).
  const UNITS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
  // Day, week or month: the one last chosen, on this device.
  const UNIT_KEY = 'tymlee.unit';
  let guiUnit = 'day';
  try { if (['day', 'week', 'month'].includes(localStorage.getItem(UNIT_KEY))) guiUnit = localStorage.getItem(UNIT_KEY); } catch (_) { /* default */ }
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
      const sunday = T.addDays(today, -new Date(today).getDay());
      const from = T.addDays(sunday, -7 * back);
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
    try { localStorage.setItem(UNIT_KEY, unit); } catch (_) { /* a per-device convenience */ }
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
      const next = guiButton([window.TymleeGui.icon('right')], () => step(1), { title: `Next ${noun}`, cls: 'gui-step' });
      next.disabled = guiBack === 0;
      steps.append(guiButton([window.TymleeGui.icon('left')], () => step(-1), { title: `Previous ${noun}`, cls: 'gui-step' }), label, next);
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
      // A day or week fills the space between the bar and the controls.
      fit: mode === 'month' ? null : fitTimeline,
      zoom: () => zoom,
    });
    if (slide) guiTimeline.el.classList.add(`tl-slide-${slide}`);
    guiEl.replaceChildren(guiTimeline.el, ...(mode === 'month' ? [] : [zoomBar.el]));
    zoomBar.sync();
    if (mode !== 'month') guiTimeline.refresh(); // measured now that it's on the page
  }

  // ---- zoom ------------------------------------------------------------------
  // 1 fits the day (or week) to the screen; up to 8 times taller, scrolling.
  // A slider in the corner (−, +, Fit), Ctrl+scroll, or a pinch on a phone.
  // Kept per device.
  const ZOOM_KEY = 'tymlee.zoom';
  const ZOOM_MAX = 8;
  let zoom = 1;
  try { zoom = Math.min(ZOOM_MAX, Math.max(1, Number(localStorage.getItem(ZOOM_KEY)) || 1)); } catch (_) { /* fine */ }
  const toSlider = (z) => Math.round((Math.log(z) / Math.log(ZOOM_MAX)) * 100);
  const fromSlider = (v) => Math.exp((v / 100) * Math.log(ZOOM_MAX));

  let zoomFrame = 0;
  function setZoom(z) {
    z = Math.min(ZOOM_MAX, Math.max(1, z));
    if (Math.abs(z - zoom) < 0.01) return;
    // Keep the middle of what's showing in the middle.
    const mid = guiEl.scrollHeight ? (guiEl.scrollTop + guiEl.clientHeight / 2) / guiEl.scrollHeight : 0;
    zoom = z;
    try { localStorage.setItem(ZOOM_KEY, String(Math.round(z * 100) / 100)); } catch (_) { /* fine */ }
    zoomBar.sync();
    cancelAnimationFrame(zoomFrame);
    zoomFrame = requestAnimationFrame(() => {
      if (!guiTimeline) return;
      guiTimeline.refresh();
      guiEl.scrollTop = mid * guiEl.scrollHeight - guiEl.clientHeight / 2;
    });
  }

  const zoomBar = (() => {
    const wrap = document.createElement('div');
    wrap.className = 'gui-zoom-wrap';
    const box = document.createElement('div');
    box.className = 'gui-zoom';
    const out = guiButton([window.TymleeGui.icon('minus')], () => setZoom(zoom / 1.5), { title: 'Zoom out', cls: 'gz-btn' });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.className = 'gz-slider';
    slider.setAttribute('aria-label', 'Zoom');
    slider.addEventListener('input', () => setZoom(fromSlider(Number(slider.value))));
    const inn = guiButton([window.TymleeGui.icon('plus')], () => setZoom(zoom * 1.5), { title: 'Zoom in', cls: 'gz-btn' });
    const fitBtn = guiButton('Fit', () => setZoom(1), { title: 'Fit the day to the screen', cls: 'gz-fit' });
    box.append(out, slider, inn, fitBtn);
    wrap.append(box);
    return {
      el: wrap,
      sync() {
        slider.value = String(toSlider(zoom));
        out.disabled = zoom <= 1;
        inn.disabled = zoom >= ZOOM_MAX;
        fitBtn.hidden = zoom <= 1;
        box.classList.toggle('zoomed', zoom > 1);
      },
    };
  })();

  // Ctrl (or Cmd) + scroll, and trackpad pinches (which arrive as that).
  guiEl.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !guiTimeline) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY / 300));
  }, { passive: false });
  // Two fingers on a phone.
  (function pinch() {
    let start = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    guiEl.addEventListener('touchstart', (e) => { start = e.touches.length === 2 ? { d: dist(e.touches), z: zoom } : null; }, { passive: true });
    guiEl.addEventListener('touchmove', (e) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      setZoom(start.z * (dist(e.touches) / start.d));
    }, { passive: false });
    guiEl.addEventListener('touchend', () => { start = null; }, { passive: true });
  })();

  // The height the hours can take: from below the bar to the bottom of the
  // GUI's area, less its padding. 0 when it isn't on screen to measure.
  function fitTimeline(top) {
    if (!top.isConnected || !guiEl.clientHeight) return 0;
    const pad = parseFloat(getComputedStyle(guiEl).paddingBottom) || 0;
    const room = guiEl.getBoundingClientRect().bottom - pad - top.getBoundingClientRect().bottom - 8;
    return room > 120 ? room : 0; // too short to be worth fitting: scroll instead
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

  // Pull the timeline down from the top to sync (signed in) or just redraw.
  (function pullToSync() {
    const tip = document.createElement('div');
    tip.className = 'pull-tip';
    tip.setAttribute('aria-hidden', 'true');
    let pull = null;
    guiEl.addEventListener('touchstart', (e) => {
      pull = e.touches.length === 1 && guiEl.scrollTop <= 0 && !e.target.closest('.entry-card, .gui-zoom')
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, dy: 0 } : null;
    }, { passive: true });
    guiEl.addEventListener('touchmove', (e) => {
      if (!pull || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - pull.x;
      const dy = e.touches[0].clientY - pull.y;
      if (!pull.dy && (dy <= 0 || Math.abs(dx) > Math.abs(dy))) { pull = null; return; }
      pull.dy = Math.max(0, dy);
      if (!tip.isConnected) guiEl.prepend(tip);
      const h = Math.min(70, pull.dy * 0.5);
      tip.style.height = `${h}px`;
      tip.textContent = h >= 60 ? (store.user ? 'Release to sync' : 'Release to refresh') : (store.user ? 'Pull to sync' : 'Pull to refresh');
      tip.classList.toggle('ready', h >= 60);
    }, { passive: true });
    guiEl.addEventListener('touchend', () => {
      if (!pull) return;
      const ready = tip.classList.contains('ready');
      pull = null;
      tip.style.height = '0px';
      setTimeout(() => tip.remove(), 200);
      if (!ready) return;
      if (store.user) runLine('/sync');
      else if (guiTimeline) { guiTimeline.refresh(); gui.toast('Up to date · this device only (sign in to sync)', 'dim'); }
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

  // The prompt area under the tray can grow for a while (multi-line notes,
  // completions on a phone). The tray gives up that room, so the timeline
  // above never moves. dockBase: the prompt area's usual height.
  const dockEl = $('dock');
  let dockBase = 0;

  function dockExtra() {
    const h = dockEl.offsetHeight;
    if (!dockBase || h < dockBase) dockBase = h;
    return h - dockBase;
  }

  // Room for the timeline and the tray together (as if the prompt area were
  // its usual height).
  const traySpace = () => scrollEl.clientHeight + dockExtra();

  function maxConsole() {
    return Math.max(peekHeight(), traySpace() - 140);
  }

  function applyConsole() {
    if (view !== 'gui') {
      out.style.height = '';
      return;
    }
    const full = consoleHeight || (narrow.matches ? traySpace() * 0.55 : lineHeight() * 6 + 12);
    const h = consoleOpen ? Math.min(Math.max(full, peekHeight()), maxConsole()) : peekHeight();
    out.style.height = `${Math.max(0, Math.round(h - dockExtra()))}px`;
    appEl.classList.toggle('console-folded', !consoleOpen);
    divider.setAttribute('aria-expanded', String(consoleOpen));
    scrollToPrompt();
  }

  // Refit the timeline when its area changes size (the window, the console
  // being dragged, the keyboard).
  if (window.ResizeObserver) {
    let lastH = 0;
    new ResizeObserver(() => {
      const h = guiEl.clientHeight;
      if (Math.abs(h - lastH) < 2) return;
      lastH = h;
      if (guiTimeline && onTimeline()) guiTimeline.refresh();
    }).observe(guiEl);
  }
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (view === 'gui') applyConsole(); }).observe(dockEl);
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
    if (view === 'pure') return; // no prompt in the GUI view
    (modal && modal.multiline ? notesBox : input).focus();
  }

  function openEntryEditor(b, blockEl) {
    closeEntryEditor();
    const entry = store.entries.find((e) => e.id === b.id);
    if (!entry) return;
    const card = document.createElement('form');
    card.className = 'entry-card';
    card.setAttribute('aria-label', `Edit entry ${T.idTag(b.n)}`);

    const title = document.createElement('div');
    title.className = 'ec-title';
    title.textContent = `${T.idTag(b.n)} · ${T.ymd(entry.ts)} · ${T.formatHM(b.duration)}${b.running ? ' so far' : ''}`;

    const time = document.createElement('input');
    time.type = 'time';
    time.step = 60;
    time.value = T.hhmm(entry.ts);
    const wo = document.createElement('input');
    wo.type = 'text';
    wo.value = entry.wo || '';
    wo.placeholder = 'none';
    wo.spellcheck = false;
    const eq = document.createElement('input');
    eq.type = 'text';
    eq.value = entry.eq || '';
    eq.placeholder = 'none';
    eq.spellcheck = false;
    const text = document.createElement('input');
    text.type = 'text';
    text.value = entry.text;
    text.spellcheck = false;
    const notes = document.createElement('textarea');
    notes.rows = 3;
    notes.value = entry.notes || '';
    notes.placeholder = 'notes';
    const files = document.createElement('textarea');
    files.rows = 2;
    files.value = T.groupFiles(entry.files).join('\n');
    files.placeholder = '/Volumes/Work/ mix.wav stems.zip';
    files.title = 'A folder, then the files in it (spaces or commas between); or full paths, one per line';
    files.spellcheck = false;
    for (const c of [wo, eq, text, notes, files]) c.setAttribute('autocapitalize', 'off');
    // Not a login or address form: keep browser autofill bars away.
    card.setAttribute('autocomplete', 'off');
    for (const c of [time, wo, eq, text, notes, files]) c.setAttribute('autocomplete', 'off');

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
    row.append(field('Start', time), field('Work order', wo), field('Equipment', eq));
    card.append(title, row, field('Entry', text), field('Notes', notes), field('Files', files), error, buttons);

    // Notes, work orders and equipment need server support when signed in.
    for (const [name, control] of [['notes', notes], ['notes', files], ['wo', wo], ['eq', eq]]) {
      store.supports(name).then((ok) => {
        if (ok) return;
        control.disabled = true;
        control.placeholder = name === 'eq' ? 'needs encryption' : 'needs the latest supabase/schema.sql';
      });
    }

    card.addEventListener('submit', (e) => {
      e.preventDefault();
      const current = store.entries.find((x) => x.id === b.id);
      if (!current) return closeEntryEditor();
      const r = T.editEntry(current, { time: time.value, wo: wo.value, eq: eq.value, text: text.value, notes: notes.value, files: files.value }, Date.now());
      if (r.error) {
        error.textContent = r.error;
        return;
      }
      closeEntryEditor();
      backToPrompt();
      if (!r.changed) return;
      store.apply([{ op: 'put', entry: r.entry }]);
      print(`updated ${T.idTag(b.n)} ${r.entry.wo ? `${T.woTag(r.entry.wo)} ` : ''}${r.entry.eq ? `${T.eqTag(r.entry.eq)} ` : ''}${T.clock(r.entry.ts)} ${r.entry.text}`, 'ok');
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
      print(`removed ${T.idTag(b.n)} ${T.clock(entry.ts)} ${entry.text}`, 'ok');
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

  // Views: 'cli' (the scrollback), 'gui' (Hybrid: timeline and console) and
  // 'pure' (GUI: timeline and start bar, no console; gui.js).
  const TIMELINE_VIEWS = ['gui', 'pure'];
  const onTimeline = () => TIMELINE_VIEWS.includes(view);

  function setView(next, { save = true } = {}) {
    view = next;
    if (save) chosenView = next;
    guiEl.hidden = !onTimeline();
    divider.hidden = view !== 'gui';
    appEl.classList.toggle('gui-mode', onTimeline());
    appEl.classList.toggle('pure-mode', view === 'pure');
    if (view === 'pure') gui.show();
    else gui.hide();
    if (save) {
      try { localStorage.setItem(VIEW_KEY, view); } catch (_) { /* a per-browser convenience */ }
    }
    if (onTimeline()) {
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
    setView(view === 'pure' ? 'pure' : 'gui');
  }

  let refreshQueued = false;
  function refreshTimelines() {
    if (refreshQueued || !guiTimeline) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      if (guiTimeline && onTimeline()) guiTimeline.refresh();
    }, 250);
  }
  setInterval(refreshTimelines, 30000);

  function viewToggle() {
    const wrap = span('view-toggle', '');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'View');
    for (const [v, long, short, what] of [['cli', 'CLI', 'CLI', 'Command view'], ['gui', 'Hybrid', 'HYB', 'Timeline and console'], ['pure', 'GUI', 'GUI', 'Timeline with buttons']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.append(span('tl-long', long), span('tl-short', short));
      b.setAttribute('aria-pressed', String(view === v));
      b.title = `${what} (Ctrl/Cmd+G switches CLI and the last timeline view)`;
      b.setAttribute('aria-label', long);
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the prompt
      b.addEventListener('click', () => { if (view !== v) setView(v); });
      wrap.append(b);
    }
    return wrap;
  }

  // 12h | 24h, next to the view switch; the same as /clock 12 and /clock 24.
  function clockToggle() {
    const mode = shell.applyClock();
    const wrap = span('view-toggle clock-toggle', '');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Clock');
    for (const [v, what] of [['12', '12-hour clock (2:30pm)'], ['24', '24-hour clock (14:30)']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.append(v, span('ck-h', 'h'));
      b.setAttribute('aria-pressed', String(mode === v));
      b.title = what;
      b.setAttribute('aria-label', what);
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the prompt
      b.addEventListener('click', () => {
        if (mode === v) return;
        shell.setClock(v);
        renderStatus();
        refreshTimelines();
      });
      wrap.append(b);
    }
    return wrap;
  }

  // /clear, Ctrl+L: also back to the chosen view, after a command (/log,
  // /help, ...) switched to the CLI view to show its output.
  function clearScreen() {
    out.replaceChildren();
    pinned = null;
    if (editor) out.append(editor.el, ...(editor.bar ? [editor.bar] : [])); // keep an open editor
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
  // A script loaded on demand (once).
  const loading = new Map();
  function loadScript(src) {
    if (!loading.has(src)) {
      loading.set(src, new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => { loading.delete(src); reject(new Error('could not load the Claude library (offline?)')); };
        document.head.append(el);
      }));
    }
    return loading.get(src);
  }

  // Files for /ai, any kind: [{ name, type, bytes }] (empty if none picked).
  function chooseFiles() {
    return new Promise((resolve) => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.multiple = true;
      picker.hidden = true;
      picker.addEventListener('change', async () => {
        const list = [...(picker.files || [])];
        picker.remove();
        resolve(await readFiles(list));
      });
      document.body.append(picker);
      picker.click();
    });
  }

  function readFiles(list) {
    return Promise.all(list.map(readAiFile));
  }

  // A picked file as /ai takes it: { name, type, bytes }. Photos are shrunk
  // to the size Claude reads them at (longest side 1568px) and sent as JPEG,
  // which also turns iPhone HEIC photos into something it reads. A photo
  // that can't be decoded goes as it is (and is checked like any file).
  const PHOTO = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;
  async function readAiFile(file) {
    if (/^image\//.test(file.type) || PHOTO.test(file.name)) {
      try {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff'; // transparent PNGs: a white page, not black
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        if (bmp.close) bmp.close();
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
        if (blob) return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()) };
      } catch (_) { /* not decodable here: as it is */ }
    }
    return { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
  }

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

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
    if (view !== 'cli') setView('cli', { save: false }); // /edit and /restore need the text view
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
    // Save / Cancel buttons (the same as /save and /cancel), when the text box
    // was opened from the GUI view; the CLI and Hybrid views type them.
    const buttons = chosenView === 'pure';
    const bar = document.createElement('div');
    bar.className = 'editor-buttons';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'editor-save';
    save.textContent = mode === 'restore' ? 'Add entries' : 'Save';
    save.addEventListener('click', () => submit('/save'));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => submit('/cancel'));
    const hint = document.createElement('span');
    hint.className = 'editor-hint';
    hint.textContent = 'or Ctrl/Cmd+Enter';
    bar.append(save, cancel, hint);
    out.append(el);
    if (buttons) out.append(bar);
    editor = { el, bar: buttons ? bar : null, items, mode };
    fitEditor(el);
    input.placeholder = `${mode === 'restore' ? 'restoring' : 'editing'} · ${buttons ? 'Save or Cancel below' : '/save or /cancel'}`;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    scrollToPrompt();
  }

  // Leave the edited text on screen as a read-only record (and go back to the
  // GUI view if that is where /edit or /restore was opened from).
  function closeEditor() {
    if (chosenView === 'pure' && view !== 'pure') setTimeout(() => setView('pure', { save: false }), 0);
    if (editor.mode === 'restore') {
      editor.el.remove();
    } else {
      const pre = document.createElement('pre');
      pre.className = 'report dim';
      pre.textContent = editor.el.value.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').trimEnd();
      editor.el.replaceWith(pre);
    }
    if (editor.bar) editor.bar.remove();
    editor = null;
    input.placeholder = '';
    backToPrompt();
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

  // The box grows with the notes, in the GUI view only as far as the
  // console tray has room (at least two lines), then scrolls: the timeline
  // stays where it is.
  let notesRoom = 0;

  function fitNotesBox() {
    notesBox.style.maxHeight = notesRoom ? `${notesRoom}px` : '';
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
      const yesno = name === 'yesno'; // Apply / Cancel buttons; y + Enter too
      modal = { kind: 'ask', label, multiline, yesno, resolve };
      if (multiline) {
        input.hidden = true;
        ghost.hidden = true;
        notesBox.hidden = false;
        notesBox.value = initial || '';
        const line = parseFloat(getComputedStyle(input).lineHeight) || 20;
        notesRoom = view === 'gui' ? Math.max(line * 2, line + out.getBoundingClientRect().height - 8) : 0;
        notesBox.placeholder = 'type notes · Shift+Enter: new line · Enter: save · Esc: cancel';
        renderHints();
        fitNotesBox();
        notesBox.focus();
        notesBox.setSelectionRange(notesBox.value.length, notesBox.value.length);
        return;
      }
      input.value = initial || '';
      input.placeholder = yesno ? 'y + Enter: apply · Esc: cancel' : 'Enter: save · Esc: cancel';
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
        ...(modal.yesno ? [hintButton('apply', 'btn', () => endModal('y'))] : [hintButton('save', 'btn', () => submitPrompt())]),
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
      if (list[0] && list[0].toLowerCase().startsWith(typed.toLowerCase())) {
        const span = document.createElement('span');
        span.className = 'typed';
        span.textContent = typed;
        ghost.append(span, list[0].slice(typed.length));
      }
    }
    matchesEl.replaceChildren(...list.map((m, i) => {
      const span = document.createElement('span');
      span.textContent = m;
      const hint = shell.completionHint(m);
      if (hint) span.append(Object.assign(document.createElement('i'), { className: 'hint', textContent: ` ${hint}` }));
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
      setView(view === 'cli' ? (chosenView === 'pure' ? 'pure' : 'gui') : 'cli');
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
    if (view === 'pure') return;
    if (e.target !== input && e.target !== notesBox && !e.target.closest('#matches span')) focusPrompt();
  });

  // The GUI view has no prompt: Ctrl/Cmd+Z undoes there too (outside fields).
  document.addEventListener('keydown', (e) => {
    if (view !== 'pure' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    e.preventDefault();
    runLine('/undo');
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
    el.append(`tymlee v${T.VERSION} · `);
    // The build: the commit this copy of the site was deployed from.
    if (BUILD) {
      const b = document.createElement('a');
      b.href = `${T.REPO_URL}/commit/${BUILD.commit}`;
      b.target = '_blank';
      b.rel = 'noopener';
      b.className = 'build';
      b.textContent = BUILD.commit.slice(0, 7);
      b.title = `build ${BUILD.commit.slice(0, 7)}${BUILD.at ? `, deployed ${new Date(BUILD.at).toLocaleString()}` : ''}`;
      el.append(b, ' · ');
    }
    el.append(link);
  })();

  // ---- status bar ----------------------------------------------------------

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  // A bit of the status bar that runs a command when clicked: the to-do
  // being worked on, the count of to-dos due. In the GUI it opens the list.
  function statusLink(cls, text, line, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `status-link ${cls}`;
    b.textContent = text;
    b.title = title;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the prompt
    b.addEventListener('click', () => (gui && gui.active ? gui.openTodos() : submit(line)));
    return b;
  }

  let lastStatusHeight = '';

  // The accent color from the account's settings (/accent): a small style
  // sheet that sets it for light and dark screens. Without one, style.css's.
  const accentStyle = document.createElement('style');
  document.head.append(accentStyle);
  let accentShown = null;
  function applyAccent() {
    const want = (store.settings && store.settings.accent) || '';
    if (want === accentShown) return;
    accentShown = want;
    const c = want ? T.accentColors(want) : null;
    accentStyle.textContent = c ? [
      `:root { --accent: ${c.light.accent}; --on-accent: ${c.light.on}; }`,
      `@media (prefers-color-scheme: dark) { :root { --accent: ${c.dark.accent}; --on-accent: ${c.dark.on}; } }`,
    ].join('\n') : '';
  }

  function renderStatus() {
    applyAccent();
    const st = shell.status(Date.now());
    const left = span('now', '');
    let today = null;
    if (st.state === 'idle') {
      left.append(span('what', st.text));
    } else if (st.state === 'off') {
      left.append(span('stopped', `■ ${st.offLabel || 'off'}`), span('what dim', `  since ${st.since}`));
      today = span('today', st.today);
      if (st.todayMoney) today.append(span('money', `  ${st.todayMoney}`));
    } else {
      left.append(span('run', `▶ ${st.clock}`));
      if (st.money) left.append(span(`money${st.ot ? ' ot' : ''}`, `  ${st.money}${st.ot ? ' OT' : ''}`));
      left.append(span('what', `  ${st.what}`));
      if (st.todo) left.append(statusLink('todo-tag', st.todo.tag, '/todos', 'The to-do you are working on: /done marks it done'));
      today = span('today', st.today);
      if (st.todayMoney) today.append(span('money', `  ${st.todayMoney}`));
      today.append(span('since', ` · since ${st.since}`));
    }
    const right = span('sync sync-' + st.sync.status, st.sync.label);
    const due = st.due ? statusLink('due', `${st.due} due`, '/todos today', 'To-dos due today or overdue') : null;
    statusEl.replaceChildren(...[left, due, today, right, clockToggle(), viewToggle()].filter(Boolean));
    if (gui) gui.update(st);
    const h = `${statusEl.offsetHeight}px`;
    if (h !== lastStatusHeight) $('dock').style.setProperty('--status-h', (lastStatusHeight = h));
    appEl.style.setProperty('--dock-h', `${$('dock').offsetHeight}px`); // toasts sit above it
  }

  // ---- boot ----------------------------------------------------------------

  // In Safari on an iPhone or iPad (not opened from the Home Screen), a
  // one-time hint on how to install it as an app.
  (function homeScreenHint() {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const installed = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    let seen = false;
    try { seen = localStorage.getItem('tymlee.homeHint') === '1'; } catch (_) { /* show it */ }
    if (!ios || installed || seen) return;
    const hint = document.createElement('div');
    hint.className = 'home-hint';
    hint.setAttribute('role', 'note');
    const text = document.createElement('span');
    text.append('Use tymlee like an app: tap ', Object.assign(document.createElement('b'), { textContent: 'Share' }), ', then ', Object.assign(document.createElement('b'), { textContent: 'Add to Home Screen' }), '.');
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.append(window.TymleeGui.icon('x'));
    close.addEventListener('click', () => {
      hint.remove();
      try { localStorage.setItem('tymlee.homeHint', '1'); } catch (_) { /* fine */ }
    });
    hint.append(text, close);
    appEl.append(hint);
  })();

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
    for (const note of shell.startupNotices()) print(note, 'dim');
    renderStatus();
    scrollToPrompt();
    // Reopen the view used last (after printing today's log into the scrollback).
    let saved = 'gui';
    try { saved = localStorage.getItem(VIEW_KEY) || 'gui'; } catch (_) { /* default view */ }
    chosenView = ['cli', 'gui', 'pure'].includes(saved) ? saved : 'gui';
    if (chosenView !== 'cli') setView(chosenView, { save: false });
  });
})();
