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

  const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['calweek', 'This week'], ['week', '7 days'], ['calmonth', 'This month'], ['month', '30 days'], ['all', 'All']];

  // opts: { T, store, shell, appEl, dockEl, run(line) -> Promise, openCli(line),
  //         setView(view), status() -> shell.status(), about: { version, build, repo } }
  function createGui(opts) {
    const { T, store, shell, appEl, dockEl } = opts;
    let active = false;
    let capture = null; // lines printed while a menu command runs

    // ---- start bar -------------------------------------------------------------

    const bar = el('div', 'startbar');
    bar.id = 'startbar';
    bar.hidden = true;
    const menuBtn = button('☰', 'sb-menu', () => openMenu(), 'Menu');
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
    const startBtn = button('▶ Start', 'sb-start', () => start(), 'Start this entry (clocks out of the current one)');
    const offBtn = button('■ Off', 'sb-off', () => off(), 'Clock out (/off)');
    // Breaks: each ends when the next entry starts.
    const paidBtn = button('Paid break', 'sb-break', () => opts.run('/break-paid'), 'Paid break: counts toward hours and pay (/break-paid)');
    const unpaidBtn = button('Unpaid break', 'sb-break', () => opts.run('/break-unpaid'), 'Unpaid break: not counted, like Off (/break-unpaid)');
    const breaks = el('div', 'sb-breaks');
    breaks.append(paidBtn, unpaidBtn);
    bar.append(menuBtn, catWrap, title, startBtn, breaks, offBtn);
    dockEl.insertBefore(bar, dockEl.querySelector('#status'));

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
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // phones: keyboard away
      await opts.run(t ? `${c} ${t}` : c, { undo: true });
    }

    function off() {
      return opts.run('/off');
    }

    // Called every second with the status line's state.
    function update(st) {
      if (!active) return;
      // Working, or on a break of the other kind.
      const onPaid = st.state === 'running' && st.what === 'paid break';
      const onUnpaid = st.state === 'off' && st.offLabel === 'unpaid break';
      offBtn.disabled = !(st.state === 'running' || onUnpaid);
      paidBtn.disabled = !((st.state === 'running' && !onPaid) || onUnpaid);
      unpaidBtn.disabled = st.state !== 'running';
    }

    // ---- toasts --------------------------------------------------------------

    const toasts = el('div', 'toasts');
    toasts.setAttribute('aria-live', 'polite');
    appEl.append(toasts);

    function toast(text, cls = '', action) {
      const t = el('div', `toast ${cls}`);
      t.append(el('span', null, text));
      if (action) t.append(button(action.label, 'toast-action', () => { t.remove(); action.run(); }));
      toasts.append(t);
      while (toasts.children.length > 3) toasts.firstChild.remove();
      setTimeout(() => t.classList.add('out'), cls.includes('err') ? 6000 : 4000);
      setTimeout(() => t.remove(), cls.includes('err') ? 6400 : 4400);
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
      head.append(el('span', 'gsheet-title', heading), button('✕', 'gsheet-close', closeSheet, 'Close'));
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
          const row = el('label', `gtick-row${r.done ? ' done' : ''}`);
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = Boolean(r.done);
          box.addEventListener('change', () => { onToggle(r, box.checked); render(); });
          const words = el('span', 'gtick-words');
          words.append(el('span', 'gtick-text', r.label));
          if (r.sub) words.append(el('span', 'gtick-sub', r.sub));
          row.append(box, words);
          list.append(row);
        }
        if (!shown.length) list.append(el('p', 'gform-intro', 'Nothing here yet.'));
        const done = shown.filter((r) => r.done).length;
        panel.querySelector('.gsheet-title').textContent = shown.length ? `${heading} · ${done}/${shown.length}` : heading;
      };
      render();
    }

    // The to-do list: open ones first, then done ones.
    function todoSheet() {
      tickSheet('To-do', () => shell.todoList()
        .sort((a, b) => Boolean(a.done) - Boolean(b.done) || a.sid - b.sid)
        .map((t) => ({ id: t.id, label: t.note || t.category, sub: `${t.tag} · ${t.category}`, done: t.done })),
      (r, done) => shell.setTodoDone(r.id, done),
      [['Add a to-do', () => addTodoForm()]]);
    }

    function addTodoForm() {
      form('Add a to-do', {
        fields: [
          { name: 'category', label: 'Category', placeholder: 'dev' },
          { name: 'text', label: 'What to do', placeholder: 'fix the login bug' },
        ],
        submit: 'Add',
      }, async (v) => {
        if (!v.category) return;
        await opts.run(`/todo ${v.category.trim().replace(/\s+/g, '-')} ${v.text || ''}`);
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

    function menuItems() {
      const signedIn = Boolean(store.user);
      const enc = store.encryption;
      const show = (heading, cmd) => form(heading, { range: true, submit: 'Show' }, (v) => runMenu(heading, `${cmd} ${v.range}`));
      return [
        ['Entries', [
          ['Undo', () => runMenu('Undo', '/undo')],
          ['Paid break', () => runMenu('Break', '/break-paid')],
          ['Unpaid break', () => runMenu('Break', '/break-unpaid')],
          ['Add a note', () => form('Add a note', {
            intro: 'Goes on the current entry, as a new line.',
            fields: [{ name: 'text', label: 'Note', placeholder: 'called the client back' }], submit: 'Add',
          }, (v) => v.text && runMenu('Note', `/note ${v.text}`))],
          ['Edit entries', () => opts.openCli('/edit')],
        ]],
        ['Search', [
          ['Find', () => form('Find', {
            intro: 'Searches entry text, notes, file paths, work orders, equipment and to-dos.',
            fields: [{ name: 'q', label: 'Words', placeholder: 'stems label' }], submit: 'Find',
          }, (v) => v.q && runMenu('Find', `/find ${v.q}`))],
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
            intro: 'Overtime counts per week, Monday to Sunday. Clear a field to turn it off.',
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

    function openMenu() {
      const list = el('div', 'gmenu');
      for (const [section, items] of menuItems()) {
        list.append(el('div', 'gmenu-section', section));
        for (const [label, action] of items) {
          list.append(button(label, 'gmenu-item', () => { closeSheet(); setTimeout(action, 170); }));
        }
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
      get active() { return active; },
    };
  }

  root.TymleeGui = { createGui };
})(typeof globalThis !== 'undefined' ? globalThis : this);
