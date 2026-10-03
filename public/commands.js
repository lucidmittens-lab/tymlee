// The tymlee command shell, shared by the website (app.js) and the terminal
// app (cli/). It turns a typed line into an entry or a command and prints the
// results; everything that depends on where it runs comes from `io`:
//
//   print(text, cls)     show output; cls is ok, err, dim, key or report
//   storage              getItem / setItem / removeItem (remembers /login)
//   place                'this browser', 'this computer', ...
//   compact()            true when the screen is narrow (shorter /log)
//   save(name, body, type) -> Promise<string>   /export; says where it went
//   copy(text) -> Promise                       /copy; throws if unavailable
//   clear()              /clear
//   pickFile(args) -> Promise<string|null>      /restore <file>
//   restoreUsage         usage text for /restore
//   keys                 help lines about keys
//   linkSignIn           whether the emailed sign-in link works here
//   pickEntry(choices, name) -> Promise<choice|null>   choose an entry for
//                        /note or /wopunch (name); choices are newest first,
//                        { span, label }
//   ask(label, initial, name) -> Promise<string|null>  type notes or a
//                        work order (name: 'notes' or 'wo'); notes may
//                        contain line breaks ("\n") both ways
//   editor               either an inline box that /save and /cancel act on:
//                          { open({ text, items, mode, label }), isOpen(),
//                            mode(), value(), items(), close() }
//                        or an external editor:
//                          { edit(text) -> Promise<string|null>,
//                            confirm(question) -> Promise<boolean> }
//   extra                more commands, { name: { usage, about, run(args) } }
//   showTimeline(range)  draw /timeline graphically (website); without it,
//                        /timeline prints text, colored by paint(slot, text)
//   paint, width()       for the text timeline (terminal)
(function (root) {
  'use strict';

  const LOGIN_EMAIL_KEY = 'tymlee.loginEmail';
  // Where the first test version kept pay settings (on the device only).
  const OLD_PAY_KEY = 'tymlee.pay';
  const LOGIN_CODE_TTL_MS = 60 * 60 * 1000;

  const RESTORE_HELP = [
    '# paste a backup below',
    '# (.txt or .csv from /export)',
    '# duplicates are skipped',
  ];
  const EXTERNAL_HELP = '# save and close to apply; empty the file to cancel';

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

  function createShell({ store, T, V, io }) {
    const print = (text, cls) => io.print(text, cls);
    const inline = typeof io.editor.open === 'function';

    // ---- helpers -------------------------------------------------------------

    function describe(s) {
      if (T.isMarker(s.text)) return s.category.replace(/[()]/g, ''); // off, paid break, unpaid break
      return s.note ? `${s.category} ${s.note}` : s.category;
    }

    function plural(n, one, many) {
      return `${n} ${n === 1 ? one : many}`;
    }

    // "#12 [4471] 10:00 dev code review", with the date when it isn't today.
    function entryLabel(s) {
      const today = T.ymd(s.ts) === T.ymd(Date.now());
      const when = today ? T.clock(s.ts) : `${T.ymd(s.ts).slice(5)} ${T.clock(s.ts)}`;
      return `${T.idTag(s.n)} ${s.wo ? `${T.woTag(s.wo)} ` : ''}${s.eq ? `${T.eqTag(s.eq)} ` : ''}${when} ${describe(s)}${s.notes ? '  ✎' : ''}`;
    }

    // Entries you can see (not /wolink's hidden links).
    const shown = () => T.visible(store.entries);

    const sameCategory = (a, b) => a.toLowerCase() === b.toLowerCase();

    // The /wolink link for a category on the day of `ts`, if any.
    function linkFor(category, ts) {
      const day = T.ymd(ts);
      return store.entries.find((e) => T.isLink(e) && sameCategory(T.linkCategory(e), category) && T.ymd(e.ts) === day) || null;
    }

    // ---- work orders and equipment ------------------------------------------------

    // Two kinds of code, set the same ways: per category and day (/wolink,
    // /eqlink, kept on the hidden link entry) or per entry (/wopunch, /eqpunch).
    const CODES = [
      { cmd: 'wo', field: 'wo', flag: 'wl', noun: 'work order', tag: T.woTag, example: '4471' },
      { cmd: 'eq', field: 'eq', flag: 'ql', noun: 'equipment', tag: T.eqTag, example: 'ler-resolve-07' },
    ];

    function linkCommands(k) {
      const needs = k.field === 'wo'
        ? 'work orders need the latest supabase/schema.sql on the server; run it, then /sync'
        : 'equipment needs end-to-end encryption on this account (/encrypt), then /sync';
      const invalid = (typed) => (k.field === 'wo'
        ? `"${typed.trim()}" is not a valid work order (no spaces or brackets, up to ${T.MAX_WO} characters)`
        : `"${typed.trim()}" is not valid equipment (${T.EQ_RULES})`);
      // The typed value, cleaned up; null if it isn't valid.
      const clean = (typed) => {
        if (k.field === 'eq') return T.normalizeEq(typed);
        const wo = typed.trim().replace(/^\[(.*)\]$/, '$1');
        return !wo || T.validWo(wo) ? wo : null;
      };
      return {
        [`${k.cmd}link`]: {
          usage: `/${k.cmd}link <category> [YYYY-MM-DD] [${k.field === 'wo' ? 'wo' : 'equipment'}]`,
          about: `link ${k.field === 'wo' ? 'a work order' : 'equipment'} to a category for a day (today by default)`,
          async run(args) {
            if (busy()) return;
            const category = args[0] || '';
            if (!category || category.startsWith('/')) return print(`usage: /${k.cmd}link <category> [YYYY-MM-DD] [${k.noun}]`, 'err');
            let rest = args.slice(1);
            let dayTs = Date.now();
            if (rest[0] && /^\d{4}-\d{2}-\d{2}$/.test(rest[0])) {
              const range = T.parseRange(rest[0], Date.now());
              if (!range) return print(`"${rest[0]}" is not a day · use YYYY-MM-DD`, 'err');
              dayTs = range.from;
              rest = rest.slice(1);
            }
            const day = T.ymd(dayTs);
            if (!(await store.supports(k.field))) return print(needs, 'err');
            const link = linkFor(category, dayTs);
            const matching = shown().filter((e) => !T.isOff(e) && T.ymd(e.ts) === day && sameCategory(T.parseInput(e.text).category, category));
            const typed = rest.length ? rest.join(' ') : await io.ask(`${k.noun} for ${category} on ${day}`, (link && link[k.field]) || '', k.field);
            if (typed == null) return print(`${k.noun} cancelled`, 'dim');
            const v = clean(typed);
            if (v == null) return print(invalid(typed), 'err');
            const set = { [k.field]: v, [k.flag]: Boolean(v) };
            const ops = [];
            if (v) {
              // The hidden link, at the start of the day.
              const linkEntry = link ? T.makeEntry(link, set) : T.makeEntry({ id: T.uuid(), ts: T.startOfDay(dayTs), text: `${T.LINK}${category}` }, set);
              ops.push({ op: 'put', entry: linkEntry });
              // Entries punched with /${k.cmd}punch keep their own.
              for (const e of matching) if (!e[k.field] || e[k.flag]) ops.push({ op: 'put', entry: T.makeEntry(e, set) });
            } else {
              // The link goes when nothing else is linked on it.
              if (link) {
                const other = CODES.some((o) => o !== k && link[o.field]);
                ops.push(other ? { op: 'put', entry: T.makeEntry(link, set) } : { op: 'del', id: link.id });
              }
              for (const e of matching) if (e[k.field] && e[k.flag]) ops.push({ op: 'put', entry: T.makeEntry(e, set) });
            }
            store.apply(ops);
            const updated = ops.filter((o) => o.op === 'put' && !T.isLink(o.entry)).length;
            if (!v) return print(link || updated ? `${k.noun} unlinked from ${category} on ${day}` : `no ${k.noun} was linked to ${category} on ${day}`, 'ok');
            print(`${k.tag(v)} linked to ${category} on ${day}: ${plural(updated, 'entry', 'entries')} updated`, 'ok');
          },
        },
        [`${k.cmd}punch`]: {
          usage: `/${k.cmd}punch [ID] [${k.field === 'wo' ? 'wo' : 'equipment'}]`,
          about: `set the ${k.noun} on one entry (Tab: older, Shift+Tab: newer)`,
          async run(args) {
            if (busy()) return;
            if (!shown().some((e) => !T.isOff(e))) return print('no entries yet', 'err');
            if (!(await store.supports(k.field))) return print(needs, 'err');
            const chosen = await chooseEntry(args, `/${k.cmd}punch [ID] [${k.noun}]`, `${k.cmd}punch`);
            if (!chosen) return args.length ? undefined : print(`${k.noun} cancelled`, 'dim');
            const current = store.entries.find((e) => e.id === chosen.id);
            if (!current) return print('that entry was removed in the meantime', 'err');
            const typed = args.length > 1 ? args.slice(1).join(' ') : await io.ask(`${k.noun} for ${entryLabel(chosen)}`, current[k.field] || '', k.field);
            if (typed == null) return print(`${k.noun} cancelled`, 'dim');
            const v = clean(typed);
            if (v == null) return print(invalid(typed), 'err');
            if (v === (current[k.field] || '') && !current[k.flag]) return print(`${k.noun} unchanged`, 'dim');
            store.apply([{ op: 'put', entry: T.makeEntry(current, { [k.field]: v, [k.flag]: false }) }]);
            print(v ? `${k.tag(v)} set on ${T.idTag(chosen.n)} ${describe(chosen)}` : `${k.noun} removed from ${T.idTag(chosen.n)} ${describe(chosen)}`, 'ok');
          },
        },
      };
    }

    // ---- off and breaks ----------------------------------------------------------

    // /off, /break-paid, /break-unpaid: end the current entry with a marker
    // entry that lasts until the next one.
    function stopFor(marker, word) {
      const before = T.withSpans(store.entries, Date.now());
      const cur = before[before.length - 1];
      if (!cur || (cur.off && marker === T.OFF && cur.text === T.OFF)) return print('not clocked in', 'err');
      if (cur.text === marker) return print(`already on ${word === 'off' ? 'off' : `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`} since ${T.clock(cur.ts)}`, 'dim');
      const entry = store.add(marker);
      const was = T.isMarker(cur.text) ? `of ${cur.category.replace(/[()]/g, '')}` : cur.category;
      const out = cur.text === T.OFF ? '' : `out ${was} (${T.formatHM(entry.ts - cur.ts)})  `;
      print(`${T.clock(entry.ts)}  ${out}${word}${word === 'off' ? '' : ' · your next entry ends it'}`, 'ok');
    }

    // ---- pay settings ----------------------------------------------------------

    // Pay settings live with the account's settings (store.js), which sync
    // across devices, encrypted like entries.
    function loadPay() {
      moveOldPay();
      return store.settings.pay || {};
    }

    function savePay(pay) {
      store.setSettings({ ...store.settings, pay });
    }

    function moveOldPay() {
      let old = null;
      try { old = JSON.parse(io.storage.getItem(OLD_PAY_KEY)); } catch (_) { /* none */ }
      if (!old) return;
      io.storage.removeItem(OLD_PAY_KEY);
      if (!store.settings.pay) store.setSettings({ ...store.settings, pay: old });
    }

    // ---- forms -----------------------------------------------------------------

    // Templates (/newform) and the answers to their %{ask:...} questions are
    // records (store.js): one encrypted row each, so there's no size limit and
    // no answer is ever dropped. Until the server has the records table they
    // stay in the account's settings, as in earlier versions.
    const FORM_HELP = [
      '# your form: text, with tokens filled in from the log',
      '# %{hours} %{in} %{out} %{notes} ... (/form lists them all)',
      '# %{each category} ... %{end} repeats a part per category (or wo, entry)',
      '# %{ask:System} asks you when the form is filled in',
      '# lines starting with # up here are left out',
    ];
    const FORM_STARTER = 'Date: %{date}\n\n%{each category}\nProject: %{category}\nWork order: %{wo}\nHours: %{hours}\nWorked: %{in}-%{out}\nNotes:\n%{notes}\n%{end}\n';
    const validFormName = (name) => /^[\w-]{1,40}$/.test(name || '');

    // name -> template (the newest, if two devices made one with the same name).
    function forms() {
      if (!store.recordsReady()) return store.settings.forms || {};
      const out = {};
      const seen = new Set();
      const add = (name, text) => {
        if (seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        out[name] = text;
      };
      for (const f of store.listRecords('form')) add(f.name, f.text);
      // One an older version put back in the settings, if any.
      for (const [name, text] of Object.entries(store.settings.forms || {})) add(name, text);
      return out;
    }

    const formRecords = (name) => store.listRecords('form').filter((f) => f.name.toLowerCase() === String(name).toLowerCase());

    function saveForm(name, text) {
      if (!store.recordsReady()) {
        const next = { ...forms() };
        const existing = formName(name);
        if (existing) delete next[existing];
        next[name] = text;
        return store.setSettings({ ...store.settings, forms: next });
      }
      const [newest, ...older] = formRecords(name);
      store.putRecord('form', { name, text }, newest && newest.id);
      store.deleteRecords(older.map((f) => f.id));
    }

    function deleteForm(name) {
      if (!store.recordsReady()) {
        const next = { ...forms() };
        delete next[name];
        return store.setSettings({ ...store.settings, forms: next });
      }
      store.deleteRecords(formRecords(name).map((f) => f.id));
      const left = store.settings.forms || {};
      const stale = Object.keys(left).filter((n) => n.toLowerCase() === name.toLowerCase());
      if (stale.length) {
        const next = { ...left };
        for (const n of stale) delete next[n];
        store.setSettings({ ...store.settings, forms: next });
      }
    }

    // The last answer to a question: the one given for this section (work
    // order, category...), else the latest given for that label anywhere.
    function lastAnswer(label, where) {
      if (!store.recordsReady()) {
        const old = store.settings.formAnswers || {};
        return old[`${label}\n${where}`] || old[`${label}\n`] || '';
      }
      // Blank answers don't count: they'd hide a useful earlier one.
      const all = store.listRecords('answer').filter((a) => a.label === label && a.value);
      const exact = all.find((a) => a.where === where);
      return (exact || all[0] || {}).value || '';
    }

    function saveAnswers(answers) {
      if (!answers.size) return;
      if (!store.recordsReady()) {
        const old = { ...(store.settings.formAnswers || {}) };
        for (const [k, v] of answers) old[k] = v;
        return store.setSettings({ ...store.settings, formAnswers: old });
      }
      const all = store.listRecords('answer');
      for (const [k, value] of answers) {
        const [label, where] = k.split('\n');
        const existing = all.find((a) => a.label === label && a.where === where);
        if (!value && !existing) continue;
        store.putRecord('answer', { label, where, value }, existing && existing.id);
      }
    }

    // The stored name for `name`, matched without regard to case.
    function formName(name) {
      const low = String(name || '').toLowerCase();
      return Object.keys(forms()).find((k) => k.toLowerCase() === low) || null;
    }

    function formList() {
      const names = Object.keys(forms()).sort();
      return names.length ? names.join(', ') : 'none yet';
    }

    // The editor's text -> the template: the # lines at the top are help.
    function templateFrom(text) {
      const lines = text.split('\n');
      while (lines.length && lines[0].startsWith('#')) lines.shift();
      while (lines.length && !lines[0].trim()) lines.shift();
      return lines.join('\n').replace(/\s+$/, '') + '\n';
    }

    function applyForm(text, items) {
      const name = items && items.form;
      const template = templateFrom(text);
      if (!template.trim()) {
        print(inline ? 'the form is empty; type it in, or /cancel' : 'the form is empty', 'err');
        return false;
      }
      const { errors } = T.parseForm(template);
      if (errors.length) {
        print(errors.concat(inline ? 'nothing was saved; fix the form and /save again' : 'nothing was saved').join('\n'), 'err');
        return false;
      }
      saveForm(name, template);
      print(`form ${name} saved · /form ${name} fills it in for today, /form ${name} tue for Tuesday`, 'ok');
      return true;
    }

    async function openForm(name, template) {
      print(inline
        ? `editing form ${name} · /save to keep it, /cancel to discard`
        : `editing form ${name} in your editor…`, 'dim');
      await openText({ text: `${FORM_HELP.join('\n')}\n\n${template}`, items: { form: name }, mode: 'form', label: `Form ${name}` });
    }

    // The questions a form will ask for a day, with the last answers:
    // [{ label, where, last }], or null (explained) if it can't be filled in.
    // For the GUI, which asks them in a sheet and passes them to presetAnswers.
    function formQuestions(name, day) {
      const found = formName(name);
      if (!found) {
        print(`no form called "${name}"`, 'err');
        return null;
      }
      const range = rangeFrom(day ? [day] : []);
      if (!range) return null;
      return T.formQuestions(forms()[found], store.entries, range, Date.now())
        .map((q) => ({ ...q, last: lastAnswer(q.label, q.where) }));
    }

    // Answers for the next /form, in question order, instead of asking.
    let preset = null;
    function presetAnswers(list) {
      preset = list.slice();
    }

    // /form name [day]: ask its questions (offering the last answers), then
    // show it filled in.
    async function fillForm(name, rangeArgs) {
      const given = preset;
      preset = null;
      const found = formName(name);
      if (!found) return print(`no form called "${name}" · your forms: ${formList()} · /newform ${name} makes it`, 'err');
      const range = rangeFrom(rangeArgs);
      if (!range) return;
      const now = Date.now();
      const template = forms()[found];
      if (!T.withSpans(store.entries, now).some((s) => !s.off && s.ts >= range.from && s.ts < range.to)) {
        return print(`no entries (${range.label}) · nothing to fill ${found} in from`, 'dim');
      }
      const questions = T.formQuestions(template, store.entries, range, now);
      const answers = new Map();
      for (const q of questions) {
        const typed = given
          ? given.shift() || ''
          : await io.ask(q.where ? `${q.label} for ${q.where}` : q.label, lastAnswer(q.label, q.where), 'form');
        if (typed == null) return print('form cancelled', 'dim');
        answers.set(`${q.label}\n${q.where}`, typed.trim());
      }
      saveAnswers(answers);
      const result = T.fillForm(template, store.entries, range, now, (label, where) => answers.get(`${label}\n${where}`));
      if (result.errors) return print(result.errors.join('\n'), 'err');
      print(result.text.replace(/\s+$/, ''), 'report');
    }

    // What the editor's text is saved as, by mode.
    function applyText(mode, text, items) {
      if (mode === 'restore') return applyRestore(text);
      if (mode === 'form') return applyForm(text, items);
      if (mode === 'checklist') return applyChecklist(text, items);
      if (mode === 'checkrun') return applyCheckRun(text, items);
      return applyEdit(text, items);
    }

    // ---- checklists --------------------------------------------------------------

    // A checklist template (/newchecklist) is a list of things to check, one
    // per line. /check <name> starts one: a copy with its own ID (CL:000010)
    // whose items you tick, as [x], in the editor (or the GUI's boxes).
    // Templates and started checklists are records, like forms.
    const CHECK_HELP = [
      '# one thing to check per line',
      '# lines starting with # are left out',
    ];
    const RUN_HELP = '# tick an item by putting an x in its brackets: [x] · save to keep it';
    const runTag = (sid) => `CL:${T.idText(sid)}`;

    function templates() {
      const out = {};
      for (const c of store.listRecords('checklist')) if (!Object.keys(out).some((n) => n.toLowerCase() === c.name.toLowerCase())) out[c.name] = c;
      return out;
    }
    const templateFor = (name) => Object.values(templates()).find((c) => c.name.toLowerCase() === String(name || '').toLowerCase()) || null;

    // Started checklists, oldest ID first; duplicate IDs from two devices
    // offline are fixed like to-dos.
    function runs() {
      const list = store.listRecords('checkrun').sort((a, b) => a.made - b.made || (a.id < b.id ? -1 : 1));
      const used = new Set();
      let max = Math.max(0, ...list.map((r) => r.sid || 0));
      for (const r of list) {
        if (!r.sid || used.has(r.sid)) {
          max = Math.floor(max / 10) * 10 + 10;
          r.sid = max;
          const { id, at, ...body } = r;
          store.putRecord('checkrun', body, id);
        }
        used.add(r.sid);
      }
      return list.sort((a, b) => a.sid - b.sid).map((r) => ({
        ...r, n: T.idText(r.sid), tag: runTag(r.sid),
        ticked: r.items.filter((it) => it.done).length,
        title: `${r.name}${r.label ? ` · ${r.label}` : ''}`,
      }));
    }

    const itemsFrom = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

    function applyChecklist(text, items) {
      const name = items && items.checklist;
      const list = itemsFrom(text);
      if (!list.length) {
        print(inline ? 'the checklist is empty; type an item per line, or /cancel' : 'the checklist is empty', 'err');
        return false;
      }
      const body = { name, text: list.join('\n') };
      const old = store.listRecords('checklist').filter((c) => c.name.toLowerCase() === name.toLowerCase());
      store.putRecord('checklist', body, old[0] && old[0].id);
      store.deleteRecords(old.slice(1).map((c) => c.id));
      print(`checklist ${name} saved (${plural(list.length, 'item', 'items')}) · /check ${name} starts one`, 'ok');
      return true;
    }

    // The editor's "[x] item" lines back into the started checklist; other
    // lines become new, unticked items.
    function applyCheckRun(text, items) {
      const run = runs().find((r) => r.id === (items && items.run));
      if (!run) {
        print('that checklist was deleted in the meantime', 'err');
        return true;
      }
      const next = [];
      for (const line of text.split('\n').map((l) => l.trim())) {
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^\[([ xX✓]?)\]\s*(.*)$/);
        if (m && !m[2]) continue;
        next.push(m ? { text: m[2], done: Boolean(m[1].trim()) } : { text: line, done: false });
      }
      saveRun(run, next);
      const ticked = next.filter((it) => it.done).length;
      print(`${run.tag} ${run.title}: ${ticked}/${next.length} checked${ticked === next.length && next.length ? ' · all done' : ''}`, 'ok');
      return true;
    }

    function saveRun(run, items) {
      const { id, at, n, tag, ticked, title, ...body } = run;
      const all = items.length && items.every((it) => it.done);
      store.putRecord('checkrun', { ...body, items, doneAt: all ? body.doneAt || Date.now() : null }, id);
    }

    function startRun(template, label) {
      const max = Math.max(0, ...runs().map((r) => r.sid));
      const sid = Math.floor(max / 10) * 10 + 10;
      const body = { sid, name: template.name, label: label.trim(), items: itemsFrom(template.text).map((text) => ({ text, done: false })), made: Date.now() };
      const id = store.putRecord('checkrun', body);
      return runs().find((r) => r.id === id);
    }

    async function openRun(run) {
      const lines = [RUN_HELP, `# ${run.tag} ${run.title}`, ...run.items.map((it) => `[${it.done ? 'x' : ' '}] ${it.text}`)];
      print(inline ? `checking ${run.tag} ${run.title} · /save to keep it, /cancel to discard` : `checking ${run.tag} ${run.title} in your editor…`, 'dim');
      await openText({ text: `${lines.join('\n')}\n`, items: { run: run.id }, mode: 'checkrun', label: `Checklist ${run.title}` });
    }

    function formatChecklists() {
      const names = Object.keys(templates()).sort();
      const list = runs();
      const open = list.filter((r) => r.ticked < r.items.length);
      const lines = [`checklists: ${names.length ? names.join(', ') : 'none yet'}`];
      lines.push('/newchecklist <name>  /editchecklist <name>  /delchecklist <name>');
      lines.push('/check <name> [label] starts one; /check <CL> opens one to tick');
      if (list.length) {
        lines.push('', `started: ${open.length} open, ${list.length - open.length} done`);
        for (const r of list.slice().reverse()) lines.push(`  ${r.tag}  ${String(`${r.ticked}/${r.items.length}`).padStart(5)}  ${r.title}${r.ticked === r.items.length ? '  ✓' : ''}`);
      }
      return lines.join('\n');
    }

    // ---- full backups --------------------------------------------------------------

    const BACKUP_KEY = 'tymlee.lastBackup';
    const BACKUP_EVERY_DAYS = 7;

    function lastBackup() {
      try { return Number(io.storage.getItem(BACKUP_KEY)) || 0; } catch (_) { return 0; }
    }

    async function saveFullBackup() {
      const now = Date.now();
      const body = T.makeFullBackup({ entries: store.entries, records: store.allRecords(), settings: store.settings, now });
      const where = await io.save(`tymlee-backup-${T.ymd(now)}.json`, body, 'application/json');
      try { io.storage.setItem(BACKUP_KEY, String(now)); } catch (_) { /* no reminder memory */ }
      const counts = store.allRecords().reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] || 0) + 1 }), {});
      const parts = [plural(shown().length, 'entry', 'entries')];
      if (counts.form) parts.push(plural(counts.form, 'form', 'forms'));
      if (counts.todo) parts.push(plural(counts.todo, 'to-do', 'to-dos'));
      if (counts.checklist || counts.checkrun) parts.push(plural((counts.checklist || 0) + (counts.checkrun || 0), 'checklist', 'checklists'));
      print(`full backup saved: ${where} (${parts.join(', ')}, settings) · /restore reads it back`, 'ok');
    }

    function restoreFull(b) {
      const have = new Set(store.entries.map((e) => e.id));
      const fresh = b.entries.filter((e) => !have.has(e.id));
      store.apply(fresh.map((entry) => ({ op: 'put', entry })));
      const recs = store.importRecords(b.records);
      const before = JSON.stringify(store.settings);
      const merged = T.mergeSettings(store.settings, b.settings);
      if (JSON.stringify(merged) !== before) store.setSettings(merged);
      const skipped = b.entries.length - fresh.length;
      print(`restored from the full backup${b.made ? ` of ${b.made.slice(0, 10)}` : ''}: ${plural(fresh.filter((e) => !T.isLink(e)).length, 'entry', 'entries')}, ${plural(recs, 'item', 'items')} (forms, to-dos, checklists…)${skipped ? ` · ${skipped} already here` : ''}`, 'ok');
    }

    // Things worth knowing when the app opens.
    function startupNotices() {
      const out = [];
      const days = (Date.now() - lastBackup()) / 86400000;
      if (shown().length >= 20 && days > BACKUP_EVERY_DAYS) {
        out.push(lastBackup() ? `your last full backup was ${Math.floor(days)} days ago · /backup saves one` : 'no full backup on this device yet · /backup saves one (entries, forms, to-dos, checklists, settings)');
      }
      if (store.recordsReady()) {
        const today = T.ymd(Date.now());
        const due = todos().filter((t) => !t.done && t.due && t.due <= today);
        const late = due.filter((t) => t.due < today).length;
        if (due.length) out.push(`${due.length} to-do${due.length === 1 ? '' : 's'} due today${late ? ` (${late} overdue)` : ''} · /todos today`);
      }
      return out;
    }

    // Deleted entries, newest deletion first (store.js keeps them 30 days).
    const trashed = () => store.listRecords('trash').filter((t) => t.entry && t.entry.id);

    // ---- to-dos ------------------------------------------------------------------

    // A to-do is a category and text ("dev fix login bug") with its own ID,
    // shown as TD:000010, open until /done. They're records (store.js): kept
    // encrypted, synced, and on this device offline.
    const todoTag = (sid) => `TD:${T.idText(sid)}`;

    // All to-dos, oldest ID first, each with an ID. Two devices that gave out
    // the same ID offline: the later one gets the next free ten.
    function todos() {
      const list = store.listRecords('todo').sort((a, b) => a.made - b.made || (a.id < b.id ? -1 : 1));
      const used = new Set();
      let max = Math.max(0, ...list.map((t) => t.sid || 0));
      for (const t of list) {
        if (!t.sid || used.has(t.sid)) {
          max = Math.floor(max / 10) * 10 + 10;
          t.sid = max;
          const { id, at, ...body } = t;
          store.putRecord('todo', body, id);
        }
        used.add(t.sid);
      }
      return list.sort((a, b) => a.sid - b.sid).map((t) => ({ ...t, n: T.idText(t.sid), tag: todoTag(t.sid), ...T.parseInput(t.text) }));
    }

    function addTodo(text) {
      let due = null;
      const dm = text.match(/\s+due:(\S+)\s*$/i);
      if (dm) {
        due = T.parseDue(dm[1], Date.now());
        if (!due) return print(`"${dm[1]}" is not a day · try today, tomorrow, fri, +3 or 10-09`, 'err');
        text = text.slice(0, dm.index);
      }
      const { category, note } = T.parseInput(text);
      if (!category || category.startsWith('/')) return print('usage: /todo <category> <what to do>, e.g. /todo dev fix the login bug', 'err');
      const clean = note ? `${category} ${note}` : category;
      if (clean.length > T.MAX_TEXT) return print(`to-dos are limited to ${T.MAX_TEXT} characters`, 'err');
      const max = Math.max(0, ...todos().map((t) => t.sid));
      const sid = Math.floor(max / 10) * 10 + 10;
      store.putRecord('todo', { sid, text: clean, done: false, made: Date.now(), ...(due ? { due } : {}) });
      const short = String(sid).replace(/^0+/, '');
      print(`to-do ${todoTag(sid)} ${clean}${due ? ` · ${T.dueLabel(due, Date.now()).text}` : ''} · /do ${short} starts it, /done ${short} when it's done`, 'ok');
    }

    // Saves a to-do's changed fields.
    function saveTodo(t, changes) {
      const { id, at, n, tag, category, note, ...body } = t;
      store.putRecord('todo', { ...body, ...changes }, id);
    }

    // The entry running now, if it's a task (not off or a break).
    function runningEntry() {
      const cur = T.withSpans(shown(), Date.now()).pop();
      return cur && !cur.off && !T.isMarker(cur.text) ? cur : null;
    }

    // The latest entry that's a task (not off or a break), for Resume.
    function lastTask() {
      const list = shown();
      for (let i = list.length - 1; i >= 0; i--) if (!T.isMarker(list[i].text)) return list[i];
      return null;
    }

    // Open to-dos due today or earlier.
    function dueCount() {
      if (!store.recordsReady()) return 0;
      const today = T.ymd(Date.now());
      return store.listRecords('todo').filter((t) => !t.done && t.due && t.due <= today).length;
    }

    // The open to-do started with /do that's running now.
    function runningTodo() {
      const cur = runningEntry();
      return cur ? todos().find((t) => !t.done && t.entryId === cur.id) || null : null;
    }

    // /do: start an entry with the to-do's category and text, linked to it so
    // a bare /done marks it done (the entry keeps running).
    function doTodo(arg) {
      const t = T.findById(todos(), String(arg || '').replace(/^td:/i, ''));
      if (!t) return print('usage: /do <TD>   (a to-do ID from /todos, or its last digits)', 'err');
      if (t.done) return print(`${t.tag} is done · /undone ${t.n.replace(/^0+/, '')} opens it again`, 'err');
      const now = runningTodo();
      if (now && now.id === t.id) return print(`already working on ${t.tag} ${t.text}`, 'dim');
      const entry = add(t.text);
      if (!entry) return;
      saveTodo(t, { entryId: entry.id });
      print(`working on ${t.tag} · /done marks it done (the timer keeps going until /off, a break or your next entry)`, 'dim');
    }

    // which: 'open' (the default), 'all', or 'today' (open and due today or
    // earlier).
    function formatTodos(which = 'open') {
      const now = Date.now();
      const today = T.ymd(now);
      const all = todos();
      const list = all.filter((t) => (which === 'all' || !t.done) && (which !== 'today' || (t.due && t.due <= today)));
      const open = all.filter((t) => !t.done).length;
      if (which === 'today' && !list.length) return 'nothing due today';
      if (!list.length) return which === 'all' ? 'no to-dos yet · /todo <category> <what to do> adds one' : `nothing to do${open ? '' : ' · /todo <category> <what to do> adds one'}`;
      const catWidth = Math.min(16, Math.max(...list.map((t) => t.category.length)));
      const running = runningTodo();
      const late = all.filter((t) => !t.done && t.due && t.due < today).length;
      const lines = [which === 'today' ? `due today: ${list.length}` : `to-do: ${open} open${which === 'all' ? `, ${all.length - open} done` : ''}${late ? `, ${late} overdue` : ''}`];
      for (const t of list) {
        const tail = [];
        if (t.done && t.doneAt) tail.push(`done ${T.ymd(t.doneAt).slice(5)}`);
        else if (t.due) tail.push(T.dueLabel(t.due, now).text);
        if (running && running.id === t.id) tail.push('working on it now');
        const mark = t.done ? 'x' : running && running.id === t.id ? '>' : ' ';
        lines.push(`  [${mark}] ${t.tag}  ${t.category.padEnd(catWidth)}  ${t.note}${tail.length ? `  (${tail.join(', ')})` : ''}`.trimEnd());
      }
      return lines.join('\n');
    }

    // /done and /undone: mark to-dos (by ID or its last digits) done or not.
    function markTodos(args, done) {
      if (!args.length && done && runningTodo()) args = [runningTodo().n];
      if (!args.length) return print(`usage: /${done ? 'done' : 'undone'} <TD> [more]   (a to-do ID from /todos, or its last digits)${done ? ' · /done alone marks the to-do you started with /do' : ''}`, 'err');
      const list = todos();
      for (const a of args) {
        const t = T.findById(list, String(a).replace(/^td:/i, ''));
        if (!t) {
          print(`no to-do ${a} · /todos lists them`, 'err');
          continue;
        }
        if (Boolean(t.done) === done) {
          print(`${t.tag} is already ${done ? 'done' : 'open'}`, 'dim');
          continue;
        }
        saveTodo(t, { done, doneAt: done ? Date.now() : null });
        print(`${done ? '[x]' : '[ ]'} ${t.tag} ${t.text}`, 'ok');
      }
    }

    // ---- the clock ---------------------------------------------------------------

    // 12- or 24-hour times, kept with the account's settings like pay.
    function applyClock() {
      T.setClock(store.settings.clock);
      return T.clockMode();
    }

    function setClock(mode) {
      store.setSettings({ ...store.settings, clock: mode });
      return applyClock();
    }

    // /rate, /otmin, /otrate: show the setting with no argument, set it with
    // one, turn it off with "off". `check(n)` returns an error message or ''.
    function paySetting(key, arg, { show, check, unit }) {
      let pay = loadPay();
      const now = Date.now();
      const current = T.payValue(pay, key, now);
      if (!arg) return print(current == null ? `${key} is not set` : `${key}: ${show(current)}`, current == null ? 'dim' : 'ok');
      if (/^(off|none|clear)$/i.test(arg)) {
        if (current == null) return print(`${key} is not set`, 'dim');
        savePay(T.setPay(pay, key, null, now));
        return print(`${key} turned off from now on`, 'ok');
      }
      const n = T.parseAmount(arg);
      const problem = n == null ? `"${arg}" is not a number` : check(n);
      if (problem) return print(problem, 'err');
      const first = !(pay[key] || []).length;
      pay = T.setPay(pay, key, n, now);
      savePay(pay);
      print(`${key}: ${show(n)}${first ? '' : ' from now on (earlier time keeps the old one)'}${unit ? unit(pay) : ''}`, 'ok');
    }

    // Let the user choose an entry (newest first) unless args[0] names one.
    // Returns the chosen span, or null (after explaining why).
    // `withOff`: /off entries and unpaid breaks can be chosen too (notes).
    async function chooseEntry(args, usage, name, withOff = false) {
      const spans = T.withSpans(store.entries, Date.now()).filter((s) => withOff || !s.off);
      if (!spans.length) {
        print('no entries yet', 'err');
        return null;
      }
      if (args.length) {
        const found = T.findById(spans, args[0]);
        if (!found) print(`usage: ${usage}   (an entry ID from /log, or its last digits; /off entries don't count)`, 'err');
        return found || null;
      }
      const picked = await io.pickEntry(spans.slice().reverse().map((span) => ({ span, label: entryLabel(span) })), name);
      return picked ? picked.span : null;
    }

    function rangeFrom(args) {
      const word = args.join('');
      const range = T.parseRange(word, Date.now());
      if (!range) print(`unknown range "${word}" · try today, yesterday, calweek (Sunday to Saturday), week (7 days), calmonth, month (30 days), all, 3d, tue or 2026-01-31`, 'err');
      return range;
    }

    // The address used with /login, kept so /code still works if the page
    // reloads while you fetch the code (phones often reload background tabs).
    // It expires with the emailed code (an hour).
    function rememberLoginEmail(email) {
      try {
        if (email) io.storage.setItem(LOGIN_EMAIL_KEY, JSON.stringify({ email, at: Date.now() }));
        else io.storage.removeItem(LOGIN_EMAIL_KEY);
      } catch (_) { /* storage unavailable; /code needs /login in this session */ }
    }

    function loginEmail() {
      try {
        const saved = JSON.parse(io.storage.getItem(LOGIN_EMAIL_KEY));
        return saved && Date.now() - saved.at < LOGIN_CODE_TTL_MS ? saved.email : '';
      } catch (_) {
        return '';
      }
    }

    // Clean up what was typed or pasted: text copied from an email can carry
    // invisible characters, and some keyboards produce a full-width slash.
    function cleanLine(raw) {
      return String(raw).replace(/[​-‏‪-‮⁠-⁤﻿]/g, '').replace(/／/g, '/').trim();
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

    // ---- entries -------------------------------------------------------------

    function add(text) {
      if (text.length > T.MAX_TEXT) return print(`entries are limited to ${T.MAX_TEXT} characters`, 'err');
      const { category, note } = T.parseInput(text);
      const before = shown();
      // A /wolink for this category today gives the entry its work order.
      const link = linkFor(category, Date.now());
      const extra = {};
      if (link && link.wo) Object.assign(extra, { wo: link.wo, wl: true });
      if (link && link.eq) Object.assign(extra, { eq: link.eq, ql: true });
      const entry = store.add(note ? `${category} ${note}` : category, Object.keys(extra).length ? extra : undefined);
      const prev = before.length ? T.withSpans(before, entry.ts).pop() : null;
      const parts = [T.clock(entry.ts)];
      if (prev && !prev.off) parts.push(`out ${T.isMarker(prev.text) ? `of ${prev.category.replace(/[()]/g, '')}` : prev.category} (${T.formatHM(prev.duration)})`);
      parts.push(`in ${T.idTag(T.idText(entry.sid || shown().length * 10))} ${entry.wo ? `${T.woTag(entry.wo)} ` : ''}${entry.eq ? `${T.eqTag(entry.eq)} ` : ''}${describe(T.parseInput(entry.text))}`);
      print(parts.join('  '), 'ok');
      return entry;
    }

    // ---- editing and restoring -------------------------------------------------

    // Entries added or changed in /edit get the work order and equipment
    // /wolink and /eqlink linked to their category that day, like typed
    // entries, unless they have their own ([4471] in the line, or /wopunch,
    // /eqpunch).
    function withLinkedWorkOrders(ops) {
      return ops.map((op) => {
        if (op.op !== 'put' || T.isOff(op.entry) || T.isLink(op.entry)) return op;
        let e = op.entry;
        const link = linkFor(T.parseInput(e.text).category, e.ts);
        for (const k of CODES) {
          if (e[k.field] && !e[k.flag]) continue;
          const v = link && link[k.field] ? link[k.field] : '';
          if (v !== (e[k.field] || '')) e = T.makeEntry(e, { [k.field]: v, [k.flag]: Boolean(v) });
        }
        return e === op.entry ? op : { op: 'put', entry: e };
      });
    }

    function applyEdit(text, items) {
      const result = T.parseEditable(text, items, Date.now());
      if (result.errors.length) {
        print([...result.errors, inline ? 'nothing was saved; fix the lines above and /save again' : 'nothing was saved'].join('\n'), 'err');
        return false;
      }
      store.apply(withLinkedWorkOrders(result.ops));
      const parts = [];
      if (result.changed) parts.push(`${result.changed} changed`);
      if (result.added) parts.push(`${result.added} added`);
      if (result.removed) parts.push(`${result.removed} removed`);
      print(parts.length ? `saved: ${parts.join(', ')}` : 'no changes', 'ok');
      return true;
    }

    function applyRestore(text) {
      const { entries, errors } = T.parseBackup(text);
      if (errors.length) {
        const shown = errors.slice(0, 10);
        if (errors.length > shown.length) shown.push(`…and ${errors.length - shown.length} more`);
        shown.push(inline ? 'nothing was added; fix the lines above and /save again' : 'nothing was added');
        print(shown.join('\n'), 'err');
        return false;
      }
      if (!entries.length) {
        print(inline ? 'no entries found in the text; paste a backup, or /cancel' : 'no entries found in the text', 'err');
        return false;
      }
      const fresh = T.mergeBackup(store.entries, entries);
      store.apply(fresh.map((entry) => ({ op: 'put', entry })));
      const skipped = entries.length - fresh.length;
      const msg = `restored ${plural(fresh.length, 'entry', 'entries')}`;
      print(skipped ? `${msg} (${skipped} already in your log)` : msg, 'ok');
      return true;
    }

    const hasContent = (text) => text.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'));

    // Open text for editing: in the inline box (finished with /save), or in an
    // external editor, reopening it to fix mistakes.
    async function openText({ text, items, mode, label }) {
      const apply = (t) => applyText(mode, t, items);
      if (inline) {
        io.editor.open({ text, items, mode, label });
        return;
      }
      let current = `${EXTERNAL_HELP}\n${text}`;
      for (;;) {
        const edited = await io.editor.edit(current);
        if (edited == null || !hasContent(edited)) {
          print(`${mode} cancelled · nothing changed`, 'ok');
          return;
        }
        if (apply(edited)) return;
        if (!(await io.editor.confirm('open the editor again to fix it?'))) {
          print(`${mode} cancelled · nothing changed`, 'ok');
          return;
        }
        current = edited;
      }
    }

    function busy() {
      if (inline && io.editor.isOpen()) {
        print('already editing · /save or /cancel first', 'err');
        return true;
      }
      return false;
    }

    // ---- commands ------------------------------------------------------------

    const COMMANDS = {
      help: {
        usage: '/help [topic|command]',
        about: 'show this help; /help todo shows one topic, /help log one command',
        run(args) {
          const want = (args[0] || '').toLowerCase().replace(/^\//, '');
          const line = (name) => `  ${`${COMMANDS[name].usage}  `.padEnd(30)}${COMMANDS[name].about}`;
          const groups = helpGroups();
          if (want) {
            const g = groups.find((x) => x.key === want || x.words.includes(want));
            if (g) return print([`${g.title}:`, ...g.names.map(line)].join('\n'), 'report dim');
            const name = ALIASES[want] || want;
            if (COMMANDS[name]) return print(line(name).trim(), 'report dim');
            return print(`no help topic "${want}" · topics: ${groups.map((x) => x.key).join(', ')}${closest(want) ? ` · did you mean /help ${closest(want).slice(1)}?` : ''}`, 'err');
          }
          print([
            'Type what you are starting and press Enter. That clocks you in to the new',
            'entry and out of the previous one. The first word is the category.',
            '',
            '  dev fixing the login bug',
            '  mtg standup',
            '',
            ...groups.flatMap((g) => [`${g.title}  (/help ${g.key})`, ...g.names.map(line), '']),
            'Ranges: today (default), yesterday, week, month, calweek, calmonth, all,',
            '        Nd (last N days), a day name, YYYY-MM-DD, or YYYY-MM-DD..YYYY-MM-DD',
            ...(io.keys && io.keys.length ? ['', ...io.keys] : []),
            ...(io.helpFooter || []),
            '',
            `tymlee v${T.VERSION}${io.build ? ` (build ${io.build})` : ''} · ${T.REPO_URL}`,
          ].join('\n'), 'report dim');
        },
      },
      log: {
        usage: '/log [range]',
        about: 'print the log for a range',
        run(args) {
          const range = rangeFrom(args);
          if (range) print(T.formatReport(store.entries, range, Date.now(), { compact: io.compact() }), 'report');
        },
      },
      report: {
        usage: '/report [range]',
        about: 'time per category for a range, with its entries',
        run(args) {
          const range = rangeFrom(args);
          if (range) print(T.formatCategoryReport(store.entries, range, Date.now()), 'report');
        },
      },
      note: {
        usage: '/note [text]  or  /note #ID [text]',
        about: 'add a line of notes to the current entry, or pick one (Tab: older, Shift+Tab: newer)',
        async run(args) {
          if (busy()) return;
          if (!shown().length) return print('no entries to add notes to', 'err');
          if (!(await store.supports('notes'))) {
            return print('notes need the latest supabase/schema.sql on the server; run it, then /sync', 'err');
          }
          // "/note 12" or "/note #12 [text]" names an entry; any other text is
          // a new line of notes for the current entry, whatever it is (a
          // break or /off too: "/note lunch with the client").
          const named = args.length && (/^(?:#|id:)\d+$/i.test(args[0]) || (args.length === 1 && /^\d+$/.test(args[0])));
          let chosen;
          let text = '';
          if (named) {
            chosen = await chooseEntry(args.slice(0, 1), '/note #ID [text]', 'note', true);
            if (!chosen) return undefined;
            text = args.slice(1).join(' ');
          } else if (args.length) {
            const spans = T.withSpans(store.entries, Date.now());
            chosen = spans[spans.length - 1];
            text = args.join(' ');
          } else {
            chosen = await chooseEntry([], '/note [text]', 'note', true);
            if (!chosen) return print('note cancelled', 'dim');
          }
          const current = store.entries.find((e) => e.id === chosen.id);
          if (!current) return print('that entry was removed in the meantime', 'err');
          const initial = current.notes || '';
          let value;
          if (text) {
            value = initial ? `${initial}\n${text}` : text; // a new line under the notes so far
          } else {
            // Start on a new line under the notes so far.
            const typed = await io.ask(`notes for ${entryLabel(chosen)}`, initial ? `${initial}\n` : '', 'notes');
            if (typed == null) return print('note cancelled', 'dim');
            value = typed;
          }
          value = value.split('\n').map((l) => l.trimEnd()).join('\n').trim();
          if (value === initial.trim()) return print('notes unchanged', 'dim');
          if (value.length > T.MAX_NOTES) return print(`notes are limited to ${T.MAX_NOTES} characters`, 'err');
          store.apply([{ op: 'put', entry: T.makeEntry(current, { notes: value }) }]);
          print(value ? `notes saved on ${T.idTag(chosen.n)} ${describe(chosen)}` : `notes removed from ${T.idTag(chosen.n)} ${describe(chosen)}`, 'ok');
        },
      },
      file: {
        usage: '/file <path>  or  /file #ID [path]',
        about: 'add a file path to the current entry, or pick one (shown as "@ path"; %{files} in forms)',
        async run(args) {
          if (busy()) return;
          if (!shown().length) return print('no entries to add a file path to', 'err');
          const named = args.length && /^(?:#|id:)\d+$/i.test(args[0]);
          let chosen;
          let path = '';
          if (named) {
            chosen = await chooseEntry(args.slice(0, 1), '/file #ID [path]', 'file', true);
            if (!chosen) return undefined;
            path = args.slice(1).join(' ');
          } else if (args.length) {
            const spans = T.withSpans(store.entries, Date.now());
            chosen = spans[spans.length - 1];
            path = args.join(' ');
          } else {
            chosen = await chooseEntry([], '/file [path]', 'file', true);
            if (!chosen) return print('cancelled', 'dim');
          }
          const current = store.entries.find((e) => e.id === chosen.id);
          if (!current) return print('that entry was removed in the meantime', 'err');
          if (!path) {
            const typed = await io.ask(`file path for ${entryLabel(chosen)}`, '', 'file');
            if (typed == null) return print('cancelled', 'dim');
            path = typed;
          }
          path = path.trim();
          if (!path) return print('no path given', 'err');
          const files = T.joinFiles([...(current.files ? current.files.split('\n') : []), path]);
          if (files.length > T.MAX_FILES) return print(`file paths are limited to ${T.MAX_FILES} characters`, 'err');
          store.apply([{ op: 'put', entry: T.makeEntry(current, { files }) }]);
          print(`@ ${path} added to ${T.idTag(chosen.n)} ${describe(chosen)}`, 'ok');
        },
      },
      timeline: {
        usage: '/timeline [range]',
        about: 'your time as blocks on a timeline (alias /tl; on the website: the GUI view)',
        run(args) {
          const range = rangeFrom(args);
          if (!range) return;
          if (io.showTimeline) return io.showTimeline(range);
          print(T.formatTimeline(store.entries, range, Date.now(), { paint: io.paint, width: io.width ? io.width() : 80 }), 'report');
        },
      },
      ...linkCommands(CODES[0]),
      ...linkCommands(CODES[1]),
      wolist: {
        usage: '/wolist [range]',
        about: 'time per work order for a range, with linked work orders',
        run(args) {
          const range = rangeFrom(args);
          if (range) print(T.formatWorkOrders(store.entries, range, Date.now()), 'report');
        },
      },
      undo: {
        usage: '/undo',
        about: 'remove the last entry',
        run() {
          if (!shown().length) return print('nothing to undo', 'err');
          const now = Date.now();
          const last = T.withSpans(store.entries, now).pop();
          store.remove(last.id);
          const msg = [`undid ${T.idTag(last.n)} ${T.clock(last.ts)} ${describe(last)}`];
          const cur = T.withSpans(store.entries, now).pop();
          if (cur) msg.push(cur.text === T.OFF ? 'still off' : `resumed ${describe(cur)}`);
          print(msg.join('  '), 'ok');
        },
      },
      off: {
        usage: '/off',
        about: 'clock out without starting anything new',
        run() { stopFor(T.OFF, 'off'); },
      },
      'break-paid': {
        usage: '/break-paid',
        about: 'start a paid break: counts toward hours and pay, until your next entry',
        run() { stopFor(T.BREAK_PAID, 'paid break'); },
      },
      'break-unpaid': {
        usage: '/break-unpaid',
        about: 'start an unpaid break: not counted (like /off), until your next entry',
        run() { stopFor(T.BREAK_UNPAID, 'unpaid break'); },
      },
      rm: {
        usage: '/rm <ID>',
        about: 'delete an entry by its ID, or the ID\'s last digits (its time goes to the one before)',
        run(args) {
          const s = T.findById(T.withSpans(store.entries, Date.now()), args[0]);
          if (!s) return print('usage: /rm <ID>   (an entry ID from /log, or its last digits: /rm 650)', 'err');
          store.remove(s.id);
          print(`removed ${T.idTag(s.n)} ${T.ymd(s.ts)} ${T.clock(s.ts)} ${describe(s)}`, 'ok');
        },
      },
      export: {
        usage: '/export [range] [csv]',
        about: 'save the log as .txt (or .csv)',
        async run(args) {
          const csv = args.some((a) => a.toLowerCase() === 'csv');
          const range = rangeFrom(args.filter((a) => a.toLowerCase() !== 'csv'));
          if (!range) return;
          const now = Date.now();
          const count = shown().filter((e) => e.ts >= range.from && e.ts < range.to).length;
          if (!count) return print(`no entries (${range.label})`, 'err');
          const body = csv ? T.toCSV(store.entries, range, now) : T.formatReport(store.entries, range, now) + '\n';
          const name = `tymlee-${range.label === 'today' ? T.ymd(now) : range.label}.${csv ? 'csv' : 'txt'}`;
          const where = await io.save(name, body, csv ? 'text/csv' : 'text/plain');
          print(`exported ${plural(count, 'entry', 'entries')} -> ${where}`, 'ok');
        },
      },
      copy: {
        usage: '/copy [range]',
        about: 'copy the log to the clipboard',
        async run(args) {
          const range = rangeFrom(args);
          if (!range) return;
          try {
            await io.copy(T.formatReport(store.entries, range, Date.now()));
          } catch (err) {
            return print(`${(err && err.message) || 'could not copy'} · /export saves a file instead`, 'err');
          }
          print(`copied ${range.label} to clipboard`, 'ok');
        },
      },
      login: {
        usage: '/login <email>',
        about: `sign in to sync across devices (emails you ${io.linkSignIn ? 'a link and a code' : 'a code'})`,
        async run(args) {
          const email = (args[0] || '').trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return print('usage: /login you@example.com', 'err');
          if (store.user) return print(`already signed in as ${store.user.email} · /logout first`, 'err');
          await store.login(email);
          rememberLoginEmail(email);
          print(io.linkSignIn
            ? `sent a sign-in email to ${email}. Type /code <code from the email>, or open the link in it on this device.`
            : `sent a sign-in email to ${email}. Type /code <code from the email>.`, 'ok');
        },
      },
      code: {
        usage: '/code <code>',
        about: 'finish signing in with the code from the email',
        async run(args) {
          const code = (args[0] || '').trim();
          const email = loginEmail();
          if (store.user) return print(`already signed in as ${store.user.email}`, 'err');
          if (!email) return print('not signed in · /login you@example.com', 'err');
          if (!/^\d{6,10}$/.test(code)) return print('usage: /code 123456  (the number from the sign-in email)', 'err');
          await store.verify(email, code);
          rememberLoginEmail('');
        },
      },
      logout: {
        usage: '/logout',
        about: `sign out and remove your synced log from ${io.place}`,
        async run(args) {
          if (!store.user) return print('not signed in', 'err');
          if (store.pending && args[0] !== 'force') {
            return print(`${plural(store.pending, 'change has', 'changes have')} not synced yet · /sync, or /logout force to discard ${store.pending === 1 ? 'it' : 'them'}`, 'err');
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
      'reset-encryption': {
        usage: '/reset-encryption',
        about: 'lost every device with the key and the recovery key? start over (deletes the synced log)',
        async run(args) {
          if (!store.user) return print('not signed in · /login you@example.com', 'err');
          if (store.encryption === 'ready') return print('this device has the key, so there is nothing to reset · /recovery makes a new recovery key', 'err');
          if (store.encryption !== 'locked') return print("this account's log isn't locked, so there is nothing to reset", 'err');
          print([
            'This starts over with a new encryption key, for when no device has the key and the recovery key is lost.',
            '',
            "  - Your synced log and settings are deleted. Without the old key nobody can decrypt them, you included.",
            '  - Entries typed on this device that were never uploaded are kept.',
            '  - Other devices that still have the old key are asked to link again, and then upload what they have.',
            '  - You get a new recovery key.',
          ].join('\n'), 'key');
          const typed = args[0] === 'DELETE' ? 'DELETE' : await io.ask('type DELETE to start over', '', 'confirm');
          if (typed == null || typed.trim() !== 'DELETE') return print('reset cancelled · nothing changed', 'dim');
          print('deleting the synced log and making a new key…', 'dim');
          await store.resetEncryption();
          print('encryption reset: this device has the new key', 'ok');
        },
      },
      whoami: {
        usage: '/whoami',
        about: 'show the account and sync state',
        run() {
          if (!store.configured) return print(`local only · entries are kept on ${io.place} (sync is not configured)`, 'dim');
          if (!store.user) return print(`signed out · entries are kept on ${io.place} · /login you@example.com to sync`, 'dim');
          const state = store.pending ? `${plural(store.pending, 'change', 'changes')} waiting to sync` : 'all changes synced';
          const err = store.lastError ? `\nlast error: ${store.lastError}` : '';
          const crypt = {
            ready: store.timesSealed ? 'encrypted (text and times): this device has the key' : 'encrypted (text): this device has the key',
            locked: "encrypted: this device doesn't have the key yet (/link or /recover)",
            plain: 'not encrypted: the server is not set up for it yet',
            none: 'not encrypted: type /encrypt to turn it on',
            pending: 'encryption: checking…',
          }[store.encryption] || '';
          print(`${store.user.email} · ${shown().length} entries · ${state}\n${crypt}${err}`, 'dim');
        },
      },
      sync: {
        usage: '/sync',
        about: 'send and fetch changes now',
        async run() {
          if (!store.user) return print('not signed in · /login you@example.com to sync', 'err');
          await store.sync({ full: true });
          if (store.status === 'synced') print(`synced · ${shown().length} entries`, 'ok');
          else print(`sync failed: ${store.lastError || store.status}`, 'err');
        },
      },
      import: {
        usage: '/import',
        about: 'add entries logged while signed out to your account',
        run() {
          const n = store.importLocal();
          print(n ? `imported ${plural(n, 'entry', 'entries')}` : 'nothing to import', 'ok');
        },
      },
      edit: {
        usage: '/edit [range]',
        about: 'edit entries as text (default: the last 24 hours)',
        async run(args) {
          if (busy()) return;
          const now = Date.now();
          const range = args.length ? rangeFrom(args) : { from: now - 86400000, to: Infinity, label: 'last 24 hours' };
          if (!range) return;
          const { text, items } = T.formatEditable(store.entries, range, now);
          print(inline
            ? `editing ${range.label} (${plural(items.length, 'entry', 'entries')}) · /save to apply, /cancel to discard`
            : `editing ${range.label} (${plural(items.length, 'entry', 'entries')}) in your editor…`, 'dim');
          await openText({ text, items, mode: 'edit', label: `Edit entries (${range.label})` });
        },
      },
      restore: {
        usage: io.restoreUsage || '/restore [file]',
        about: 'add entries from a backup: paste it, or read a .txt/.csv file',
        async run(args) {
          if (busy()) return;
          let text = '';
          if (args.length) {
            const got = await io.pickFile(args);
            if (got == null) return;
            if (busy()) return;
            text = got;
          }
          // A full backup (/backup) goes straight back: nothing to edit.
          const full = T.readFullBackup(text);
          if (full) return restoreFull(full);
          print(inline
            ? 'restoring from a backup · /save to add the entries, /cancel to discard'
            : 'restoring from a backup in your editor…', 'dim');
          await openText({ text: `${RESTORE_HELP.join('\n')}\n\n${text}`, mode: 'restore', label: 'Backup to restore' });
        },
      },
      ...(inline ? {
        save: {
          usage: '/save',
          about: 'save /edit changes, /restore entries or a form (Ctrl+Enter)',
          run() {
            if (!io.editor.isOpen()) return print('nothing to save · start with /edit, /restore or /newform', 'err');
            const text = io.editor.value();
            const mode = io.editor.mode();
            const ok = applyText(mode, text, io.editor.items());
            if (ok) io.editor.close();
          },
        },
        cancel: {
          usage: '/cancel',
          about: 'close /edit, /restore or a form without changing anything',
          run() {
            if (!io.editor.isOpen()) return print('nothing to cancel', 'err');
            const what = { restore: 'restore', form: 'form', checklist: 'checklist', checkrun: 'checklist' }[io.editor.mode()] || 'edit';
            io.editor.close();
            print(`${what} cancelled · nothing changed`, 'ok');
          },
        },
      } : {}),
      rate: {
        usage: '/rate [amount|off]',
        about: 'your hourly pay rate, e.g. /rate 32.50 (shows pay in the status bar)',
        run(args) {
          paySetting('rate', args.join(''), {
            show: (n) => `${T.formatMoney(n)} an hour`,
            check: (n) => (n > 0 && n < 100000 ? '' : 'the rate should be more than 0'),
            unit: (pay) => (T.payValue(pay, 'otmin', Date.now()) == null ? ' · /otmin sets when overtime starts' : ''),
          });
        },
      },
      otmin: {
        usage: '/otmin [hours|off]',
        about: 'hours in a week (Sunday to Saturday) before overtime, e.g. /otmin 40',
        run(args) {
          paySetting('otmin', args.join(''), {
            show: (n) => `overtime after ${n} hours a week (Sunday to Saturday)`,
            check: (n) => (n > 0 && n <= 168 ? '' : 'that should be between 0 and 168 hours'),
            unit: (pay) => {
              const f = T.payValue(pay, 'otrate', Date.now());
              return f == null ? `, paid at 1.5× (/otrate changes it)` : `, paid at ${f}×`;
            },
          });
        },
      },
      otrate: {
        usage: '/otrate [factor|off]',
        about: 'what overtime multiplies your rate by, e.g. /otrate 1.5',
        run(args) {
          paySetting('otrate', args.join(''), {
            show: (n) => `overtime paid at ${n}× your rate`,
            check: (n) => (n >= 1 && n <= 10 ? '' : 'that should be between 1 and 10'),
          });
        },
      },
      form: {
        usage: '/form [name] [day]',
        about: 'fill in one of your forms from the log, e.g. /form service tue; /form alone lists forms and tokens',
        async run(args) {
          if (!args.length) {
            const width = Math.max(...T.FORM_TOKENS.map(([t]) => t.length)) + 5;
            return print([
              `forms: ${formList()}`,
              '/form <name> [day]   fill one in (today, yesterday, tue, 2026-09-29, week)',
              '/newform <name>  /editform <name>  /delform <name>',
              '',
              'tokens (worked out from the entries they cover):',
              ...T.FORM_TOKENS.map(([t, what]) => `  ${`%{${t}}`.padEnd(width)}${what}`),
              `  ${'%{ask:Label}'.padEnd(width)}asked for when you fill it in (your last answer is offered)`,
              '',
              'repeat part of a form per group; tokens inside cover just that group:',
              '  %{each category} ... %{end}    also %{each wo}, %{each equipment} and %{each entry}',
              'outside any %{each}, tokens cover the whole day; inside %{each entry}, %{in} and %{out} are that entry\'s',
              'a token alone on its line that comes out empty (no notes, say) leaves no blank line',
            ].join('\n'), 'report');
          }
          await fillForm(args[0], args.slice(1));
        },
      },
      newform: {
        usage: '/newform <name>',
        about: 'write a new form template (paste yours, add %{tokens})',
        async run(args) {
          const name = args[0];
          if (!validFormName(name)) return print('usage: /newform <name>   (letters, numbers, - and _)', 'err');
          if (formName(name)) return print(`there is already a form called ${formName(name)} · /editform ${formName(name)} changes it`, 'err');
          await openForm(name, FORM_STARTER);
        },
      },
      editform: {
        usage: '/editform <name>',
        about: 'change one of your forms',
        async run(args) {
          const found = formName(args[0]);
          if (!found) return print(args[0] ? `no form called "${args[0]}" · your forms: ${formList()}` : `usage: /editform <name> · your forms: ${formList()}`, 'err');
          await openForm(found, forms()[found]);
        },
      },
      delform: {
        usage: '/delform <name>',
        about: 'delete one of your forms',
        run(args) {
          const found = formName(args[0]);
          if (!found) return print(args[0] ? `no form called "${args[0]}" · your forms: ${formList()}` : `usage: /delform <name> · your forms: ${formList()}`, 'err');
          deleteForm(found);
          print(`form ${found} deleted`, 'ok');
        },
      },
      checklist: {
        usage: '/checklist',
        about: 'your checklist templates, and the checklists you started',
        run() { print(formatChecklists(), 'report'); },
      },
      newchecklist: {
        usage: '/newchecklist <name>',
        about: 'write a checklist: one thing to check per line',
        async run(args) {
          const name = args[0];
          if (!validFormName(name)) return print('usage: /newchecklist <name>   (letters, numbers, - and _)', 'err');
          if (templateFor(name)) return print(`there is already a checklist called ${templateFor(name).name} · /editchecklist ${templateFor(name).name} changes it`, 'err');
          print(inline ? `writing checklist ${name} · /save to keep it, /cancel to discard` : `writing checklist ${name} in your editor…`, 'dim');
          await openText({ text: `${CHECK_HELP.join('\n')}\n\n`, items: { checklist: name }, mode: 'checklist', label: `Checklist ${name}` });
        },
      },
      editchecklist: {
        usage: '/editchecklist <name>',
        about: 'change a checklist template (started ones keep their items)',
        async run(args) {
          const c = templateFor(args[0]);
          if (!c) return print(`usage: /editchecklist <name> · your checklists: ${Object.keys(templates()).sort().join(', ') || 'none yet'}`, 'err');
          print(inline ? `editing checklist ${c.name} · /save to keep it, /cancel to discard` : `editing checklist ${c.name} in your editor…`, 'dim');
          await openText({ text: `${CHECK_HELP.join('\n')}\n\n${c.text}\n`, items: { checklist: c.name }, mode: 'checklist', label: `Checklist ${c.name}` });
        },
      },
      delchecklist: {
        usage: '/delchecklist <name>',
        about: 'delete a checklist template (started ones are kept)',
        run(args) {
          const name = String(args[0] || '').toLowerCase();
          const ids = store.listRecords('checklist').filter((c) => c.name.toLowerCase() === name).map((c) => c.id);
          if (!ids.length) return print(`usage: /delchecklist <name> · your checklists: ${Object.keys(templates()).sort().join(', ') || 'none yet'}`, 'err');
          store.deleteRecords(ids);
          print(`checklist ${args[0]} deleted`, 'ok');
        },
      },
      check: {
        usage: '/check <name> [label]  or  /check <CL>',
        about: 'start a checklist from a template (and tick its items), or open one you started',
        async run(args) {
          if (busy()) return;
          if (!args.length) return print(formatChecklists(), 'report');
          if (/^(?:cl:|#)?\d+$/i.test(args[0])) {
            const run = T.findById(runs(), args[0].replace(/^(?:cl:|#)/i, ''));
            if (!run) return print(`no checklist ${args[0]} · /checklist lists them`, 'err');
            return openRun(run);
          }
          const c = templateFor(args[0]);
          if (!c) return print(`no checklist called "${args[0]}" · your checklists: ${Object.keys(templates()).sort().join(', ') || 'none yet'} · /newchecklist ${args[0]} makes it`, 'err');
          const run = startRun(c, args.slice(1).join(' '));
          print(`started ${run.tag} ${run.title} (${plural(run.items.length, 'item', 'items')})`, 'ok');
          await openRun(run);
        },
      },
      delcheck: {
        usage: '/delcheck <CL>',
        about: 'delete a checklist you started',
        run(args) {
          const run = T.findById(runs(), String(args[0] || '').replace(/^(?:cl:|#)/i, ''));
          if (!run) return print('usage: /delcheck <CL>   (an ID from /checklist, or its last digits)', 'err');
          store.deleteRecords([run.id]);
          print(`deleted ${run.tag} ${run.title}`, 'ok');
        },
      },
      find: {
        usage: '/find <words>',
        about: 'search entries (text, notes, file paths, work orders, equipment) and to-dos',
        run(args) {
          if (!args.length) return print('usage: /find <words>, e.g. /find stems label', 'err');
          const query = args.join(' ');
          const r = T.formatSearch(store.entries, query, Date.now(), 100, { compact: io.compact() });
          const words = query.toLowerCase().split(/\s+/);
          const todosFound = todos().filter((t) => words.every((w) => t.text.toLowerCase().includes(w)));
          const lines = [r.text];
          if (todosFound.length) {
            lines.push('', `to-dos: ${todosFound.length}`);
            for (const t of todosFound) lines.push(`  [${t.done ? 'x' : ' '}] ${t.tag}  ${t.text}`);
          }
          print(lines.join('\n'), 'report');
        },
      },
      backup: {
        usage: '/backup',
        about: 'save everything in one file: entries, forms, to-dos, checklists, settings (/restore reads it)',
        async run() { await saveFullBackup(); },
      },
      trash: {
        usage: '/trash',
        about: 'entries deleted in the last 30 days; /untrash <ID> puts one back',
        run() {
          const list = trashed();
          if (!list.length) return print('the trash is empty (deleted entries stay here for 30 days)', 'dim');
          const lines = [`trash: ${plural(list.length, 'entry', 'entries')} · /untrash <ID> puts one back`];
          for (const t of list) {
            const e = t.entry;
            const what = T.isMarker(e.text) ? T.withSpans([e], e.ts)[0].category : e.text;
            lines.push(`  ${T.idTag(T.idText(e.sid || 0))}  ${T.ymd(e.ts)} ${T.clock(e.ts)}  ${what}  (deleted ${T.ymd(t.deletedAt).slice(5)})`);
          }
          print(lines.join('\n'), 'report');
        },
      },
      untrash: {
        usage: '/untrash <ID>',
        about: 'put a deleted entry back (from /trash)',
        run(args) {
          const list = trashed();
          // Oldest deletion first, so a short ID means the latest one deleted.
          const found = T.findById(list.slice().reverse().map((t) => ({ n: T.idText(t.entry.sid || 0), t })), args[0]);
          if (!found) return print('usage: /untrash <ID>   (an entry ID from /trash, or its last digits)', 'err');
          const { t } = found;
          if (store.entries.some((e) => e.id === t.entry.id)) {
            store.deleteRecords([t.id]);
            return print('that entry is already back in the log', 'dim');
          }
          store.apply([{ op: 'put', entry: t.entry }]);
          store.deleteRecords([t.id]);
          print(`put back ${T.idTag(T.idText(t.entry.sid || 0))} ${T.ymd(t.entry.ts)} ${T.clock(t.entry.ts)} ${t.entry.text}`, 'ok');
        },
      },
      todo: {
        usage: '/todo <category> <what to do>',
        about: 'add a to-do (no times; open until /done). /todo alone lists them',
        run(args) {
          if (!args.length) return print(formatTodos(), 'report');
          addTodo(args.join(' '));
        },
      },
      todos: {
        usage: '/todos [all|today]',
        about: 'the open to-dos (all: the done ones too; today: due today or overdue)',
        run(args) {
          const a = (args[0] || '').toLowerCase();
          print(formatTodos(a === 'all' ? 'all' : a === 'today' ? 'today' : 'open'), 'report');
        },
      },
      due: {
        usage: '/due <TD> [day]',
        about: 'set when a to-do is due (today, tomorrow, fri, +3, 10-09); no day clears it',
        run(args) {
          const t = T.findById(todos(), String(args[0] || '').replace(/^td:/i, ''));
          if (!t) return print('usage: /due <TD> [day]   e.g. /due 20 fri, /due 20 10-09, /due 20 (clears it)', 'err');
          if (args.length < 2) {
            if (!t.due) return print(`${t.tag} has no due day`, 'dim');
            saveTodo(t, { due: null });
            return print(`${t.tag} ${t.text} · no due day`, 'ok');
          }
          const due = T.parseDue(args[1], Date.now());
          if (!due) return print(`"${args[1]}" is not a day · try today, tomorrow, fri, +3 or 10-09`, 'err');
          saveTodo(t, { due });
          print(`${t.tag} ${t.text} · ${T.dueLabel(due, Date.now()).text}`, 'ok');
        },
      },
      do: {
        usage: '/do <TD>',
        about: 'start working on a to-do: an entry with its category and text; /done alone then marks it done',
        run(args) { doTodo(args[0]); },
      },
      done: {
        usage: '/done [TD] [more]',
        about: 'mark to-dos done, by ID or its last digits: /done 20 (alone: the one started with /do)',
        run(args) { markTodos(args, true); },
      },
      undone: {
        usage: '/undone <TD> [more]',
        about: 'open a done to-do again',
        run(args) { markTodos(args, false); },
      },
      deltodo: {
        usage: '/deltodo <TD>',
        about: 'delete a to-do',
        run(args) {
          const t = T.findById(todos(), String(args[0] || '').replace(/^td:/i, ''));
          if (!t) return print('usage: /deltodo <TD>   (a to-do ID from /todos, or its last digits)', 'err');
          store.deleteRecords([t.id]);
          print(`deleted ${t.tag} ${t.text}`, 'ok');
        },
      },
      clock: {
        usage: '/clock [12|24]',
        about: 'show times on the 12-hour (2:30pm) or 24-hour (14:30) clock',
        run(args) {
          const arg = (args[0] || '').toLowerCase().replace(/h$/, '');
          if (!arg) return print(`clock: ${applyClock()}-hour`, 'ok');
          if (arg !== '12' && arg !== '24') return print('usage: /clock 12 or /clock 24', 'err');
          setClock(arg);
          print(`clock: ${arg}-hour, e.g. ${T.clock(Date.now())}`, 'ok');
        },
      },
      accent: {
        usage: '/accent [color]',
        about: `the website's accent color: ${Object.keys(T.ACCENTS).join(', ')}, any #rrggbb, or default`,
        run(args) {
          const arg = (args[0] || '').toLowerCase();
          const names = Object.keys(T.ACCENTS).join(', ');
          if (!arg) return print(`accent: ${store.settings.accent || T.DEFAULT_ACCENT} · choose from ${names}, or any #rrggbb`, 'ok');
          if (arg === 'default' || arg === T.DEFAULT_ACCENT) {
            const { accent, ...rest } = store.settings;
            store.setSettings(rest);
            return print(`accent: ${T.DEFAULT_ACCENT} (the default)`, 'ok');
          }
          const c = T.accentColors(arg.startsWith('#') || /^[0-9a-f]{6}$/.test(arg) ? `#${arg.replace(/^#/, '')}` : arg);
          if (!c) return print(`"${args[0]}" is not a color · try ${names}, or #rrggbb like #0a7d4f`, 'err');
          store.setSettings({ ...store.settings, accent: c.name });
          print(`accent: ${c.name}${io.place === 'this browser' || !io.place ? '' : ' (shows on the website)'}`, 'ok');
        },
      },
      clear: {
        usage: '/clear',
        about: 'clear the screen (the log is kept)',
        run() { io.clear(); },
      },
      ...(io.extra || {}),
    };
    const ALIASES = { ls: 'log', h: 'help', '?': 'help', z: 'undo', tl: 'timeline' };
    const commandWords = Object.keys(COMMANDS).map((c) => '/' + c);

    // /help's topics, in order. A command not listed lands in the last one.
    const HELP_TOPICS = [
      ['entries', 'Entries', ['entry', 'entries'], ['off', 'break-paid', 'break-unpaid', 'undo', 'note', 'file', 'edit', 'rm', 'trash', 'untrash']],
      ['links', 'Work orders and equipment', ['wo', 'eq', 'equipment', 'workorders'], ['wolink', 'wopunch', 'eqlink', 'eqpunch', 'wolist']],
      ['reports', 'Reports and search', ['report', 'search', 'find'], ['log', 'report', 'timeline', 'find', 'export', 'copy']],
      ['todo', 'To-dos and checklists', ['todos', 'to-do', 'checklist', 'checklists'], ['todo', 'todos', 'do', 'done', 'undone', 'due', 'deltodo', 'checklist', 'check', 'newchecklist', 'editchecklist', 'delchecklist', 'delcheck']],
      ['forms', 'Forms', ['form'], ['form', 'newform', 'editform', 'delform']],
      ['pay', 'Pay', ['rate', 'overtime'], ['rate', 'otmin', 'otrate']],
      ['backup', 'Backup', ['restore', 'import'], ['backup', 'restore', 'import', 'save']],
      ['account', 'Account, sync and encryption', ['sync', 'login', 'encryption'], ['login', 'code', 'logout', 'whoami', 'sync', 'encrypt', 'link', 'recover', 'recovery', 'reset-encryption']],
      ['more', 'More', ['other', 'display', 'view'], ['clock', 'accent']],
    ];
    function helpGroups() {
      const placed = new Set();
      const groups = HELP_TOPICS.map(([key, title, words, names]) => {
        const here = names.filter((n) => COMMANDS[n] && !placed.has(n));
        here.forEach((n) => placed.add(n));
        return { key, title, words, names: here };
      });
      groups[groups.length - 1].names.push(...Object.keys(COMMANDS).filter((n) => !placed.has(n)));
      return groups.filter((g) => g.names.length);
    }

    // The commands closest to a mistyped one ("/tods" -> "/todo or /todos"),
    // or '' when nothing is close.
    function closest(word) {
      const w = word.toLowerCase();
      const scored = [...Object.keys(COMMANDS), ...Object.keys(ALIASES)]
        .map((c) => ({ c: ALIASES[c] || c, d: editDistance(w, c) }));
      const best = Math.min(...scored.map((x) => x.d));
      if (best > Math.max(1, Math.min(2, Math.floor(w.length / 3)))) return '';
      const near = [...new Set(scored.filter((x) => x.d === best).map((x) => `/${x.c}`))].slice(0, 3);
      return near.join(' or ');
    }

    // Typing distance between two words: letters added, removed, changed,
    // or two neighbors swapped, each counting one.
    function editDistance(a, b) {
      const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
      for (let j = 1; j <= b.length; j++) d[0][j] = j;
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
      return d[a.length][b.length];
    }

    // ---- running lines ---------------------------------------------------------

    // What a typed line should run as (cleaned; sign-in codes caught).
    function route(raw) {
      const typed = cleanLine(raw);
      return asCodeCommand(typed) || typed;
    }

    // Run a routed line: a command, or a new entry. Resolves when done.
    async function run(line) {
      if (!line) return;
      applyClock();
      if (!line.startsWith('/')) {
        add(line);
        return;
      }
      const [word, ...args] = line.slice(1).trim().split(/\s+/);
      const name = ALIASES[word.toLowerCase()] || word.toLowerCase();
      const cmd = COMMANDS[name];
      if (!cmd) {
        const near = closest(word);
        print(`unknown command "/${word}"${near ? ` · did you mean ${near}?` : ''} · /help lists them`, 'err');
        return;
      }
      try {
        await cmd.run(args);
      } catch (err) {
        print((err && err.message) || String(err), 'err');
      }
    }

    // Words that complete what has been typed: commands after "/", categories
    // otherwise.
    function completions(text, opts) {
      // Form names after /form, /editform and /delform; checklist names
      // after /check, /editchecklist and /delchecklist.
      let m = text.match(/^(\/(?:form|editform|delform)\s+)(\S*)$/i);
      if (m) return T.suggest(m[2], Object.keys(forms()).sort(), opts).map((n) => m[1] + n);
      m = text.match(/^(\/(?:check|editchecklist|delchecklist)\s+)(\S*)$/i);
      if (m) return T.suggest(m[2], Object.keys(templates()).sort(), opts).map((n) => m[1] + n);
      // To-dos after /do, /done, /due and /deltodo (open ones) or /undone
      // (done ones): by the start of the short ID, or a word in the to-do.
      m = text.match(/^(\/(do|done|undone|due|deltodo)\s+)(\S*)$/i);
      if (m) {
        const q = m[3].toLowerCase().replace(/^td:/, '');
        const { limit = 8 } = opts || {};
        return todos()
          .filter((t) => (m[2].toLowerCase() === 'undone' ? t.done : !t.done))
          .filter((t) => !q || shortId(t).startsWith(q) || t.text.toLowerCase().includes(q))
          .slice(0, limit)
          .map((t) => m[1] + shortId(t))
          .filter((c) => (opts && opts.includeExact) || c !== text);
      }
      return T.suggest(text, text.startsWith('/') ? commandWords : T.knownCategories(store.entries), opts);
    }

    // A to-do's ID without its leading zeros, as typed: 000020 -> 20.
    const shortId = (t) => String(t.sid);

    // What a completion is, when the completion alone doesn't say: the to-do
    // for "/do 20".
    function completionHint(line) {
      const m = String(line).trim().match(/^\/(?:do|done|undone|due|deltodo)\s+(\d+)$/i);
      if (!m) return '';
      const t = todos().find((x) => String(x.sid) === m[1]);
      return t ? t.text : '';
    }

    // ---- status line -------------------------------------------------------------

    function syncLabel() {
      const label = SYNC_LABELS[store.status] || store.status;
      return store.user && store.pending && store.status !== 'synced' ? `${label} (${store.pending})` : label;
    }

    // What the status line shows. `state` is 'idle', 'off' or 'running'.
    function status(now) {
      applyClock();
      const sync = { status: store.status, label: syncLabel() };
      if (!shown().length) return { state: 'idle', text: 'not clocked in · type /help', sync, due: dueCount() };
      const spans = T.withSpans(store.entries, now);
      const cur = spans[spans.length - 1];
      // Same rule as the report: an entry counts toward the day it started on.
      const dayStart = T.startOfDay(now);
      const todayMs = spans.reduce((sum, s) => sum + (s.ts >= dayStart && !s.off ? s.duration : 0), 0);
      // Pay, once there's a rate: this entry's so far, and today's.
      let money = null;
      let todayMoney = null;
      let ot = false;
      const pay = loadPay();
      if (T.hasPay(pay)) {
        const earned = T.earnings(store.entries, pay, now);
        const mine = earned.get(cur.id);
        if (!cur.off && mine && mine.money != null) {
          money = T.formatMoney(mine.money);
          ot = mine.ot;
        }
        let sum = 0;
        let any = false;
        for (const s of spans) {
          const e = s.ts >= dayStart && earned.get(s.id);
          if (e && e.money != null) { sum += e.money; any = true; }
        }
        if (any) todayMoney = T.formatMoney(sum);
      }
      const linked = runningTodo();
      const last = lastTask();
      return {
        state: cur.off ? 'off' : 'running',
        offLabel: cur.off ? cur.category.replace(/[()]/g, '') : '',
        // For the GUI's start bar: which break this is (if any), the to-do
        // started with /do, the last task (for Resume / Back to work), and
        // what's running, split into category and note.
        brk: cur.text === T.BREAK_PAID ? 'paid' : cur.text === T.BREAK_UNPAID ? 'unpaid' : '',
        todo: linked ? { id: linked.id, tag: linked.tag } : null,
        due: dueCount(), // open to-dos due today or overdue
        last: last ? last.text : '',
        category: T.isMarker(cur.text) ? '' : cur.category,
        note: T.isMarker(cur.text) ? '' : cur.note,
        wo: cur.wo || '',
        clock: T.formatClock(cur.duration),
        money,
        ot,
        todayMoney,
        what: `${cur.wo ? `${T.woTag(cur.wo)} ` : ''}${describe(cur)}`,
        today: `today ${T.formatHM(todayMs)}`,
        since: T.clock(cur.ts),
        sync,
      };
    }

    return {
      route,
      run,
      completions,
      completionHint,
      status,
      applyClock,
      setClock,
      formNames: () => Object.keys(forms()).sort(),
      startupNotices,
      // For the GUI's checklists.
      checklistNames: () => Object.keys(templates()).sort(),
      checkRuns: () => runs(),
      startCheckRun(name, label) {
        const c = templateFor(name);
        return c ? startRun(c, label) : null;
      },
      setCheckItem(id, i, done) {
        const run = runs().find((r) => r.id === id);
        if (!run || !run.items[i]) return;
        saveRun(run, run.items.map((it, j) => (j === i ? { ...it, done } : it)));
      },
      // For the GUI's to-do list.
      todoList: () => todos(),
      setTodoDone(id, done) {
        const t = todos().find((x) => x.id === id);
        if (t) saveTodo(t, { done, doneAt: done ? Date.now() : null });
      },
      doTodo(id) {
        const t = todos().find((x) => x.id === id);
        if (t) doTodo(t.n);
      },
      runningTodoId: () => (runningTodo() || {}).id || null,
      dueCount,
      formQuestions,
      presetAnswers,
      commandWords,
      recentTexts: (n) => shown().slice(-n).map((e) => e.text),
    };
  }

  const api = { createShell };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TymleeShell = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
