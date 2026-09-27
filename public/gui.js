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

  const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Week'], ['month', 'Month'], ['all', 'All']];

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
    bar.append(menuBtn, catWrap, title, startBtn, offBtn);
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
        toast('pick or type a category first', 'err');
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
      offBtn.disabled = st.state !== 'running';
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

    // A small form: fields [{ name, label, value, type, placeholder }], then
    // onSubmit(values). A range picker when `range` is set.
    function form(heading, { intro, fields = [], range, submit, danger }, onSubmit) {
      const f = el('form', 'gform');
      if (intro) f.append(el('p', 'gform-intro', intro));
      const inputs = {};
      for (const fd of fields) {
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
        const values = { range: chosenRange };
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
      else toast(text, cls, lastStart && /\bin #\d+/.test(text) ? { label: 'Undo', run: () => opts.run('/undo') } : null);
      return true;
    }
    let lastStart = false;

    // ---- the menu ------------------------------------------------------------

    function money(key) {
      const pay = (store.settings && store.settings.pay) || {};
      const v = T.payValue(pay, key, Date.now());
      return v == null ? '' : String(v);
    }

    function menuItems() {
      const signedIn = Boolean(store.user);
      const enc = store.encryption;
      return [
        ['Entries', [
          ['Undo the last change', () => runMenu('Undo', '/undo')],
          ['Note on the current entry…', () => form('Note on the current entry', {
            intro: 'Adds a line to the notes of the entry that is running (or the last one).',
            fields: [{ name: 'text', label: 'Note', placeholder: 'called the client back' }], submit: 'Add note',
          }, (v) => v.text && runMenu('Note', `/note ${v.text}`))],
          ['Edit entries as text', () => opts.openCli('/edit')],
        ]],
        ['Reports', [
          ['Log…', () => form('Log', { range: true, submit: 'Show' }, (v) => runMenu('Log', `/log ${v.range}`))],
          ['By category…', () => form('By category', { range: true, submit: 'Show' }, (v) => runMenu('By category', `/report ${v.range}`))],
          ['Work orders…', () => form('Work orders', { range: true, submit: 'Show' }, (v) => runMenu('Work orders', `/wolist ${v.range}`))],
          ['Export…', () => form('Export', { intro: 'Downloads the log as a text file, or a CSV for spreadsheets.', range: true, fields: [{ name: 'csv', label: 'Format (txt or csv)', value: 'txt' }], submit: 'Download' },
            (v) => runMenu('Export', `/export ${v.range}${/csv/i.test(v.csv) ? ' csv' : ''}`))],
          ['Copy log…', () => form('Copy log', { range: true, submit: 'Copy' }, (v) => runMenu('Copy', `/copy ${v.range}`))],
        ]],
        ['Work orders', [
          ['Link a work order to a category…', () => form('Link a work order', {
            intro: 'Every entry of the category on that day gets the work order (you can do this before starting them).',
            fields: [
              { name: 'category', label: 'Category', placeholder: 'dev' },
              { name: 'wo', label: 'Work order', placeholder: '4471' },
              { name: 'date', label: 'Day (YYYY-MM-DD, empty for today)', placeholder: T.ymd(Date.now()) },
            ],
            submit: 'Link',
          }, (v) => v.category && v.wo && runMenu('Work order', `/wolink ${v.category} ${v.date ? `${v.date} ` : ''}${v.wo}`))],
        ]],
        ['Pay', [
          ['Pay settings…', () => form('Pay', {
            intro: 'Your hourly rate, and overtime per week (Monday to Sunday). Leave a field empty to turn it off.',
            fields: [
              { name: 'rate', label: 'Hourly rate ($)', value: money('rate'), type: 'number', step: '0.01' },
              { name: 'otmin', label: 'Overtime after (hours a week)', value: money('otmin'), type: 'number', step: '0.5' },
              { name: 'otrate', label: 'Overtime factor', value: money('otrate'), type: 'number', step: '0.05', placeholder: '1.5' },
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
          ['Account and sync', () => runMenu('Account', '/whoami')],
          ['Sync now', () => runMenu('Sync', '/sync')],
          ['Sign out', () => form('Sign out', { intro: 'Your entries stay in your account; this browser forgets them and the key.', submit: 'Sign out' }, () => runMenu('Sign out', '/logout'))],
        ] : [
          ['Sign in…', () => signIn()],
        ]],
        ...(signedIn ? [['Encryption', [
          ...(enc === 'ready' ? [
            ['Link another device', () => runMenu('Link a device', '/link')],
            ['New recovery key', () => form('New recovery key', { intro: 'Makes a new recovery key; the old one stops working.', submit: 'Make a new one' }, () => runMenu('Recovery key', '/recovery'))],
          ] : [
            ['Enter a link code…', () => form('Link this device', { intro: 'On a device that is set up, open the menu and choose "Link another device", then type the code here.', fields: [{ name: 'code', label: 'Link code', placeholder: 'XXXX-XXXX-XXXX' }], submit: 'Link' }, (v) => v.code && runMenu('Link', `/link ${v.code}`))],
            ['Use the recovery key…', () => form('Recovery key', { fields: [{ name: 'key', label: 'Recovery key', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX' }], submit: 'Unlock' }, (v) => v.key && runMenu('Recovery', `/recover ${v.key}`))],
            ['Start over (reset encryption)…', () => form('Reset encryption', {
              intro: "Only if no device has the key and the recovery key is lost: your synced log and settings are deleted (nobody can decrypt them), and you get a new key. Type DELETE to confirm.",
              fields: [{ name: 'confirm', label: 'Type DELETE', placeholder: 'DELETE' }], submit: 'Delete and start over', danger: true,
            }, (v) => (v.confirm === 'DELETE' ? runMenu('Reset encryption', '/reset-encryption DELETE') : toast('reset cancelled; nothing was changed', 'dim')))],
          ]),
        ]]] : []),
        ['Backups', [
          ['Restore from a file', () => opts.openCli('/restore file')],
        ]],
        ['View', [
          ['CLI', () => opts.setView('cli')],
          ['Hybrid (timeline and console)', () => opts.setView('gui')],
          ['Help', () => runMenu('Help', '/help')],
        ]],
      ];
    }

    function signIn() {
      form('Sign in', { intro: 'We email you a 6-digit code.', fields: [{ name: 'email', label: 'Email', type: 'email', placeholder: 'you@example.com' }], submit: 'Email me a code' }, async (v) => {
        if (!v.email) return;
        await runMenu('Sign in', `/login ${v.email}`);
        form('Sign in', { intro: `Type the code emailed to ${v.email}.`, fields: [{ name: 'code', label: 'Code', placeholder: '123456' }], submit: 'Sign in' },
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
