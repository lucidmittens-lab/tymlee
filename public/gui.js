// The GUI view (the "pure" one, without a console): the timeline on top, a
// start bar at the bottom (category, title, Start, Off), toasts for short
// messages, sheets for longer ones, and a ☰ menu for everything else.
//
// Everything runs through the same command shell as the CLI (commands.js),
// so the GUI does exactly what the typed commands do. app.js creates it and
// routes printed output here while the GUI view is showing.
(function (root) {
  'use strict';


  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(label, cls, onClick, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    b.addEventListener('click', onClick);
    return b;
  }

  // Line icons, drawn here so they look the same on every device.
  const ICONS = {
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    cup: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3v3M11 3v3"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="2.4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.4"/>',
    swap: '<path d="M5 9h13l-3.5-3.5M19 15H6l3.5 3.5"/>',
    back: '<path d="M9 7L4 12l5 5M4 12h10a5 5 0 0 1 5 5v2"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    down: '<path d="M7 10l5 5 5-5"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    minus: '<path d="M6 12h12"/>',
    spark: '<path d="M11 3.5l1.9 5.1 5.1 1.9-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z" fill="currentColor" stroke="none"/><path d="M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" stroke="none"/>',
    camera: '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.3l1.5-2.2h7.4L17.2 7h2.3A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="12.8" r="3.4"/>',
    paperclip: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    note: '<path d="M6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V6A1.5 1.5 0 0 1 6 4.5z"/><path d="M8.5 9.5h7M8.5 13h7M8.5 16.5h4"/>',
    hash: '<path d="M9.5 4L8 20M16 4l-1.5 16M5 9h15M4 15h15"/>',
    tool: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5"/><path d="M14.5 6.5L17 4l3 3-2.5 2.5"/>',
    pencil: '<path d="M15.5 5.5l3 3L8 19H5v-3z"/><path d="M13.5 7.5l3 3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  };
  function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }

  const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['calweek', 'This week'], ['week', '7 days'], ['calmonth', 'This month'], ['month', '30 days'], ['all', 'All']];

  // opts: { T, store, shell, appEl, dockEl, run(line) -> Promise, openCli(line),
  //         setView(view), status() -> shell.status(), about: { version, build, repo } }
  function createGui(opts) {
    const { T, store, shell, appEl, dockEl } = opts;
    let active = false;
    let capture = null; // lines printed while a menu command runs

    // ---- start bar -------------------------------------------------------------
    // Changes with what's going on (bar.dataset.mode):
    //   idle     nothing running: the fields, Resume and Start
    //   running  a card with the running entry and its timer; Done (for a
    //            to-do started with /do), the breaks, Off and New task
    //   break    on a break: the card counts it; Back to work
    //   compose  New task while something runs: the fields, Cancel and Switch

    const bar = el('div', 'startbar');
    bar.id = 'startbar';
    bar.hidden = true;
    bar.dataset.mode = 'idle';
    let composing = false;
    let state = null; // the last status from update()

    const menuBtn = button('', 'sb-menu', () => (sheetName === 'Menu' ? closeSheet() : openMenu()), 'Menu (? lists the keyboard shortcuts)');
    menuBtn.append(icon('menu'));
    // The card: what's running and for how long.
    const card = el('div', 'sb-card');
    const dot = el('span', 'sb-dot');
    const cardWords = el('div', 'sb-card-words');
    const clock = el('span', 'sb-clock');
    const what = el('span', 'sb-what');
    cardWords.append(clock, what);
    const tdTag = el('span', 'sb-td');
    // + on the card: add to what's running (a note, work order, equipment,
    // files), or open the whole entry.
    const addBtn = button('', 'sb-add', () => toggleAddMenu(), 'Add to this entry: a note, work order, equipment or files (+)');
    addBtn.append(icon('plus'));
    addBtn.setAttribute('aria-haspopup', 'menu');
    card.append(dot, cardWords, tdTag, addBtn);
    const catWrap = el('div', 'sb-cat');
    const cat = el('input');
    cat.type = 'text';
    cat.placeholder = 'category';
    cat.setAttribute('aria-label', 'Category');
    const title = el('input', 'sb-title');
    title.type = 'text';
    title.placeholder = 'what are you working on?';
    title.setAttribute('aria-label', 'Title');
    for (const f of [cat, title]) {
      f.setAttribute('autocomplete', 'off');
      f.setAttribute('autocapitalize', 'off');
      f.setAttribute('autocorrect', 'off');
      f.spellcheck = false;
    }
    title.enterKeyHint = 'go';
    cat.enterKeyHint = 'next';
    const suggest = el('div', 'sb-suggest');
    suggest.setAttribute('role', 'listbox');
    suggest.hidden = true;
    catWrap.append(cat, suggest);

    const withIcon = (name, label, cls, run, tip) => {
      const b = button('', cls, run, tip);
      b.append(icon(name), el('span', 'sb-label', label));
      return b;
    };
    const startBtn = withIcon('play', 'Start', 'sb-start', () => start(), 'Start this entry (Enter)');
    const cancelBtn = withIcon('x', 'Cancel', 'sb-cancel', () => setComposing(false), 'Keep what is running (Esc)');
    const resumeBtn = withIcon('back', 'Resume', 'sb-resume', () => resume(), 'Start the last task again (R)');
    const backBtn = withIcon('back', 'Back to work', 'sb-back', () => resume(), 'End the break and start the last task again (R)');
    const newBtn = withIcon('swap', 'New task', 'sb-new', () => setComposing(true), 'Start something else, which ends what is running (N)');
    const doneBtn = withIcon('check', 'Done', 'sb-done', () => opts.run('/done'), 'Mark the to-do done; the timer keeps going (D)');
    const offBtn = withIcon('stop', 'Off', 'sb-off', () => off(), 'Clock out (O)');
    const aiBtn = withIcon('spark', 'Ask AI', 'sb-ai', () => toggleAi(), 'Ask AI: plain language or files (a schedule, a sheet, a photo) to changes (A)');
    // Breaks: each ends when the next entry starts. Phones show both; wide
    // screens one Break button (the kind used last) with ▾ for the other.
    const paidBtn = withIcon('cup', 'Paid', 'sb-break sb-paid', () => takeBreak('paid'), 'Paid break: counts toward hours and pay (/break-paid)');
    const unpaidBtn = withIcon('pause', 'Unpaid', 'sb-break sb-unpaid', () => takeBreak('unpaid'), 'Unpaid break: not counted, like Off (/break-unpaid)');
    const breakSplit = el('div', 'sb-split');
    const breakBtn = withIcon('cup', 'Break', 'sb-break sb-break-main', () => takeBreak(lastBreak()), 'Take a break');
    const breakMore = button('', 'sb-break sb-break-more', () => toggleBreakMenu(), 'Paid or unpaid break');
    breakMore.append(icon('down'));
    breakMore.setAttribute('aria-haspopup', 'menu');
    const breakMenu = el('div', 'sb-popup');
    breakMenu.hidden = true;
    breakMenu.setAttribute('role', 'menu');
    for (const [kind, label, ico] of [['paid', 'Paid break', 'cup'], ['unpaid', 'Unpaid break', 'pause']]) {
      const b = button('', 'sb-popup-item', () => { breakMenu.hidden = true; takeBreak(kind); });
      b.dataset.kind = kind;
      b.setAttribute('role', 'menuitem');
      b.append(icon(ico), el('span', null, label), el('span', 'sb-popup-hint', kind === 'paid' ? 'counts as time' : 'not counted'));
      breakMenu.append(b);
    }
    breakSplit.append(breakBtn, breakMore, breakMenu);
    const addMenu = el('div', 'sb-popup sb-addmenu');
    addMenu.hidden = true;
    addMenu.setAttribute('role', 'menu');
    const addItems = {};
    for (const [key, label, ico] of [['note', 'Note', 'note'], ['wo', 'Work order', 'hash'], ['eq', 'Equipment', 'tool'], ['files', 'Files', 'paperclip'], ['edit', 'Edit entry', 'pencil']]) {
      const b = button('', 'sb-popup-item', () => { toggleAddMenu(false); addTo(key); });
      b.setAttribute('role', 'menuitem');
      b.append(icon(ico), el('span', null, label), el('span', 'sb-popup-hint'));
      addItems[key] = b;
      addMenu.append(b);
    }
    bar.append(card, catWrap, title, doneBtn, paidBtn, unpaidBtn, breakSplit, offBtn, cancelBtn, resumeBtn, backBtn, newBtn, startBtn, menuBtn, aiBtn, addMenu);
    dockEl.insertBefore(bar, dockEl.querySelector('#status'));

    const BREAK_KEY = 'tymlee.lastBreak';
    function lastBreak() {
      try { return localStorage.getItem(BREAK_KEY) === 'unpaid' ? 'unpaid' : 'paid'; } catch (_) { return 'paid'; }
    }
    function takeBreak(kind) {
      try { localStorage.setItem(BREAK_KEY, kind); } catch (_) { /* fine */ }
      return opts.run(kind === 'paid' ? '/break-paid' : '/break-unpaid');
    }
    function toggleBreakMenu(show = breakMenu.hidden) {
      breakMenu.hidden = !show;
      breakMore.setAttribute('aria-expanded', String(show));
    }
    document.addEventListener('mousedown', (e) => { if (!breakSplit.contains(e.target)) toggleBreakMenu(false); });

    function toggleAddMenu(show = addMenu.hidden) {
      if (show && state) {
        // What's there already, as hints; a break has no work order or kit.
        const brk = Boolean(state.brk);
        addItems.wo.hidden = addItems.eq.hidden = brk;
        addItems.wo.querySelector('.sb-popup-hint').textContent = state.wo ? T.woTag(state.wo) : '';
        addItems.eq.querySelector('.sb-popup-hint').textContent = state.eq ? 'set' : '';
        // Under the +, kept inside the bar.
        const b = bar.getBoundingClientRect();
        const r = addBtn.getBoundingClientRect();
        addMenu.style.left = `${Math.max(8, Math.min(r.right - b.left - 220, b.width - 228))}px`;
        addMenu.style.right = 'auto';
      }
      addMenu.hidden = !show;
      addBtn.setAttribute('aria-expanded', String(show));
    }
    document.addEventListener('mousedown', (e) => { if (!addMenu.contains(e.target) && !addBtn.contains(e.target)) toggleAddMenu(false); });

    async function addTo(what) {
      const id = state && state.id;
      if (!id) return;
      if (what === 'note') {
        return form('Add a note', {
          intro: 'Goes on the running entry, as a new line.',
          fields: [{ name: 'text', label: 'Note', placeholder: 'client asked for a recut of reel 2' }], submit: 'Add',
        }, (v) => v.text && runMenu('Note', `/note ${v.text}`));
      }
      if (what === 'files') {
        return form('Add files', {
          intro: 'A folder, then the files in it; or full paths. They go on the running entry.',
          fields: [{ name: 'files', label: 'Files', placeholder: '/Volumes/Work/ mix.wav stems.zip' }], submit: 'Add',
        }, (v) => v.files && runMenu('Files', `/file ${v.files}`, { brief: true }));
      }
      if (what === 'edit') return opts.editEntry(id);
      const wo = what === 'wo';
      return form(wo ? 'Work order' : 'Equipment', {
        intro: `For the running entry only${wo ? ' (a work order linked to the category for the day is in Menu → Work orders)' : ''}. Leave it empty to clear it.`,
        fields: [{ name: 'v', label: wo ? 'Work order' : 'Equipment', value: wo ? state.wo : state.eq, placeholder: wo ? '4471' : 'ler-resolve-07' }],
        submit: 'Save',
      }, async (v) => {
        const err = await shell.setTags(id, wo ? { wo: v.v } : { eq: v.v });
        if (err) return toast(err, 'err');
        toast(v.v ? `${wo ? `Work order ${T.woTag(v.v.replace(/^\[|\]$/g, ''))}` : 'Equipment'} on this entry` : `${wo ? 'Work order' : 'Equipment'} cleared`, 'ok');
      });
    }

    function setComposing(on) {
      composing = on;
      if (!on) {
        cat.value = '';
        title.value = '';
        suggest.hidden = true;
      }
      if (state) update(state);
      if (on) cat.focus();
    }
    for (const f of [cat, title]) f.addEventListener('keydown', (e) => { if (e.key === 'Escape' && composing) setComposing(false); });

    async function resume() {
      if (!state || !state.last) return;
      await opts.run(state.last, { undo: true });
      flashStarted();
    }

    // "✓ Started" on the main button for a moment after something starts.
    let flashTimer = null;
    function flashStarted() {
      const label = newBtn.querySelector('.sb-label');
      clearTimeout(flashTimer);
      newBtn.classList.add('sb-flash');
      label.textContent = 'Started';
      newBtn.replaceChild(icon('check'), newBtn.firstChild);
      flashTimer = setTimeout(() => {
        newBtn.classList.remove('sb-flash');
        label.textContent = 'New task';
        newBtn.replaceChild(icon('swap'), newBtn.firstChild);
      }, 1200);
    }

    // Category suggestions: known categories, most recent first, matching
    // what's typed. Tap, or arrows and Enter.
    let pick = -1;
    function showSuggestions() {
      const typed = cat.value.trim().toLowerCase();
      const all = T.knownCategories(store.entries);
      const list = (typed ? all.filter((c) => c.toLowerCase().startsWith(typed) && c.toLowerCase() !== typed) : all).slice(0, 8);
      suggest.replaceChildren(...list.map((c, i) => {
        const o = el('div', `sb-opt${i === pick ? ' sel' : ''}`, c);
        o.setAttribute('role', 'option');
        o.addEventListener('mousedown', (e) => { e.preventDefault(); choose(c); });
        return o;
      }));
      suggest.hidden = !list.length || document.activeElement !== cat;
    }
    function choose(c) {
      cat.value = c;
      pick = -1;
      suggest.hidden = true;
      title.focus();
    }
    cat.addEventListener('focus', () => { pick = -1; showSuggestions(); });
    cat.addEventListener('blur', () => { suggest.hidden = true; });
    cat.addEventListener('input', () => {
      cat.value = cat.value.replace(/^\/+/, '').replace(/\s+/g, '-'); // one word, not a command
      pick = -1;
      showSuggestions();
    });
    cat.addEventListener('keydown', (e) => {
      const opts2 = [...suggest.children];
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && opts2.length) {
        e.preventDefault();
        pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + opts2.length) % opts2.length;
        showSuggestions();
      } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && opts2.length && pick >= 0)) {
        e.preventDefault();
        if (pick >= 0 && opts2[pick]) choose(opts2[pick].textContent);
        else if (e.key === 'Enter') title.focus();
      } else if (e.key === 'Escape') {
        suggest.hidden = true;
      }
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        start();
      }
    });

    async function start() {
      const c = cat.value.trim().replace(/^\/+/, '').replace(/\s+/g, '-');
      if (!c) {
        toast('Choose a category first', 'err');
        cat.focus();
        return;
      }
      const t = title.value.trim().replace(/\s+/g, ' ');
      cat.value = '';
      title.value = '';
      suggest.hidden = true;
      composing = false;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // phones: keyboard away
      await opts.run(t ? `${c} ${t}` : c, { undo: true });
      flashStarted();
    }

    function off() {
      composing = false;
      return opts.run('/off');
    }

    // Called every second with the status line's state.
    function update(st) {
      state = st;
      if (!active) return;
      showAiButton();
      updateTabs(st);
      const onBreak = Boolean(st.brk);
      const running = st.state === 'running' && !onBreak;
      if (!running && !onBreak) composing = false;
      const mode = composing ? 'compose' : onBreak ? 'break' : running ? 'running' : 'idle';
      if (bar.dataset.mode !== mode) bar.dataset.mode = mode;
      bar.dataset.todo = st.todo ? '1' : '0';
      // The card.
      if (mode === 'idle') {
        clock.textContent = st.state === 'idle' ? 'Nothing logged yet' : `Off since ${st.since}`;
        what.textContent = st.state === 'idle' ? 'type a category and what you are doing, then Start' : `${st.today}${st.last ? ` · last: ${st.last}` : ''}`;
      } else if (mode === 'break') {
        clock.textContent = st.clock;
        what.textContent = `${st.brk} break${st.last ? ` · was: ${st.last}` : ''}`;
      } else {
        clock.textContent = mode === 'compose' ? `now ${st.clock}` : st.clock;
        what.replaceChildren();
        if (st.wo) what.append(el('span', 'sb-wo', T.woTag(st.wo)), ' ');
        what.append(el('b', null, st.category), st.note ? ` ${st.note}` : '');
      }
      tdTag.textContent = mode === 'running' && st.todo ? st.todo.tag : '';
      // Buttons.
      doneBtn.disabled = !st.todo;
      paidBtn.classList.toggle('on', st.brk === 'paid');
      unpaidBtn.classList.toggle('on', st.brk === 'unpaid');
      paidBtn.disabled = st.brk === 'paid';
      unpaidBtn.disabled = st.brk === 'unpaid';
      const next = lastBreak();
      breakBtn.querySelector('.sb-label').textContent = onBreak ? `${st.brk === 'paid' ? 'Paid' : 'Unpaid'} break` : 'Break';
      breakBtn.disabled = onBreak;
      breakBtn.title = onBreak ? 'On a break (Shift+B switches kind)' : `${next === 'paid' ? 'Paid' : 'Unpaid'} break (B; Shift+B for ${next === 'paid' ? 'unpaid' : 'paid'})`;
      breakBtn.replaceChild(icon(onBreak ? (st.brk === 'paid' ? 'cup' : 'pause') : next === 'paid' ? 'cup' : 'pause'), breakBtn.firstChild);
      for (const b of breakMenu.children) b.disabled = b.dataset.kind === st.brk;
      resumeBtn.disabled = !st.last;
      resumeBtn.title = st.last ? `Start again: ${st.last} (R)` : 'Nothing to resume yet';
      backBtn.title = st.last ? `Back to: ${st.last} (R)` : 'End the break';
      startBtn.querySelector('.sb-label').textContent = mode === 'compose' ? 'Switch' : 'Start';
      startBtn.title = mode === 'compose' ? 'End what is running and start this (Enter)' : 'Start this entry (Enter)';
      startBtn.replaceChild(icon(mode === 'compose' ? 'swap' : 'play'), startBtn.firstChild);
      const dockH = `${dockEl.offsetHeight}px`;
      if (appEl.style.getPropertyValue('--dock-h') !== dockH) appEl.style.setProperty('--dock-h', dockH);
    }

    // ---- tab bar (phones) ----------------------------------------------------------
    // On a phone the GUI view's bottom row is a tab bar, like an app's:
    // Timeline (back to today, sheets closed), To-do, Find and Menu. The clock
    // and view switches move into Menu → View.
    const tabbar = el('nav', 'tabbar');
    tabbar.setAttribute('aria-label', 'Sections');
    tabbar.hidden = true;
    const tabs = {};
    for (const [key, label, ico, run] of [
      ['timeline', 'Timeline', 'clock', () => { closeSheet(); closeAi(); opts.home(); }],
      ['todo', 'To-do', 'check', () => todoSheet()],
      ['ai', 'AI', 'spark', () => toggleAi()],
      ['find', 'Find', 'search', () => findForm()],
      ['menu', 'Menu', 'menu', () => openMenu()],
    ]) {
      // A second tap on the lit tab closes its panel.
      const b = button('', 'tab', () => (key !== 'timeline' && b.getAttribute('aria-current') === 'true' ? (aiOpen() ? closeAi() : closeSheet()) : run()), label);
      b.dataset.tab = key;
      b.append(icon(ico), el('span', 'tab-label', label), el('span', 'tab-badge'));
      tabs[key] = b;
      tabbar.append(b);
    }
    dockEl.append(tabbar);
    function markTab() {
      const now = !sheetName ? (aiOpen() ? 'ai' : 'timeline') : sheetName === 'Menu' ? 'menu' : (sheetName.startsWith('To-do') || sheetName === 'Done') ? 'todo' : sheetName === 'Find' ? 'find' : sheetName === 'Set up AI' ? 'ai' : '';
      for (const [k, b] of Object.entries(tabs)) b.setAttribute('aria-current', String(k === now));
    }
    // AI shows only once it's set up (a key, here or synced from another
    // device); until then it is one item in Menu → View.
    function showAiButton() {
      const on = shell.ai.ready() ? '1' : '0';
      if (bar.dataset.ai === on) return;
      bar.dataset.ai = tabbar.dataset.ai = on;
      aiBtn.hidden = tabs.ai.hidden = on === '0';
      if (on === '0') closeAi();
    }
    function updateTabs(st) {
      const due = st.due || 0;
      tabs.todo.querySelector('.tab-badge').textContent = due ? String(due) : '';
      const bad = ['error', 'offline', 'locked'].includes(st.sync && st.sync.status);
      tabs.menu.querySelector('.tab-badge').textContent = bad ? '!' : '';
      tabs.menu.title = bad ? `Menu · ${st.sync.label}` : 'Menu';
    }

    // ---- keyboard shortcuts ------------------------------------------------------
    // Single keys, in the GUI view, when not typing in a field and nothing is
    // open over the timeline. Each button's tooltip names its key.
    const SHORTCUTS = [
      ['N', 'New task (or the fields, when nothing runs)'],
      ['B', 'Break, the kind used last'],
      ['Shift+B', 'Break, the other kind'],
      ['O', 'Off'],
      ['D', 'Done: the to-do being worked on'],
      ['R', 'Resume, or back to work after a break'],
      ['A', 'Ask AI (Esc closes it)'],
      ['+', 'Add a note, work order, equipment or files to the running entry'],
      ['/', 'Find'],
      ['?', 'This list'],
      ['Enter / Esc', 'In the fields: start / cancel'],
      ['Ctrl+Z', 'Undo'],
    ];
    function showShortcuts() {
      const list = el('div', 'gkeys');
      for (const [k, what] of SHORTCUTS) if (k !== 'A' || shell.ai.ready()) list.append(el('kbd', null, k), el('span', null, what));
      sheet('Keyboard shortcuts', list);
    }
    document.addEventListener('keydown', (e) => {
      if (!active || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable], .entry-card')) return;
      if (e.key === 'Escape' && sheetEl) { e.preventDefault(); closeSheet(); return; }
      if (sheetEl || document.querySelector('.entry-card')) return;
      const k = e.key;
      if (k === 'Escape' && !addMenu.hidden) { e.preventDefault(); toggleAddMenu(false); return; }
      if (k === 'Escape' && aiOpen()) { e.preventDefault(); closeAi(); return; }
      const mode = bar.dataset.mode;
      const visible = (b) => b.offsetParent !== null && !b.disabled;
      let act = null;
      if (k === 'n' || k === 'N') act = () => (mode === 'idle' ? cat.focus() : visible(newBtn) && setComposing(true));
      else if (k === 'b' && (mode === 'running' || mode === 'break')) act = () => takeBreak(state && state.brk === lastBreak() ? (lastBreak() === 'paid' ? 'unpaid' : 'paid') : lastBreak());
      else if (k === 'B' && (mode === 'running' || mode === 'break')) act = () => takeBreak(lastBreak() === 'paid' ? 'unpaid' : 'paid');
      else if ((k === 'o' || k === 'O') && visible(offBtn)) act = () => off();
      else if ((k === 'd' || k === 'D') && state && state.todo) act = () => opts.run('/done');
      else if ((k === 'r' || k === 'R') && (visible(resumeBtn) || visible(backBtn))) act = () => resume();
      else if (k === '/') act = () => findForm();
      else if ((k === 'a' || k === 'A') && shell.ai.ready()) act = () => toggleAi();
      else if ((k === '+' || k === '=') && (mode === 'running' || mode === 'break')) act = () => toggleAddMenu();
      else if (k === '?') act = () => showShortcuts();
      if (!act) return;
      e.preventDefault();
      act();
    });

    // ---- toasts --------------------------------------------------------------

    const toasts = el('div', 'toasts');
    toasts.setAttribute('aria-live', 'polite');
    appEl.append(toasts);

    // A toast with an action (Undo) stays 8 seconds, with a line counting
    // down; pointing at it pauses the count. Others go after 4 (errors 6).
    function toast(text, cls = '', action) {
      const t = el('div', `toast ${cls}`);
      t.append(el('span', null, text));
      const leave = () => {
        t.classList.add('out');
        setTimeout(() => t.remove(), 400);
      };
      if (action) {
        t.classList.add('has-action');
        t.append(button(action.label, 'toast-action', () => { t.remove(); action.run(); }));
        const timer = el('span', 'toast-timer');
        const fill = el('i');
        timer.append(fill);
        fill.addEventListener('animationend', leave);
        t.append(timer);
      } else {
        setTimeout(leave, cls.includes('err') ? 6000 : 4000);
      }
      toasts.append(t);
      while (toasts.children.length > 3) toasts.firstChild.remove();
    }

    // ---- sheets --------------------------------------------------------------
    // A panel over the timeline: a bottom sheet on phones, a dialog on wider
    // screens. Closes with ✕, Esc or a tap outside.

    let sheetEl = null;
    let sheetName = '';
    function closeSheet() {
      if (!sheetEl) return;
      const s = sheetEl;
      sheetEl = null;
      sheetName = '';
      markTab();
      s.remove();
    }
    // A panel above the start bar, like Ask AI: menus, forms, lists and
    // reports. One at a time (it replaces Ask AI's while open, which keeps its
    // draft). Closes with ✕ or Esc.
    function sheet(heading, ...content) {
      closeSheet();
      closeAi();
      if (opts.closeEntry) opts.closeEntry();
      const wrap = el('div', 'gsheet-wrap gpanel');
      const panel = el('div', 'gsheet');
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', heading);
      const head = el('div', 'gsheet-head');
      const close = button('', 'gsheet-close', closeSheet, 'Close (Esc)');
      close.append(icon('x'));
      head.append(el('span', 'gsheet-title', heading), close);
      const body = el('div', 'gsheet-body');
      body.append(...content);
      panel.append(head, body);
      wrap.append(panel);
      wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSheet(); } });
      dragDown(panel, body, closeSheet);
      dockEl.insertBefore(wrap, aiPanel);
      sheetEl = wrap;
      sheetName = heading;
      markTab();
      return panel;
    }

    // Phones: pull a panel down to close it, from anywhere while its content
    // is scrolled to the top. It follows the finger and springs back if not
    // pulled far enough.
    function dragDown(panel, body, close) {
      let drag = null;
      panel.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1 || body.scrollTop > 0 || e.target.closest('input, textarea, select')) return;
        drag = { y: e.touches[0].clientY, t: Date.now(), dy: 0 };
      }, { passive: true });
      panel.addEventListener('touchmove', (e) => {
        if (!drag) return;
        const dy = e.touches[0].clientY - drag.y;
        if (dy < 0 && !drag.dy) { drag = null; return; } // scrolling up: not a pull
        drag.dy = Math.max(0, dy);
        panel.style.transition = 'none';
        panel.style.transform = `translateY(${drag.dy}px)`;
        if (drag.dy > 4) e.preventDefault();
      }, { passive: false });
      panel.addEventListener('touchend', () => {
        if (!drag) return;
        const { dy, t } = drag;
        drag = null;
        panel.style.transition = '';
        const fast = dy > 40 && dy / Math.max(1, Date.now() - t) > 0.5;
        if (dy > 110 || fast) {
          panel.style.transform = 'translateY(100%)';
          close();
        } else {
          panel.style.transform = '';
        }
      });
    }
    // Printed output in a sheet; reports keep their columns when they wrap.
    function textSheet(heading, items) {
      const pres = items.map((it) => el('pre', `gsheet-text ${it.cls || ''}`, it.text));
      sheet(heading, ...pres);
      items.forEach((it, i) => { if (/\breport\b/.test(it.cls || '')) opts.formatReport(pres[i], it.text); });
    }

    // A list of tick boxes. rows() -> [{ label, sub, done }]; onToggle(row,
    // done) saves a tick, and the list is shown again. `more` adds buttons.
    function tickSheet(heading, rows, onToggle, more = [], empty = 'Nothing here yet.', count = true) {
      const list = el('div', 'gtick');
      const panel = sheet(heading, list, ...(more.length ? [el('div', 'gtick-more')] : []));
      if (more.length) panel.querySelector('.gtick-more').append(...more.map(([label, run]) => button(label, 'gform-range', run)));
      const render = () => {
        list.replaceChildren();
        const shown = rows();
        for (const r of shown) {
          const row = el('label', `gtick-row${r.done ? ' done' : ''}${r.now ? ' now' : ''}${r.late ? ' late' : ''}`);
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = Boolean(r.done);
          box.addEventListener('change', () => { onToggle(r, box.checked); render(); });
          const words = el('span', 'gtick-words');
          words.append(el('span', 'gtick-text', r.label));
          if (r.sub) words.append(el('span', 'gtick-sub', r.sub));
          row.append(box, words);
          if (r.play) {
            const go = button('', 'gtick-play', (e) => { e.preventDefault(); r.play(); render(); });
            go.append(icon('play'));
            go.setAttribute('aria-label', `Start: ${r.label}`);
            go.title = 'Start a timer for this';
            row.append(go);
          }
          list.append(row);
        }
        if (!shown.length) list.append(el('p', 'gform-intro', empty));
        const done = shown.filter((r) => r.done).length;
        panel.querySelector('.gsheet-title').textContent = !shown.length ? heading : count ? `${heading} · ${done}/${shown.length}` : `${heading} · ${shown.length}`;
      };
      render();
    }

    // The to-do list: the open ones, the soonest due first. Done ones are
    // archived (Done, at the bottom); one ticked off here stays, struck
    // through, until the sheet closes, so a mis-tap can be unticked. ▶ starts
    // a timer for one; ticking it off leaves the timer running.
    function todoSheet() {
      const ticked = new Set();
      const archived = shell.todoList().filter((t) => t.done).length;
      tickSheet('To-do', () => {
        const now = Date.now();
        const running = shell.runningTodoId();
        const order = (t) => (t.done ? 2 : t.due ? 0 : 1);
        return shell.todoList()
          .filter((t) => !t.done || ticked.has(t.id))
          .sort((a, b) => order(a) - order(b) || (!a.done && a.due && b.due ? a.due.localeCompare(b.due) : 0) || a.sid - b.sid)
          .map((t) => {
            const due = !t.done && t.due ? T.dueLabel(t.due, now) : null;
            const sub = [t.tag, t.category, due && due.text, t.id === running && 'working on it now'].filter(Boolean).join(' · ');
            return { id: t.id, label: t.note || t.category, sub, done: t.done, now: t.id === running, late: Boolean(due && due.late),
              play: t.done || t.id === running ? null : () => shell.doTodo(t.id) };
          });
      },
      (r, done) => { if (done) ticked.add(r.id); shell.setTodoDone(r.id, done); },
      [['Add a to-do', () => addTodoForm()], ...(archived ? [[`Done · ${archived}`, () => doneSheet()]] : [])],
      'Nothing to do.');
    }

    // The archive of done to-dos, the latest first. Unticking one opens it
    // again (it stays here until the sheet closes).
    function doneSheet() {
      const reopened = new Set();
      tickSheet('Done', () => shell.todoList()
        .filter((t) => t.done || reopened.has(t.id))
        .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
        .map((t) => ({
          id: t.id,
          label: t.note || t.category,
          sub: [t.tag, t.category, t.done && t.doneAt && `done ${new Date(t.doneAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`].filter(Boolean).join(' · '),
          done: t.done,
        })),
      (r, done) => { if (!done) reopened.add(r.id); shell.setTodoDone(r.id, done); },
      [['Back to the list', () => todoSheet()]],
      'Nothing done yet.', false);
    }

    function addTodoForm() {
      form('Add a to-do', {
        fields: [
          { name: 'category', label: 'Category', placeholder: 'dev' },
          { name: 'text', label: 'What to do', placeholder: 'fix the login bug' },
          { name: 'due', label: 'Due (optional)', type: 'date' },
        ],
        submit: 'Add',
      }, async (v) => {
        if (!v.category) return;
        await opts.run(`/todo ${v.category.trim().replace(/\s+/g, '-')} ${v.text || ''}${v.due ? ` due:${v.due}` : ''}`);
        todoSheet();
      });
    }

    function runSheet(id) {
      const run = () => shell.checkRuns().find((r) => r.id === id);
      const r0 = run();
      if (!r0) return toast('That checklist was deleted.', 'dim');
      tickSheet(`${r0.tag} ${r0.title}`, () => (run() ? run().items.map((it, i) => ({ i, label: it.text, done: it.done })) : []),
        (r, done) => shell.setCheckItem(id, r.i, done));
    }

    function startChecklistForm() {
      const names = shell.checklistNames();
      if (!names.length) return toast('No checklists yet. Choose New checklist to make one.', 'dim');
      form('Start a checklist', {
        fields: [
          { name: 'name', label: 'Checklist', choices: names.map((n) => [n, n]) },
          { name: 'label', label: 'For (optional)', placeholder: 'Project X' },
        ],
        submit: 'Start',
      }, (v) => {
        const run = shell.startCheckRun(v.name, v.label || '');
        if (run) runSheet(run.id);
      });
    }

    function openChecklists() {
      const list = shell.checkRuns().slice().reverse();
      if (!list.length) return toast('No checklists started yet.', 'dim');
      const f = el('div', 'gtick');
      for (const r of list) {
        const b = button('', 'gtick-row gtick-open', () => runSheet(r.id));
        const words = el('span', 'gtick-words');
        words.append(el('span', 'gtick-text', r.title), el('span', 'gtick-sub', `${r.tag} · ${r.ticked}/${r.items.length}${r.ticked === r.items.length ? ' · done' : ''}`));
        b.append(words);
        f.append(b);
      }
      sheet('Checklists', f);
    }

    // A small form: fields [{ name, label, value, type, placeholder }], then
    // onSubmit(values). A range picker when `range` is set.
    function form(heading, { intro, fields = [], range, submit, danger }, onSubmit) {
      const f = el('form', 'gform');
      if (intro) f.append(el('p', 'gform-intro', intro));
      const inputs = {};
      const picked = {};
      for (const fd of fields) {
        if (fd.choices) {
          // A few buttons, one pressed.
          const row = el('div', 'gform-ranges');
          picked[fd.name] = fd.value || fd.choices[0][0];
          for (const [key, text] of fd.choices) {
            const b = button(text, 'gform-range', () => {
              picked[fd.name] = key;
              for (const x of row.children) x.setAttribute('aria-pressed', String(x === b));
            });
            b.setAttribute('aria-pressed', String(key === picked[fd.name]));
            row.append(b);
          }
          const label = el('div', 'gform-field');
          label.append(el('span', null, fd.label), row);
          f.append(label);
          continue;
        }
        const label = el('label', 'gform-field');
        const input = el('input');
        input.type = fd.type || 'text';
        input.name = fd.name;
        input.value = fd.value == null ? '' : fd.value;
        if (fd.placeholder) input.placeholder = fd.placeholder;
        if (fd.step) input.step = fd.step;
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocapitalize', 'off');
        label.append(el('span', null, fd.label), input);
        f.append(label);
        inputs[fd.name] = input;
      }
      let chosenRange = 'today';
      if (range) {
        const row = el('div', 'gform-ranges');
        for (const [key, label] of RANGES) {
          const b = button(label, 'gform-range', () => {
            chosenRange = key;
            for (const x of row.children) x.setAttribute('aria-pressed', String(x === b));
          });
          b.setAttribute('aria-pressed', String(key === chosenRange));
          row.append(b);
        }
        f.append(row);
      }
      const go = el('button', `gform-go${danger ? ' danger' : ''}`, submit || 'OK');
      go.type = 'submit';
      f.append(go);
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const values = { range: chosenRange, ...picked };
        for (const [k, input] of Object.entries(inputs)) values[k] = input.value.trim();
        closeSheet();
        onSubmit(values);
      });
      sheet(heading, f);
      const first = f.querySelector('input');
      if (first && !window.matchMedia('(pointer: coarse)').matches) first.focus();
    }

    // ---- running commands from the menu -----------------------------------------

    // Run command lines one after another; show what they printed: a sheet
    // for anything long, a toast for a line or two.
    // brief: only each message's last line, as a toast (no sheet).
    async function runMenu(heading, lines, { brief = false } = {}) {
      capture = [];
      try {
        for (const line of [].concat(lines)) await opts.run(line);
      } finally {
        const got = capture;
        capture = null;
        if (brief) {
          for (const g of got) toast(g.text.split('\n').pop(), g.cls);
        } else if (got.some((g) => /\b(report|key)\b/.test(g.cls) || g.text.includes('\n'))) {
          textSheet(heading, got);
        } else {
          for (const g of got) toast(g.text, g.cls);
        }
      }
    }

    // Printed output while the GUI view shows. Returns true when handled.
    function output(text, cls = '') {
      if (!active) return false;
      if (/\becho\b/.test(cls)) return true;
      if (capture) {
        capture.push({ text, cls });
        return true;
      }
      if (/\b(report|key)\b/.test(cls) || text.includes('\n')) textSheet(/\bkey\b/.test(cls) ? 'Encryption' : 'tymlee', [{ text, cls }]);
      else toast(text, cls, lastStart && /\bin ID:\d+/.test(text) ? { label: 'Undo', run: () => opts.run('/undo') } : null);
      return true;
    }
    let lastStart = false;

    // ---- the menu ------------------------------------------------------------

    function money(key) {
      const pay = (store.settings && store.settings.pay) || {};
      const v = T.payValue(pay, key, Date.now());
      return v == null ? '' : String(v);
    }

    // ---- forms ---------------------------------------------------------------

    function pickForm(heading, submit, then, danger) {
      const names = shell.formNames();
      form(heading, { fields: [{ name: 'name', label: 'Form', choices: names.map((n) => [n, n]) }], submit, danger }, (v) => then(v.name));
    }

    // Choose the form and day, answer its questions (if it has any), then
    // show it filled in.
    function fillInForm() {
      const names = shell.formNames();
      if (!names.length) return toast('No forms yet. Choose New form to make one.', 'dim');
      form('Fill in a form', {
        fields: [
          { name: 'name', label: 'Form', choices: names.map((n) => [n, n]) },
          { name: 'day', label: 'Day (leave empty for today)', placeholder: 'tue or 2026-09-29' },
        ],
        submit: 'Next',
      }, (v) => {
        const day = (v.day || 'today').trim();
        const line = `/form ${v.name} ${day}`;
        const questions = shell.formQuestions(v.name, day);
        if (!questions) return;
        if (!questions.length) return runMenu(v.name, line);
        form(v.name, {
          fields: questions.map((q, i) => ({ name: `q${i}`, label: q.where ? `${q.label} for ${q.where}` : q.label, value: q.last })),
          submit: 'Fill in',
        }, (a) => {
          shell.presetAnswers(questions.map((q, i) => a[`q${i}`] || ''));
          runMenu(v.name, line);
        });
      });
    }

    // Accent colors: a swatch each, and any color from the system picker.
    // Saved with the account's settings, so every device gets it.
    function accentSheet() {
      const current = (store.settings && store.settings.accent) || T.DEFAULT_ACCENT;
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const grid = el('div', 'gaccent');
      const pick = async (value) => {
        await opts.run(`/accent ${value}`);
        accentSheet();
      };
      for (const name of Object.keys(T.ACCENTS)) {
        const c = T.accentColors(name);
        const b = button('', `gaccent-swatch${name === current ? ' on' : ''}`, () => pick(name), name);
        b.style.setProperty('--sw', dark ? c.dark.accent : c.light.accent);
        b.append(el('span', 'gaccent-dot'), el('span', null, name));
        grid.append(b);
      }
      const custom = el('label', `gaccent-swatch gaccent-custom${current.startsWith('#') ? ' on' : ''}`);
      const input = el('input');
      input.type = 'color';
      input.value = current.startsWith('#') ? current : T.accentColors(current).light.accent;
      input.addEventListener('change', () => pick(input.value));
      custom.append(input, el('span', null, current.startsWith('#') ? current : 'Custom…'));
      grid.append(custom);
      const reset = el('p', 'gform-intro', 'Saved with your settings, so it follows you to every device. Light and dark screens each get a shade that reads well.');
      sheet('Accent color', grid, reset);
    }

    // ---- Ask AI ----------------------------------------------------------------

    // Run something without its console messages showing (the GUI says it
    // its own way). Errors still show.
    async function quietly(fn) {
      capture = [];
      try {
        return await fn();
      } finally {
        const got = capture;
        capture = null;
        for (const g of got) if (/\berr\b/.test(g.cls)) toast(g.text, g.cls);
      }
    }
    // Type what happened (or attach files: a schedule, a sheet, a photo); Claude answers with
    // changes, shown here; Apply makes them (Undo in the toast takes them back).

    function aiSetup() {
      const models = shell.ai.models();
      form('Set up AI', {
        intro: 'tymlee uses your own Claude API key: create one at console.anthropic.com (set a monthly limit there). It is kept with your encrypted settings, on your devices only. Usage is billed to you: about 0.1¢ a request on Haiku, 1¢ on Opus.',
        fields: [
          { name: 'key', label: 'API key', type: 'password', placeholder: 'sk-ant-…' },
          { name: 'model', label: 'Model', choices: models, value: shell.ai.modelKey() },
        ],
        submit: 'Save',
      }, async (v) => {
        if (!v.key) return;
        await quietly(async () => { await opts.run(`/aikey ${v.key}`); await opts.run(`/aimodel ${v.model}`); });
        showAiButton();
        if (shell.ai.ready()) {
          toast(`AI is set up · ${shell.ai.model()}`, 'ok');
          setTimeout(openAi, 200);
        }
      });
    }

    // Ask AI is a panel above the start bar, not a sheet: the timeline stays
    // in view. It keeps what was typed and attached while closed.
    const aiPanel = el('div', 'aipanel');
    aiPanel.hidden = true;
    aiPanel.setAttribute('role', 'region');
    aiPanel.setAttribute('aria-label', 'Ask AI');
    const aiHead = el('div', 'aip-head');
    const aiModel = el('select', 'aip-model');
    aiModel.setAttribute('aria-label', 'Model');
    aiModel.title = 'Model (billed to your API key)';
    aiModel.addEventListener('change', () => quietly(() => opts.run(`/aimodel ${aiModel.value}`)));
    const aiClose = button('', 'aip-close', () => closeAi(), 'Close (Esc); the chat stays');
    aiClose.append(icon('x'));
    const aiNew = button('', 'aip-new', () => { aiReset(); focusAi(); }, 'New chat');
    aiNew.append(icon('plus'));
    const aiTitle = el('span', 'aip-title');
    aiTitle.append(icon('spark'), el('span', null, 'Ask AI'));
    aiHead.append(aiTitle, aiModel, aiNew, aiClose);
    const aiBody = el('div', 'aip-body');
    aiPanel.append(aiHead, aiBody);
    aiPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeAi(); } });
    
    dockEl.insertBefore(aiPanel, bar);
    // Toasts sit just above the dock, which grows with an open panel.
    if (window.ResizeObserver) new ResizeObserver(() => appEl.style.setProperty('--dock-h', `${dockEl.offsetHeight}px`)).observe(dockEl);

    // A chat: what you wrote on the right, Claude's answers on the left, each
    // with its changes; the latest has Apply. Replying refines it (Claude
    // answers with the whole revised set). Applying closes the panel and
    // starts a new chat; ✕ keeps it for later.
    const aiThread = el('div', 'chat');
    aiThread.setAttribute('aria-live', 'polite');
    const aiText = el('textarea', 'chat-input');
    aiText.rows = 1;
    aiText.setAttribute('aria-label', 'Message');
    aiText.enterKeyHint = 'send';
    // Enter sends; Shift+Enter is a new line. It grows with what's typed.
    aiText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); aiSend(); } });
    aiText.addEventListener('input', () => fitAiText());
    function fitAiText() {
      aiText.style.height = 'auto';
      aiText.style.height = `${Math.min(aiText.scrollHeight + 2, 140)}px`;
    }
    let aiFiles = []; // attached, not yet sent
    let aiSent = []; // sent in this chat (they go along with every turn)
    let aiBusy = 0; // which request is on its way (0: none)
    let aiHistory = []; // the turns so far, for Claude: [{ text, reply }]
    const aiChips = el('div', 'gai-chips');
    function pickAiFiles(camera = false) {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.hidden = true;
      if (camera) {
        picker.accept = 'image/*';
        picker.setAttribute('capture', 'environment');
      } else {
        picker.multiple = true;
      }
      picker.addEventListener('change', async () => {
        const list = [...(picker.files || [])];
        picker.remove();
        const max = shell.ai.maxFiles();
        const bad = [];
        for (const file of list) {
          if (aiFiles.length + aiSent.length >= max) { bad.push(`${max} files at most in a chat`); break; }
          // Photos are shrunk first (and HEIC becomes JPEG), so check after.
          const quick = !/^image\//.test(file.type) && shell.ai.check({ name: file.name, type: file.type, size: file.size });
          if (quick) { bad.push(quick); continue; }
          const f = await opts.readAiFile(file);
          const why = shell.ai.check({ name: f.name, type: f.type, size: f.bytes.length });
          if (why) { bad.push(why); continue; }
          aiFiles.push(f);
        }
        drawAiChips();
        if (bad.length) toast(bad.join(' · '), 'err');
        focusAi();
      });
      document.body.append(picker);
      picker.click();
    }
    const aiAttach = button('', 'chat-tool gai-attach', () => pickAiFiles(), 'Attach files: a schedule, a sheet, a document or a photo');
    aiAttach.append(icon('paperclip'));
    // Phones: straight to the camera (a page of notes, a schedule on a wall).
    const aiPhoto = button('', 'chat-tool gai-photo', () => pickAiFiles(true), 'Take a photo');
    aiPhoto.append(icon('camera'));
    const aiGo = button('', 'chat-send gai-go', () => aiSend(), 'Send (Enter)');
    aiGo.append(icon('up'));
    const aiCompose = el('div', 'chat-compose');
    const aiRow = el('div', 'chat-row');
    aiRow.append(aiAttach, aiPhoto, aiText, aiGo);
    aiCompose.append(aiChips, aiRow);
    aiBody.append(aiThread, aiCompose);
    dragDown(aiPanel, aiThread, () => { closeAi(); aiPanel.style.transform = ''; });

    function drawAiChips() {
      aiChips.replaceChildren();
      aiChips.hidden = !aiFiles.length;
      aiFiles.forEach((f, i) => {
        const chip = el('div', 'gai-chip');
        const x = button('', 'gai-chip-x', () => { aiFiles.splice(i, 1); drawAiChips(); }, `Remove ${f.name}`);
        x.append(icon('x'));
        chip.append(icon('paperclip'), el('span', null, f.name), x);
        aiChips.append(chip);
      });
      aiAttach.disabled = aiPhoto.disabled = aiFiles.length + aiSent.length >= shell.ai.maxFiles();
    }
    function drawAi() {
      aiNew.hidden = !aiHistory.length && !aiBusy;
      aiText.placeholder = aiHistory.length ? 'Reply…' : 'Message…';
      aiThread.hidden = !aiThread.children.length;
      aiThread.scrollTop = aiThread.scrollHeight;
    }
    // A new chat, empty.
    function aiReset() {
      aiBusy = 0;
      aiHistory = [];
      aiSent = [];
      aiFiles = [];
      aiText.value = '';
      aiThread.replaceChildren();
      fitAiText();
      drawAiChips();
      drawAi();
    }
    aiReset();
    function focusAi() { if (!window.matchMedia('(pointer: coarse)').matches) aiText.focus(); }

    function aiOpen() { return !aiPanel.hidden; }
    function openAi() {
      if (!shell.ai.ready()) return aiSetup();
      closeSheet();
      if (opts.closeEntry) opts.closeEntry();
      aiModel.replaceChildren(...shell.ai.models().map(([k, label]) => {
        const o = el('option', null, label.replace(/^Claude /, ''));
        o.value = k;
        return o;
      }));
      aiModel.value = shell.ai.modelKey();
      aiPanel.hidden = false;
      aiBtn.setAttribute('aria-pressed', 'true');
      markTab();
      drawAi();
      focusAi();
    }
    function closeAi() {
      if (aiPanel.hidden) return;
      aiPanel.hidden = true;
      aiBtn.setAttribute('aria-pressed', 'false');
      markTab();
    }
    function toggleAi() { return aiOpen() ? closeAi() : openAi(); }

    function bubble(who, ...content) {
      const b = el('div', `chat-msg ${who}`);
      b.append(...content);
      aiThread.hidden = false;
      aiThread.append(b);
      aiThread.scrollTop = aiThread.scrollHeight;
      return b;
    }

    async function aiSend() {
      if (aiBusy) return;
      const words = aiText.value.trim();
      const fresh = aiFiles;
      if (!words && !fresh.length) { aiText.focus(); return; }
      // What was written, as sent.
      const mine = [];
      if (words) mine.push(el('div', 'chat-text', words));
      if (fresh.length) {
        const chips = el('div', 'chat-files');
        for (const f of fresh) { const c = el('span', 'chat-file'); c.append(icon('paperclip'), el('span', null, f.name)); chips.append(c); }
        mine.push(chips);
      }
      bubble('me', ...mine);
      aiSent = [...aiSent, ...fresh];
      aiFiles = [];
      aiText.value = '';
      fitAiText();
      drawAiChips();
      // The answer before is no longer the one to apply.
      for (const b of aiThread.querySelectorAll('.chat-apply')) b.remove();
      for (const b of aiThread.querySelectorAll('.chat-msg.ai .gai-list')) b.classList.add('old');
      const ticket = Date.now();
      aiBusy = ticket;
      const wait = bubble('ai wait', el('span', 'chat-dots', ''));
      wait.setAttribute('aria-label', `${shell.ai.model()} is answering`);
      drawAi();
      const r = await shell.ai.ask({ text: words, files: aiSent, history: aiHistory });
      if (aiBusy !== ticket) return; // a new chat meanwhile
      aiBusy = 0;
      wait.remove();
      if (r.error) {
        bubble('ai err', el('div', 'chat-text', r.error));
        drawAi();
        return;
      }
      aiHistory = [...aiHistory, r.turn];
      showPlan(r);
      drawAi();
      focusAi();
    }

    // Claude's answer: its note and the changes, with Apply on the latest.
    function showPlan(r) {
      const { plan } = r;
      const out = [];
      if (r.message) out.push(el('div', 'chat-text', r.message));
      const list = el('div', 'gai-list');
      for (const line of plan.preview) {
        const kind = line.startsWith('+') ? 'add' : line.startsWith('~') ? 'edit' : line.startsWith('-') ? 'del' : 'other';
        const rowEl = el('div', `gai-change ${kind}`);
        rowEl.append(el('span', 'gai-mark', { add: '+', edit: '~', del: '−', other: '•' }[kind]), el('span', null, kind === 'other' ? line : line.slice(2)));
        list.append(rowEl);
      }
      for (const x of plan.skipped) list.append(el('div', 'gai-change skipped', `skipped: ${x}`));
      if (plan.preview.length || plan.skipped.length) out.push(list);
      if (!r.message && !plan.preview.length) out.push(el('div', 'chat-text', 'No changes.'));
      if (plan.preview.length) {
        const n = plan.preview.length;
        const apply = button('', 'chat-apply gai-go', async () => {
          // Done: the panel closes and the next chat starts empty.
          aiReset();
          closeAi();
          await quietly(() => shell.ai.apply(plan));
          toast(`Applied ${n} change${n === 1 ? '' : 's'}`, 'ok', plan.ops.length ? { label: 'Undo', run: async () => { await quietly(() => shell.ai.undo()); toast('Undone', 'dim'); } } : null);
        });
        apply.append(icon('check'), el('span', null, `Apply ${n === 1 ? '1 change' : `${n} changes`}`));
        out.push(apply);
      }
      bubble('ai', ...out);
    }

    function findForm() {
      form('Find', {
        intro: 'Searches entry text, notes, file paths, work orders, equipment and to-dos.',
        fields: [{ name: 'q', label: 'Words', placeholder: 'stems label' }], submit: 'Find',
      }, (v) => v.q && runMenu('Find', `/find ${v.q}`));
    }

    function menuItems() {
      const signedIn = Boolean(store.user);
      const enc = store.encryption;
      const show = (heading, cmd) => form(heading, { range: true, submit: 'Show' }, (v) => runMenu(heading, `${cmd} ${v.range}`));
      return [
        ['Entries', [
          ['Paid break', () => runMenu('Break', '/break-paid')],
          ['Unpaid break', () => runMenu('Break', '/break-unpaid')],
          ['Add a note', () => form('Add a note', {
            intro: 'Goes on the current entry, as a new line.',
            fields: [{ name: 'text', label: 'Note', placeholder: 'called the client back' }], submit: 'Add',
          }, (v) => v.text && runMenu('Note', `/note ${v.text}`))],
          ['Edit entries', () => opts.openCli('/edit')],
        ]],
        ['Search', [
          ['Find', () => findForm()],
        ]],
        ['Reports', [
          ['Log', () => show('Log', '/log')],
          ['Categories', () => show('Categories', '/report')],
          ['Work orders', () => show('Work orders', '/wolist')],
          ['Export', () => form('Export', {
            range: true,
            fields: [{ name: 'format', label: 'Format', choices: [['txt', 'Text'], ['csv', 'CSV']] }],
            submit: 'Download',
          }, (v) => runMenu('Export', `/export ${v.range}${v.format === 'csv' ? ' csv' : ''}`))],
        ]],
        ['Work orders', [
          ['Link to a category', () => form('Link a work order', {
            intro: "Every entry in the category that day gets it, including ones you haven't started yet.",
            fields: [
              { name: 'category', label: 'Category', placeholder: 'dev' },
              { name: 'wo', label: 'Work order', placeholder: '4471' },
              { name: 'date', label: 'Day (leave empty for today)', placeholder: T.ymd(Date.now()) },
            ],
            submit: 'Link',
          }, (v) => v.category && v.wo && runMenu('Work order', `/wolink ${v.category} ${v.date ? `${v.date} ` : ''}${v.wo}`))],
        ]],
        ['Equipment', [
          ['Link to a category', () => form('Link equipment', {
            intro: "Every entry in the category that day gets it, including ones you haven't started yet.",
            fields: [
              { name: 'category', label: 'Category', placeholder: 'dev' },
              { name: 'eq', label: 'Equipment', placeholder: 'ler-resolve-07' },
              { name: 'date', label: 'Day (leave empty for today)', placeholder: T.ymd(Date.now()) },
            ],
            submit: 'Link',
          }, (v) => v.category && v.eq && runMenu('Equipment', `/eqlink ${v.category} ${v.date ? `${v.date} ` : ''}${v.eq}`))],
        ]],
        ['Forms', [
          ['Fill in a form', () => fillInForm()],
          ['New form', () => form('New form', {
            intro: 'Opens the form in the text editor: paste yours and add tokens like %{hours}. /form lists the tokens.',
            fields: [{ name: 'name', label: 'Name', placeholder: 'service' }], submit: 'Write it',
          }, (v) => v.name && opts.openCli(`/newform ${v.name.trim().replace(/\s+/g, '-')}`))],
          ...(shell.formNames().length ? [
            ['Edit a form', () => pickForm('Edit a form', 'Edit', (name) => opts.openCli(`/editform ${name}`))],
            ['Delete a form', () => pickForm('Delete a form', 'Delete', (name) => runMenu('Form', `/delform ${name}`), true)],
          ] : []),
          ['Tokens', () => runMenu('Form tokens', '/form')],
        ]],
        ['To-do', [
          ['To-do list', () => todoSheet()],
          ['Add a to-do', () => addTodoForm()],
        ]],
        ['Checklists', [
          ['Start a checklist', () => startChecklistForm()],
          ['Open checklists', () => openChecklists()],
          ['New checklist', () => form('New checklist', {
            intro: 'Opens the text editor: one thing to check per line.',
            fields: [{ name: 'name', label: 'Name', placeholder: 'upload' }], submit: 'Write it',
          }, (v) => v.name && opts.openCli(`/newchecklist ${v.name.trim().replace(/\s+/g, '-')}`))],
          ...(shell.checklistNames().length ? [['Edit a checklist', () => form('Edit a checklist', {
            fields: [{ name: 'name', label: 'Checklist', choices: shell.checklistNames().map((n) => [n, n]) }], submit: 'Edit',
          }, (v) => opts.openCli(`/editchecklist ${v.name}`))]] : []),
        ]],
        ['Pay', [
          ['Rate and overtime', () => form('Pay', {
            intro: 'Overtime counts per week, Sunday to Saturday. Clear a field to turn it off.',
            fields: [
              { name: 'rate', label: 'Hourly rate ($)', value: money('rate'), type: 'number', step: '0.01' },
              { name: 'otmin', label: 'Overtime after (hours a week)', value: money('otmin'), type: 'number', step: '0.5' },
              { name: 'otrate', label: 'Overtime pay (× rate)', value: money('otrate'), type: 'number', step: '0.05', placeholder: '1.5' },
            ],
            submit: 'Save',
          }, (v) => {
            const lines = [];
            for (const k of ['rate', 'otmin', 'otrate']) {
              if (v[k] === money(k)) continue;
              lines.push(`/${k} ${v[k] || 'off'}`);
            }
            if (lines.length) runMenu('Pay', lines);
          })],
        ]],
        ['Account', signedIn ? [
          ['Account', () => runMenu('Account', '/whoami')],
          ['Sync now', () => runMenu('Sync', '/sync')],
          ['Sign out', () => form('Sign out', { intro: 'Your log stays in your account. This device forgets it, and its key.', submit: 'Sign out' }, () => runMenu('Sign out', '/logout'))],
        ] : [
          ['Sign in', () => signIn()],
        ]],
        ...(signedIn ? [['Encryption', [
          ...(enc === 'ready' ? [
            ['Link a device', () => runMenu('Link a device', '/link')],
            ['New recovery key', () => form('New recovery key', { intro: 'Your old recovery key stops working.', submit: 'Make a new key' }, () => runMenu('Recovery key', '/recovery'))],
          ] : [
            ['Enter a link code', () => form('Link this device', { intro: 'On a device that is set up, choose Menu → Link a device, and type the code it shows.', fields: [{ name: 'code', label: 'Link code', placeholder: 'XXXX-XXXX-XXXX' }], submit: 'Link' }, (v) => v.code && runMenu('Link', `/link ${v.code}`))],
            ['Use recovery key', () => form('Recovery key', { fields: [{ name: 'key', label: 'Recovery key', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX' }], submit: 'Unlock' }, (v) => v.key && runMenu('Recovery', `/recover ${v.key}`))],
            ['Reset encryption', () => form('Reset encryption', {
              intro: 'Only if no device has the key and the recovery key is lost. Your synced log and settings are deleted (nobody can read them without the key) and you get a new key.',
              fields: [{ name: 'confirm', label: 'Type DELETE to confirm', placeholder: 'DELETE' }], submit: 'Delete and start over', danger: true,
            }, (v) => (v.confirm === 'DELETE' ? runMenu('Reset encryption', '/reset-encryption DELETE') : toast('Reset cancelled. Nothing changed.', 'dim')))],
          ]),
        ]]] : []),
        ['Backup', [
          ['Save a full backup', () => runMenu('Backup', '/backup')],
          ['Restore from a file', () => runMenu('Restore', '/restore file')],
        ]],
        ['View', [
          ['CLI', () => opts.setView('cli')],
          ['Hybrid', () => opts.setView('gui')],
          ['Help', () => runMenu('Help', '/help')],
          ['Keyboard shortcuts', () => showShortcuts()],
          [T.clockMode() === '12' ? '24-hour clock' : '12-hour clock', () => runMenu('Clock', `/clock ${T.clockMode() === '12' ? '24' : '12'}`)],
          ['Accent color', () => accentSheet()],
          [shell.ai.ready() ? 'AI key and model' : 'Set up AI (optional)', () => aiSetup()],
        ]],
      ];
    }

    function signIn() {
      form('Sign in', { intro: "We'll email you a 6-digit code.", fields: [{ name: 'email', label: 'Email', type: 'email', placeholder: 'you@example.com' }], submit: 'Send code' }, async (v) => {
        if (!v.email) return;
        await runMenu('Sign in', `/login ${v.email}`);
        form('Sign in', { intro: `Enter the code sent to ${v.email}.`, fields: [{ name: 'code', label: 'Code', placeholder: '123456' }], submit: 'Sign in' },
          (c) => c.code && runMenu('Sign in', `/code ${c.code}`));
      });
    }

    // The menu: a few things used most often on top, then sections that
    // open one at a time (the one left open is remembered on this device).
    const OPEN_KEY = 'tymlee.menuSection';
    function openSection() {
      try { return localStorage.getItem(OPEN_KEY) ?? 'To-do'; } catch (_) { return 'To-do'; }
    }
    function setOpen({ wrap, head }, on) {
      wrap.classList.toggle('open', on);
      head.setAttribute('aria-expanded', String(on));
    }

    function openMenu() {
      const list = el('div', 'gmenu');
      const quick = el('div', 'gmenu-quick');
      const due = shell.dueCount();
      const go = (fn) => () => { closeSheet(); setTimeout(fn, 170); };
      for (const [label, ico, fn, badge] of [
        ['To-do', 'check', () => todoSheet(), due ? `${due} due` : ''],
        ['Find', 'search', () => findForm(), ''],
        ['Undo', 'back', () => runMenu('Undo', '/undo'), ''],
      ]) {
        const b = button('', 'gmenu-tile', go(fn), label);
        b.append(icon(ico), el('span', null, label));
        if (badge) b.append(el('span', 'gmenu-badge', badge));
        quick.append(b);
      }
      list.append(quick);
      const open = openSection();
      const groups = [];
      for (const [section, items] of menuItems()) {
        const wrap = el('div', 'gmenu-group');
        const head = button('', 'gmenu-section', () => {
          const now = !wrap.classList.contains('open');
          for (const g of groups) setOpen(g, false);
          setOpen({ wrap, head }, now);
          try { localStorage.setItem(OPEN_KEY, now ? section : ''); } catch (_) { /* fine */ }
        });
        head.append(el('span', null, section), icon('down'));
        const body = el('div', 'gmenu-items');
        for (const [label, action] of items) body.append(button(label, 'gmenu-item', go(action)));
        wrap.append(head, body);
        list.append(wrap);
        groups.push({ wrap, head });
        setOpen({ wrap, head }, section === open);
      }
      const about = el('div', 'gmenu-about');
      const { version, build, repo } = opts.about;
      const link = el('a', null, 'GitHub');
      link.href = repo;
      link.target = '_blank';
      link.rel = 'noopener';
      about.append(`tymlee v${version}${build ? ` · ${build}` : ''} · `, link);
      list.append(about);
      sheet('Menu', list);
    }

    return {
      show() {
        active = true;
        bar.hidden = false;
        tabbar.hidden = false;
        showAiButton();
        markTab();
        if (state) update(state);
      },
      hide() {
        active = false;
        bar.hidden = true;
        tabbar.hidden = true;
        closeSheet();
        closeAi();
      },
      output,
      update,
      toast,
      markStart(on) { lastStart = on; },
      openTodos: () => todoSheet(),
      // The phone's entry card takes the same place: it closes these first.
      closePanels() { closeSheet(); closeAi(); },
      get active() { return active; },
    };
  }

  root.TymleeGui = { createGui, icon };
})(typeof globalThis !== 'undefined' ? globalThis : this);
