// The GUI view (the "pure" one, without a console): the timeline on top, a
// start bar at the bottom (category, title, Start, Off), toasts for short
// messages, sheets for longer ones, and a ☰ menu for everything else.
//
// Everything runs through the same command shell as the CLI (commands.js),
// so the GUI does exactly what the typed commands do. app.js creates it and
// routes printed output here while the GUI view is showing.
(function (root) {
  'use strict';

  const T = root.Tymlee;

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

    const menuBtn = button('', 'sb-menu', () => openMenu(), 'Menu (? lists the keyboard shortcuts)');
    menuBtn.append(icon('menu'));
    // The card: what's running and for how long.
    const card = el('div', 'sb-card');
    const dot = el('span', 'sb-dot');
    const cardWords = el('div', 'sb-card-words');
    const clock = el('span', 'sb-clock');
    const what = el('span', 'sb-what');
    cardWords.append(clock, what);
    const tdTag = el('span', 'sb-td');
    card.append(dot, cardWords, tdTag);
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
    bar.append(card, catWrap, title, doneBtn, paidBtn, unpaidBtn, breakSplit, offBtn, cancelBtn, resumeBtn, backBtn, newBtn, startBtn, menuBtn);
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
      ['/', 'Find'],
      ['?', 'This list'],
      ['Enter / Esc', 'In the fields: start / cancel'],
      ['Ctrl+Z', 'Undo'],
    ];
    function showShortcuts() {
      const list = el('div', 'gkeys');
      for (const [k, what] of SHORTCUTS) list.append(el('kbd', null, k), el('span', null, what));
      sheet('Keyboard shortcuts', list);
    }
    document.addEventListener('keydown', (e) => {
      if (!active || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable], .entry-card')) return;
      if (sheetEl || document.querySelector('.entry-card')) return;
      const k = e.key;
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
    function closeSheet() {
      if (!sheetEl) return;
      const s = sheetEl;
      sheetEl = null;
      s.classList.add('out');
      setTimeout(() => s.remove(), 160);
    }
    function sheet(heading, ...content) {
      closeSheet();
      const wrap = el('div', 'gsheet-wrap');
      const panel = el('div', 'gsheet');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', heading);
      const head = el('div', 'gsheet-head');
      const close = button('', 'gsheet-close', closeSheet, 'Close');
      close.append(icon('x'));
      head.append(el('span', 'gsheet-title', heading), close);
      const body = el('div', 'gsheet-body');
      body.append(...content);
      panel.append(head, body);
      wrap.append(panel);
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeSheet(); });
      panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
      appEl.append(wrap);
      sheetEl = wrap;
      return panel;
    }
    // Printed output in a sheet; reports keep their columns when they wrap.
    function textSheet(heading, items) {
      const pres = items.map((it) => el('pre', `gsheet-text ${it.cls || ''}`, it.text));
      sheet(heading, ...pres);
      items.forEach((it, i) => { if (/\breport\b/.test(it.cls || '')) opts.formatReport(pres[i], it.text); });
    }

    // A list of tick boxes. rows() -> [{ label, sub, done }]; onToggle(row,
    // done) saves a tick, and the list is shown again. `more` adds buttons.
    function tickSheet(heading, rows, onToggle, more = []) {
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
        if (!shown.length) list.append(el('p', 'gform-intro', 'Nothing here yet.'));
        const done = shown.filter((r) => r.done).length;
        panel.querySelector('.gsheet-title').textContent = shown.length ? `${heading} · ${done}/${shown.length}` : heading;
      };
      render();
    }

    // The to-do list: open ones first (the soonest due first), then done
    // ones. ▶ starts a timer for one; ticking it off leaves the timer running.
    function todoSheet() {
      tickSheet('To-do', () => {
        const now = Date.now();
        const running = shell.runningTodoId();
        const order = (t) => (t.done ? 2 : t.due ? 0 : 1);
        return shell.todoList()
          .sort((a, b) => order(a) - order(b) || (!a.done && a.due && b.due ? a.due.localeCompare(b.due) : 0) || a.sid - b.sid)
          .map((t) => {
            const due = !t.done && t.due ? T.dueLabel(t.due, now) : null;
            const sub = [t.tag, t.category, due && due.text, t.id === running && 'working on it now'].filter(Boolean).join(' · ');
            return { id: t.id, label: t.note || t.category, sub, done: t.done, now: t.id === running, late: Boolean(due && due.late),
              play: t.done || t.id === running ? null : () => shell.doTodo(t.id) };
          });
      },
      (r, done) => shell.setTodoDone(r.id, done),
      [['Add a to-do', () => addTodoForm()]]);
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
    async function runMenu(heading, lines) {
      capture = [];
      try {
        for (const line of [].concat(lines)) await opts.run(line);
      } finally {
        const got = capture;
        capture = null;
        const long = got.some((g) => /\b(report|key)\b/.test(g.cls) || g.text.includes('\n'));
        if (long) textSheet(heading, got);
        else for (const g of got) toast(g.text, g.cls);
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
    // open and close (which ones are open is remembered on this device).
    const OPEN_KEY = 'tymlee.menuOpen';
    function openSections() {
      try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || ['To-do']); } catch (_) { return new Set(['To-do']); }
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
      const open = openSections();
      for (const [section, items] of menuItems()) {
        const head = button('', 'gmenu-section', () => {
          const now = !wrap.classList.contains('open');
          wrap.classList.toggle('open', now);
          head.setAttribute('aria-expanded', String(now));
          const set = openSections();
          if (now) set.add(section); else set.delete(section);
          try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch (_) { /* fine */ }
        });
        head.append(el('span', null, section), icon('down'));
        const wrap = el('div', `gmenu-group${open.has(section) ? ' open' : ''}`);
        head.setAttribute('aria-expanded', String(open.has(section)));
        const body = el('div', 'gmenu-items');
        for (const [label, action] of items) body.append(button(label, 'gmenu-item', go(action)));
        wrap.append(head, body);
        list.append(wrap);
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
        if (state) update(state);
      },
      hide() {
        active = false;
        bar.hidden = true;
        closeSheet();
      },
      output,
      update,
      toast,
      markStart(on) { lastStart = on; },
      openTodos: () => todoSheet(),
      get active() { return active; },
    };
  }

  root.TymleeGui = { createGui, icon };
})(typeof globalThis !== 'undefined' ? globalThis : this);
