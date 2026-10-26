// Entry storage. Always works offline from local storage; when Supabase is
// configured (config.js) and the user is signed in, changes are queued and
// synced to their account, and the account's entries are pulled back down.
// Entry text is encrypted before upload once the account has a key (vault.js).
//
// Runs in the browser and in the terminal app: everything that depends on
// where it runs (storage, the Supabase client, online/visibility events,
// timers) comes from an `env` object. browserEnv() is the browser's.
(function (root) {
  'use strict';
  const LEGACY_KEY = 'tymlee.entries.v1';
  const LOCAL = 'local'; // owner id for the signed-out, this-browser-only log
  const SUPABASE_SRC = 'vendor/supabase.js';
  const PULL_EVERY_MS = 60000;
  // Routine checks only download entries from the last two weeks, so their
  // size stays small however long the log gets. A full download happens on
  // page load, sign-in, /sync, and at least every few hours.
  const RECENT_MS = 14 * 86400000;
  const FULL_EVERY_MS = 6 * 3600000;
  const LINK_TTL_MS = 10 * 60000;

  function browserEnv() {
    const w = root;
    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = w.document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`could not load ${src}`));
        w.document.head.append(s);
      });
    }
    return {
      T: w.Tymlee,
      V: w.TymleeVault,
      config: w.TYMLEE_CONFIG || {},
      place: 'this browser',
      storage: w.localStorage,
      async createClient(url, key, auth) {
        if (!w.supabase) await loadScript(SUPABASE_SRC);
        return w.supabase.createClient(url, key, { auth: { ...auth, detectSessionInUrl: true } });
      },
      isOnline: () => w.navigator.onLine !== false,
      // Calls `on.online`, `on.offline`, `on.visible` and, every `ms` while
      // the page is visible, `on.tick`.
      watch(on, ms) {
        w.addEventListener('online', on.online);
        w.addEventListener('offline', on.offline);
        w.document.addEventListener('visibilitychange', () => {
          if (w.document.visibilityState === 'visible') on.visible();
        });
        setInterval(() => { if (w.document.visibilityState !== 'hidden') on.tick(); }, ms);
      },
      redirectUrl: () => w.location.origin + w.location.pathname,
      passkeys: w.PublicKeyCredential && w.navigator.credentials ? browserPasskeys(w) : null,
    };
  }

  // ---- passkeys in the browser (WebAuthn) ------------------------------------
  // get/create take the server's JSON options and ask for the PRF extension;
  // they return the credential as JSON for the server, *without* the PRF
  // result, and the PRF secret separately (it must never be sent anywhere).
  function browserPasskeys(w) {
    const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unb64u = (text) => {
      const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text).length + 3) % 4));
      return Uint8Array.from(s, (c) => c.charCodeAt(0));
    };
    const creds = (list) => (list || []).map((c) => ({ ...c, type: c.type || 'public-key', id: unb64u(c.id) }));
    const secretOf = (cred) => {
      const r = cred.getClientExtensionResults && cred.getClientExtensionResults().prf;
      const first = r && r.results && r.results.first;
      return first ? new Uint8Array(first) : null;
    };
    const prfInput = () => w.TymleeVault.PRF_INPUT;
    return {
      random: () => b64u(w.crypto.getRandomValues(new Uint8Array(32))),
      async get(json, { allow } = {}) {
        const publicKey = { ...json, challenge: unb64u(json.challenge), allowCredentials: creds(allow ? allow.map((id) => ({ id })) : json.allowCredentials) };
        publicKey.extensions = { ...(json.extensions || {}), prf: { eval: { first: prfInput() } } };
        const cred = await w.navigator.credentials.get({ publicKey });
        const r = cred.response;
        return {
          id: cred.id,
          secret: secretOf(cred),
          credential: {
            id: cred.id, rawId: cred.id, type: 'public-key',
            response: {
              clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature),
              ...(r.userHandle ? { userHandle: b64u(r.userHandle) } : {}),
            },
            clientExtensionResults: {},
            authenticatorAttachment: cred.authenticatorAttachment || undefined,
          },
        };
      },
      async create(json) {
        const publicKey = {
          ...json,
          challenge: unb64u(json.challenge),
          user: { ...json.user, id: unb64u(json.user.id) },
          excludeCredentials: creds(json.excludeCredentials),
          extensions: { ...(json.extensions || {}), prf: { eval: { first: prfInput() } } },
        };
        const cred = await w.navigator.credentials.create({ publicKey });
        const r = cred.response;
        const prf = cred.getClientExtensionResults ? cred.getClientExtensionResults().prf : null;
        return {
          id: cred.id,
          secret: secretOf(cred),
          prfEnabled: prf ? Boolean(prf.enabled || (prf.results && prf.results.first)) : false,
          credential: {
            id: cred.id, rawId: cred.id, type: 'public-key',
            response: {
              attestationObject: b64u(r.attestationObject), clientDataJSON: b64u(r.clientDataJSON),
              ...(r.getTransports ? { transports: r.getTransports() } : {}),
            },
            clientExtensionResults: {},
            authenticatorAttachment: cred.authenticatorAttachment || undefined,
          },
        };
      },
    };
  }

  // `storage` replaces the browser's local storage (app.js passes IndexedDB).
  function createStore({ onChange, onNotice, env: givenEnv, storage: givenStorage }) {
    const env = givenEnv || browserEnv();
    if (givenStorage) env.storage = givenStorage;
    const { T, V, storage } = env;
    const config = env.config || {};
    const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
    // Sync without encryption only where the site's own config allows it (a
    // self-hosted server without the encryption part of schema.sql). Never
    // because the server says so: a server that claimed to have no keyring
    // would otherwise get everything in plain text.
    const allowPlain = Boolean(config.allowUnencrypted);

    let client = null;
    let user = null; // { id, email }
    let owner = LOCAL;
    let entries = [];
    let queue = [];
    let inFlight = 0; // how many queue items are currently being sent
    let status = configured ? 'signed-out' : 'local-only';
    let lastError = '';
    let chain = Promise.resolve(); // serializes all network work
    let lastFullPull = 0;
    // Encryption for the signed-in account:
    //   'pending'  not checked yet (or the check failed; retried on next sync)
    //   'plain'    the server has no keyring table, and config.allowUnencrypted
    //              is set: sync without encryption
    //   'unsupported' no keyring table and no such setting: nothing syncs
    //   'none'     no key yet: one is being created (encryption is required); nothing syncs until then
    //   'locked'   the account is encrypted but this device has no key yet
    //   'ready'    this device holds the key; text is encrypted on upload
    let vault = { mode: 'pending' };
    // Account settings (pay rates so far): one small row per account in the
    // `settings` table, encrypted like entries once the account has a key.
    // Kept locally too; `settingsDirty` marks local changes not yet sent.
    let settings = {};
    let settingsDirty = false;
    let serverSettings = null; // null (not checked yet), true, or false (no table: stay on this device)
    let settingsNoticeShown = false;
    let autoEncrypting = false; // turning encryption on for an account that doesn't have it yet
    // Records: small items that aren't entries (forms and their remembered
    // answers), one encrypted row each in the `records` table. Kept locally
    // as [{ id, kind, body, at }] (plus { id, deleted } until a deletion is
    // sent); `recordsDirty` lists ids changed here and not yet sent.
    let records = [];
    let recordsDirty = [];
    let serverRecords = null; // null (not checked yet), true, or false (no table yet)
    let recordsCursor = null; // newest modified_at seen, for fetching only changes

    // ---- local persistence -------------------------------------------------

    const key = (who, what) => `tymlee.v2.${who}.${what}`;

    function read(k, fallback) {
      try {
        const v = JSON.parse(storage.getItem(k));
        return Array.isArray(v) ? v : fallback;
      } catch (_) {
        return fallback;
      }
    }

    function write(k, v) {
      try {
        storage.setItem(k, JSON.stringify(v));
      } catch (_) {
        onNotice(`warning: could not save to storage on ${env.place}`, 'err');
      }
    }

    function valid(e) {
      return e && typeof e.id === 'string' && typeof e.ts === 'number' && typeof e.text === 'string';
    }

    function loadOwner(who) {
      owner = who;
      entries = T.sortEntries(read(key(who, 'entries'), []).filter(valid));
      queue = read(key(who, 'queue'), []);
      settings = readObject(key(who, 'settings'));
      settingsDirty = readObject(key(who, 'settingsDirty')).dirty === true;
      records = read(key(who, 'records'), []).filter((r) => r && typeof r.id === 'string');
      recordsDirty = read(key(who, 'recordsDirty'), []);
      // Signed out, records stay on this device: move old forms right away.
      if (who === LOCAL) moveFormsFromSettings();
      idsReady = who === LOCAL || hasIds();
      emptyOldTrash();
      if (who === LOCAL && idOps().length) write(key(who, 'entries'), entries);
    }

    function readObject(k) {
      try {
        const v = JSON.parse(storage.getItem(k));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      } catch (_) {
        return {};
      }
    }

    function persistSettings() {
      write(key(owner, 'settings'), settings);
      write(key(owner, 'settingsDirty'), { dirty: settingsDirty });
    }

    function persistRecords() {
      write(key(owner, 'records'), records);
      write(key(owner, 'recordsDirty'), recordsDirty);
    }

    function persist() {
      write(key(owner, 'entries'), entries);
      write(key(owner, 'queue'), queue);
      // When the oldest change still waiting to be sent was made.
      const since = key(owner, 'unsentSince');
      try {
        if (!queue.length) storage.removeItem(since);
        else if (!storage.getItem(since)) storage.setItem(since, String(Date.now()));
      } catch (_) { /* a warning, not the data */ }
    }

    function clearOwner(who) {
      storage.removeItem(key(who, 'entries'));
      storage.removeItem(key(who, 'queue'));
      storage.removeItem(key(who, 'unsentSince'));
      storage.removeItem(key(who, 'recoveryNag'));
      storage.removeItem(key(who, 'key'));
      storage.removeItem(key(who, 'settings'));
      storage.removeItem(key(who, 'settingsDirty'));
      storage.removeItem(key(who, 'records'));
      storage.removeItem(key(who, 'recordsDirty'));
    }

    // This device's copy of the account's master key.
    function localKey(who) {
      try { return storage.getItem(key(who, 'key')) || ''; } catch (_) { return ''; }
    }

    // One-time move from the first version's storage format.
    function migrateLegacy() {
      const old = read(LEGACY_KEY, null);
      if (!old) return;
      const existing = read(key(LOCAL, 'entries'), []);
      const moved = old
        .filter((e) => e && typeof e.ts === 'number' && typeof e.text === 'string')
        .map((e) => ({ id: T.uuid(), ts: e.ts, text: e.text }));
      write(key(LOCAL, 'entries'), T.sortEntries(existing.concat(moved)));
      storage.removeItem(LEGACY_KEY);
    }

    // ---- local changes -----------------------------------------------------

    // Apply local changes, save them, and queue them for the server.
    // Entry IDs (T.assignIds) are given out once this device knows the log:
    // signed out, or when it already has numbered entries, or after the first
    // full download (so a log from before IDs is numbered like on every other
    // device).
    let idsReady = false;
    const hasIds = () => entries.some((e) => T.validSid(e.sid));

    // Give entries without an ID one; returns the changes, for the queue.
    function idOps() {
      if (!idsReady) return [];
      const { changed, renumbered } = T.assignIds(entries);
      if (renumbered) {
        onNotice(`${renumbered === 1 ? 'an entry' : `${renumbered} entries`} had the same ID as one made on another device, and got a new one`, 'dim');
      }
      const ops = changed.map((entry) => ({ op: 'put', entry }));
      entries = T.applyOps(entries, ops);
      return ops;
    }

    function apply(ops) {
      if (!ops.length) return;
      toTrash(ops);
      entries = T.applyOps(entries, ops);
      ops = ops.concat(idOps());
      queue = owner === LOCAL ? [] : T.enqueueAll(queue, ops, inFlight);
      persist();
      onChange();
      if (user) schedule(flush);
    }

    function change(op) {
      apply([op]);
    }

    // `extra` can carry notes / wo / wl for the new entry.
    function add(text, extra) {
      const shown = T.visible(entries);
      const last = shown[shown.length - 1];
      const ts = Math.max(Date.now(), last ? last.ts + 1 : 0);
      const entry = T.makeEntry({ id: T.uuid(), ts, text }, extra);
      change({ op: 'put', entry });
      return entries.find((e) => e.id === entry.id) || entry; // with its ID
    }

    function remove(id) {
      change({ op: 'del', id });
    }

    // ---- sync --------------------------------------------------------------

    function schedule(task) {
      const run = chain.then(task).catch((err) => fail(err));
      chain = run;
      return run;
    }

    function fail(err) {
      lastError = (err && err.message) || String(err);
      status = env.isOnline() ? 'error' : 'offline';
      onChange();
    }

    function settle() {
      if (!user) return;
      status = queue.length ? (env.isOnline() ? 'pending' : 'offline') : 'synced';
      lastError = '';
      onChange();
    }

    // ---- server format --------------------------------------------------------
    // Servers set up with the latest supabase/schema.sql ("v2") record when
    // each row last changed and keep a marker for deleted entries. That lets
    // routine checks ask only for what changed, and lets encrypted entries
    // hide their start time too. Older servers ("v1") are still supported.

    let serverVersion = null; // null (not checked yet), 1 or 2
    let serverNotes = false; // has the notes column (latest supabase/schema.sql)
    let serverWo = false; // has the wo and wo_linked columns
    let changedCursor = null; // latest modified_at seen (ms), v2 only
    const CURSOR_MARGIN_MS = 2 * 60000; // re-read a little overlap, in case of slow writes
    const V2_COLUMNS = 'id,ts,text,modified_at,deleted';

    function missingColumn(error) {
      return error.code === '42703' || error.code === 'PGRST204' ||
        /column .*does not exist|could not find the .* column/i.test(error.message || '');
    }

    async function detectServer() {
      if (serverVersion) return;
      const probe = (cols) => client.from('entries').select(cols).order('id', { ascending: true }).range(0, 0);
      const v2 = await probe(V2_COLUMNS);
      if (v2.error && !missingColumn(v2.error)) throw v2.error;
      const notes = await probe('id,notes');
      if (notes.error && !missingColumn(notes.error)) throw notes.error;
      const wo = await probe('id,wo,wo_linked');
      if (wo.error && !missingColumn(wo.error)) throw wo.error;
      serverNotes = !notes.error;
      serverWo = !wo.error;
      serverVersion = v2.error ? 1 : 2;
    }

    // Whether notes / work orders / equipment ('notes', 'wo' or 'eq') can be
    // kept here: always on this device alone, and when signed in if they
    // travel sealed with the entry or the server has the column for them
    // (equipment only travels sealed).
    async function supports(field) {
      if (!user || !client) return true;
      await schedule(async () => {
        await vaultOpen();
        await detectServer();
      });
      if (vault.mode === 'ready' && serverVersion === 2) return true;
      return field === 'eq' ? false : field === 'wo' ? serverWo : serverNotes;
    }

    // Send queued changes, in order, in batches.
    async function flush() {
      if (!user || !client) return;
      if (!(await vaultOpen())) return;
      // Never upload with a key the account no longer uses (verifyKey).
      if (queue.length) {
        await verifyKey();
        if (vault.mode !== 'ready' && vault.mode !== 'plain') return;
      }
      await detectServer();
      const who = owner;
      let batch;
      while (owner === who && (batch = T.nextBatch(queue, 500))) {
        status = 'syncing';
        inFlight = batch.ops.length;
        try {
          const table = client.from('entries');
          let result;
          if (batch.kind === 'put') {
            result = await table.upsert(await Promise.all(batch.ops.map((q) => sealRow(q.entry, who))));
          } else if (serverVersion === 2) {
            // Leave a marker so other devices' routine checks see the deletion.
            result = await table.upsert(batch.ops.map((q) => ({ id: q.id, user_id: who, ts: 0, text: '/deleted', deleted: true })));
          } else {
            result = await table.delete().in('id', batch.ops.map((q) => q.id));
          }
          if (result.error) throw result.error;
        } finally {
          inFlight = 0;
        }
        if (owner !== who) return;
        queue = queue.slice(batch.ops.length);
        write(key(owner, 'queue'), queue);
      }
      settle();
    }

    // The row to upload for an entry. With the account's key, the text and
    // notes (and on v2 servers the start time too) are encrypted.
    async function sealRow(entry, who) {
      const row = { id: entry.id, user_id: who, ts: entry.ts, text: entry.text };
      if (serverNotes) row.notes = entry.notes || null;
      if (serverWo) {
        row.wo = entry.wo || null;
        row.wo_linked = Boolean(entry.wo && entry.wl);
      }
      if (vault.mode === 'ready' && serverVersion === 2) {
        row.ts = 0;
        row.text = await V.sealEntry(vault.key, entry.id, entry);
        if (serverNotes) row.notes = null;
        if (serverWo) Object.assign(row, { wo: null, wo_linked: false });
      } else if (vault.mode === 'ready') {
        row.text = await V.encryptText(vault.key, entry.id, entry.text);
        if (serverNotes && entry.notes) row.notes = await V.encryptNotes(vault.key, entry.id, entry.notes);
        if (serverWo && entry.wo) row.wo = await V.encryptField(vault.key, entry.id, 'wo', entry.wo);
      }
      if (serverVersion === 2) row.deleted = false;
      return row;
    }

    // Read one downloaded row: { id, deleted } for a deletion marker,
    // { entry, reseal } for an entry, or null when it can't be read here.
    // `reseal` means it should be uploaded again in the current format.
    async function openRow(r, seen) {
      if (r.deleted) return { id: r.id, deleted: true };
      let ts = Number(r.ts);
      let text = r.text;
      let notes = r.notes || '';
      let wo = r.wo || '';
      let wl = Boolean(r.wo_linked);
      let eq = '';
      let ql = false;
      let sid = null;
      let files = '';
      let details = null;
      let reseal = false;
      const encrypted = V.isSealed(text) || V.isEncrypted(text);
      // With the key here, every row this account writes is encrypted (the
      // database refuses others). A plain one can't be trusted as the
      // person's own: the server or someone else put it there.
      if (!encrypted && vault.mode === 'ready' && !allowPlain) {
        seen.plain++;
        return null;
      }
      if (encrypted && vault.mode !== 'ready') {
        seen.encrypted = true;
        return null;
      }
      try {
        if (V.isEncrypted(text)) {
          text = await V.decryptText(vault.key, r.id, text);
          reseal = serverVersion === 2;
        }
        // A sealed entry, possibly wrapped again by a tab still running an
        // older version: unwrap it, and fix the stored copy.
        if (V.isSealed(text)) {
          if (text !== r.text) reseal = true;
          const opened = await V.openEntry(vault.key, r.id, text);
          ({ ts, text } = opened);
          notes = opened.notes || notes;
          if (opened.wo) ({ wo, wl } = { wo: opened.wo, wl: Boolean(opened.wl) });
          if (opened.eq) ({ eq, ql } = { eq: opened.eq, ql: Boolean(opened.ql) });
          if (opened.sid) sid = opened.sid;
          if (opened.files) files = opened.files;
          if (opened.details) details = opened.details;
        }
        if (V.isEncrypted(notes)) {
          notes = await V.decryptNotes(vault.key, r.id, notes);
          reseal = reseal || serverVersion === 2;
        }
        if (V.isEncrypted(wo)) {
          wo = await V.decryptField(vault.key, r.id, 'wo', wo);
          reseal = reseal || serverVersion === 2;
        }
      } catch (_) {
        seen.unreadable++;
        return null;
      }
      if (!encrypted && vault.mode === 'ready') reseal = true;
      return { entry: T.makeEntry({ id: r.id, ts, text }, { notes, files, wo, wl, eq, ql, sid, details }), reseal };
    }

    // Download changes and merge them with the local log, then re-apply unsent
    // changes on top. `full` downloads everything; otherwise only rows changed
    // since the last check (v2) or from the last two weeks (v1).
    async function pull(full) {
      if (!user || !client) return;
      if (!(await vaultOpen())) return;
      await detectServer();
      const who = owner;
      const v2 = serverVersion === 2;
      const incremental = !full && v2 && changedCursor != null;
      const since = !full && !v2 ? Date.now() - RECENT_MS : null;
      const opened = [];
      const seen = { encrypted: false, unreadable: 0, plain: 0 };
      let newest = changedCursor;
      const page = 1000;
      for (let from = 0; ; from += page) {
        const cols = (v2 ? V2_COLUMNS : 'id,ts,text') + (serverNotes ? ',notes' : '') + (serverWo ? ',wo,wo_linked' : '');
        let query = client.from('entries').select(cols);
        if (incremental) query = query.gte('modified_at', new Date(changedCursor - CURSOR_MARGIN_MS).toISOString());
        if (since != null) query = query.gte('ts', since);
        const order = incremental ? 'modified_at' : v2 ? 'id' : 'ts';
        const { data, error } = await query.order(order, { ascending: true }).range(from, from + page - 1);
        if (error) throw error;
        for (const r of data) {
          const at = r.modified_at ? Date.parse(r.modified_at) : NaN;
          if (!Number.isNaN(at) && (newest == null || at > newest)) newest = at;
        }
        opened.push(...(await Promise.all(data.map((r) => openRow(r, seen)))).filter(Boolean));
        if (data.length < page) break;
      }
      if (owner !== who) return;
      // Rows this key can't read: maybe the account started over with a new
      // key on another device. Check before touching the local log.
      if (seen.unreadable && vault.mode === 'ready') {
        await verifyKey();
        if (vault.mode === 'locked' || owner !== who) return;
      }

      const found = opened.filter((o) => !o.deleted).map((o) => o.entry);
      let base;
      if (incremental) {
        base = T.applyOps(entries, opened.map((o) => (o.deleted ? { op: 'del', id: o.id } : { op: 'put', entry: o.entry })));
      } else if (since != null) {
        base = T.mergeRecent(entries, found, since);
      } else {
        base = found;
      }
      if (v2) changedCursor = newest;
      // Upload again anything not yet stored in the current format, unless a
      // newer local change for it is already waiting to be sent.
      const waiting = new Set(queue.map((q) => (q.op === 'put' ? q.entry.id : q.id)));
      const reseal = opened.filter((o) => o.reseal && !waiting.has(o.entry.id));
      queue = T.enqueueAll(queue, reseal.map((o) => ({ op: 'put', entry: o.entry })), inFlight);
      entries = T.applyOps(base, queue);
      if (!incremental && since == null) idsReady = true;
      const numbered = idOps();
      queue = T.enqueueAll(queue, numbered, inFlight);
      persist();
      if (seen.unreadable) {
        onNotice(`${seen.unreadable} entr${seen.unreadable === 1 ? 'y' : 'ies'} could not be decrypted and are hidden`, 'err');
      }
      if (seen.plain) {
        onNotice(`${seen.plain} entr${seen.plain === 1 ? 'y' : 'ies'} on the server ${seen.plain === 1 ? "wasn't" : "weren't"} encrypted, so ${seen.plain === 1 ? 'it was' : 'they were'} ignored: tymlee only trusts what your own key locked`, 'err');
      }
      if (reseal.length || numbered.length) schedule(flush);
      settle();
      // Another device has turned encryption on: find out and lock this one.
      if (seen.encrypted && (vault.mode === 'none' || vault.mode === 'plain')) {
        vault = { mode: 'pending' };
        schedule(prepareVault);
      }
    }

    // ---- settings sync ---------------------------------------------------------

    function setSettings(next) {
      settings = next;
      settingsDirty = owner !== LOCAL;
      persistSettings();
      onChange();
      if (!user) return;
      if (serverSettings === false) settingsLocalNotice();
      schedule(syncSettings);
    }

    function settingsLocalNotice() {
      if (settingsNoticeShown) return;
      settingsNoticeShown = true;
      onNotice(`settings are kept on ${env.place} until the server has the latest supabase/schema.sql`, 'dim');
    }

    // Send local changes (merged with the server's copy) and fetch other
    // devices' changes. Never fails the entry sync: settings just wait.
    async function syncSettings() {
      if (!user || !client || serverSettings === false) return;
      if (vault.mode !== 'ready' && vault.mode !== 'plain') return;
      const who = owner;
      try {
        const got = await client.from('settings').select('data').maybeSingle();
        if (got.error) {
          if (missingTable(got.error)) {
            serverSettings = false;
            if (settingsDirty) settingsLocalNotice();
            return;
          }
          throw got.error;
        }
        serverSettings = true;
        let remote = null;
        let resend = false;
        if (got.data && got.data.data) {
          const stored = got.data.data;
          if (V.isEncrypted(stored)) {
            if (vault.mode !== 'ready') return; // locked out of it here
            remote = JSON.parse(await V.decryptField(vault.key, who, 'settings', stored));
          } else if (vault.mode !== 'ready' || allowPlain) {
            remote = JSON.parse(stored);
            resend = vault.mode === 'ready'; // stored before encryption was on
          } else {
            resend = true; // not locked with the key: replaced with this device's
          }
        }
        if (owner !== who) return;
        const merged = settingsDirty ? T.mergeSettings(settings, remote || {}) : remote || settings;
        const changed = JSON.stringify(merged) !== JSON.stringify(settings);
        settings = merged;
        if (settingsDirty || resend || (!remote && Object.keys(settings).length)) {
          const json = JSON.stringify(settings);
          const data = vault.mode === 'ready' ? await V.encryptField(vault.key, who, 'settings', json) : json;
          const put = await client.from('settings').upsert({ user_id: who, data });
          if (put.error) throw put.error;
          if (owner !== who) return;
          settingsDirty = false;
        }
        persistSettings();
        if (changed) onChange();
      } catch (_) {
        // Try again on the next sync.
      }
    }

    // ---- trash ---------------------------------------------------------------
    // Deleted entries (/rm, /edit, /undo, the entry card) are kept as trash
    // records for 30 days; /untrash puts one back.
    const TRASH_DAYS = 30;

    function toTrash(ops) {
      const now = Date.now();
      let any = false;
      for (const op of ops) {
        if (op.op !== 'del') continue;
        const e = entries.find((x) => x.id === op.id);
        if (!e || T.isLink(e)) continue;
        const id = T.uuid();
        records.push({ id, kind: 'trash', body: { entry: e, deletedAt: now }, at: now });
        touchRecord(id);
        any = true;
      }
      if (!any) return;
      persistRecords();
      if (user) schedule(syncRecords);
    }

    // Trash older than 30 days goes for good.
    function emptyOldTrash() {
      const cutoff = Date.now() - TRASH_DAYS * 86400000;
      const old = records.filter((r) => !r.deleted && r.kind === 'trash' && r.at < cutoff).map((r) => r.id);
      if (old.length) deleteRecords(old);
    }

    // ---- records ---------------------------------------------------------------

    // Whether records sync (or, on this device alone, are kept): signed out,
    // or signed in to a server with the `records` table. Until then the
    // shell keeps forms in the settings, as before.
    const recordsReady = () => owner === LOCAL || serverRecords === true;

    // The records of a kind, newest first: [{ id, at, ...body }].
    function listRecords(kind) {
      return records.filter((r) => !r.deleted && r.kind === kind)
        .sort((a, b) => b.at - a.at)
        .map((r) => ({ ...r.body, id: r.id, at: r.at }));
    }

    function touchRecord(id) {
      if (owner !== LOCAL && !recordsDirty.includes(id)) recordsDirty.push(id);
    }

    // Add a record, or replace the one with `id`. Returns its id.
    function putRecord(kind, body, id) {
      const rec = { id: id || T.uuid(), kind, body, at: Date.now() };
      records = records.filter((r) => r.id !== rec.id).concat(rec);
      touchRecord(rec.id);
      persistRecords();
      onChange();
      if (user) schedule(syncRecords);
      return rec.id;
    }

    function deleteRecords(ids) {
      if (!ids.length) return;
      records = records.filter((r) => !ids.includes(r.id));
      if (owner !== LOCAL) for (const id of ids) { records.push({ id, deleted: true }); touchRecord(id); }
      persistRecords();
      onChange();
      if (user) schedule(syncRecords);
    }

    // Fetch other devices' changes, then send this one's. Like settings, it
    // never fails the entry sync: changes just wait for the next one.
    async function syncRecords() {
      if (!user || !client || serverRecords === false || vault.mode !== 'ready') return;
      const who = owner;
      const key0 = vault.key;
      try {
        const rows = [];
        const page = 1000;
        for (let from = 0; ; from += page) {
          let query = client.from('records').select('id,data,deleted,modified_at');
          if (recordsCursor != null) query = query.gte('modified_at', new Date(recordsCursor - CURSOR_MARGIN_MS).toISOString());
          const { data, error } = await query.order('modified_at', { ascending: true }).range(from, from + page - 1);
          if (error) {
            if (missingTable(error)) serverRecords = false;
            else throw error;
            return;
          }
          rows.push(...data);
          if (data.length < page) break;
        }
        if (owner !== who) return;
        const firstTime = serverRecords !== true;
        serverRecords = true;
        let newest = recordsCursor;
        let changed = false;
        for (const r of rows) {
          const at = Date.parse(r.modified_at);
          if (!Number.isNaN(at) && (newest == null || at > newest)) newest = at;
          if (recordsDirty.includes(r.id)) continue; // this device's newer change wins
          const had = records.some((x) => x.id === r.id);
          if (r.deleted) {
            if (had) { records = records.filter((x) => x.id !== r.id); changed = true; }
            continue;
          }
          let rec;
          try {
            const { k, b, at: when } = JSON.parse(await V.decryptField(key0, r.id, 'record', r.data));
            rec = { id: r.id, kind: k, body: b, at: when };
          } catch (_) {
            continue; // not readable with this key
          }
          if (owner !== who) return;
          const cur = records.find((x) => x.id === r.id);
          if (!cur || JSON.stringify(cur) !== JSON.stringify(rec)) {
            records = records.filter((x) => x.id !== r.id).concat(rec);
            changed = true;
          }
        }
        if (firstTime) changed = moveFormsFromSettings() || changed;
        // Send this device's changes.
        const sending = recordsDirty.slice();
        for (let i = 0; i < sending.length; i += 100) {
          const batch = [];
          for (const id of sending.slice(i, i + 100)) {
            const rec = records.find((x) => x.id === id);
            if (!rec || rec.deleted) {
              batch.push({ id, user_id: who, data: '/deleted', deleted: true });
            } else {
              const json = JSON.stringify({ k: rec.kind, b: rec.body, at: rec.at });
              batch.push({ id, user_id: who, data: await V.encryptField(key0, id, 'record', json), deleted: false });
            }
          }
          const put = await client.from('records').upsert(batch);
          if (put.error) throw put.error;
          if (owner !== who) return;
          const sent = new Set(batch.map((b) => b.id));
          // Changed again while sending? Then it stays to send next time.
          const stillSame = (id) => {
            const rec = records.find((x) => x.id === id);
            const b = batch.find((x) => x.id === id);
            return !rec || rec.deleted ? b.deleted : !b.deleted;
          };
          recordsDirty = recordsDirty.filter((id) => !(sent.has(id) && stillSame(id)));
          records = records.filter((r) => !(r.deleted && sent.has(r.id)));
        }
        recordsCursor = newest;
        persistRecords();
        if (changed) onChange();
      } catch (_) {
        // Try again on the next sync.
      }
    }

    // Forms and answers kept in the settings by earlier versions become
    // records (once there's somewhere to sync them), and leave the settings.
    function moveFormsFromSettings() {
      const forms = settings.forms || {};
      const answers = settings.formAnswers || {};
      if (!Object.keys(forms).length && !Object.keys(answers).length && !('forms' in settings) && !('formAnswers' in settings)) return false;
      const now = Date.now();
      const have = listRecords('form').map((f) => f.name.toLowerCase());
      for (const [name, text] of Object.entries(forms)) {
        if (have.includes(name.toLowerCase())) continue;
        const id = T.uuid();
        records.push({ id, kind: 'form', body: { name, text }, at: now });
        touchRecord(id);
      }
      for (const [k, value] of Object.entries(answers)) {
        const [label, where = ''] = k.split('\n');
        const id = T.uuid();
        records.push({ id, kind: 'answer', body: { label, where, value }, at: now });
        touchRecord(id);
      }
      const { forms: _f, formAnswers: _a, ...rest } = settings;
      settings = rest;
      settingsDirty = owner !== LOCAL;
      persistSettings();
      persistRecords();
      if (user) schedule(syncSettings);
      return true;
    }

    // ---- encryption ----------------------------------------------------------

    function missingTable(error) {
      return error.code === 'PGRST205' || error.code === '42P01' || /could not find the table|does not exist/i.test(error.message || '');
    }

    function fetchKeyring() {
      return client.from('keyring').select('recovery,link').maybeSingle();
    }

    async function unlock(raw) {
      try { storage.setItem(key(owner, 'key'), raw); } catch (_) { /* this session only */ }
      vault = { mode: 'ready', raw, key: await V.importMasterKey(raw) };
    }

    function lock() {
      vault = { mode: 'locked' };
      status = 'locked';
      onChange();
      onNotice([
        "This account's log is encrypted, and this device doesn't have the key yet.",
        '',
        'On a device that is already set up, type /link, then type the code it shows here:',
        '  /link XXXX-XXXX-XXXX',
        '',
        'Or use your recovery key:',
        '  /recover XXXXX-XXXXX-XXXXX-XXXXX',
        ...(env.passkeys ? ['', 'Or, if you added a passkey that unlocks: /passkey unlock'] : []),
        '',
        "Lost both? /reset-encryption starts over with a new key. The synced log can't be decrypted without the old key, so it is deleted.",
      ].join('\n'), 'key');
    }

    // Has someone confirmed they saved the current recovery key? Recorded in
    // the (encrypted, synced) settings as the key's salt, so every device
    // knows, and a new recovery key needs confirming again.
    let recoveryId = null;
    const RECOVERY_NAG_MS = 24 * 3600000;
    function recoveryConfirmed() {
      if (vault.mode !== 'ready' || !recoveryId) return null;
      return settings.recoveryOk === recoveryId;
    }
    function remindRecovery() {
      if (recoveryConfirmed() !== false) return;
      const nagKey = key(owner, 'recoveryNag');
      const last = Number(storage.getItem(nagKey)) || 0;
      if (Date.now() - last < RECOVERY_NAG_MS) return;
      try { storage.setItem(nagKey, String(Date.now())); } catch (_) { /* reminds again next time */ }
      onNotice("You haven't confirmed that your recovery key is saved. Without it, losing your devices means losing your log. Confirm it in Settings → Recovery key (or /recovery check, then paste the key); /recovery makes a new one.", 'err');
    }
    function recoveryShown(blob) {
      recoveryId = blob.salt;
      try { storage.setItem(key(owner, 'recoveryNag'), String(Date.now())); } catch (_) { /* fine */ }
    }
    // /recovery check: the key opens this account's key on the server.
    async function checkRecovery(code) {
      requireKey();
      const { data, error } = await fetchKeyring();
      if (error) throw error;
      if (!data || !data.recovery) throw new Error("this account has no recovery key yet");
      let raw = null;
      try { raw = await V.unwrap(data.recovery, code); } catch (_) { /* wrong */ }
      if (raw !== vault.raw) throw new Error("that isn't this account's current recovery key · /recovery makes a new one");
      recoveryId = data.recovery.salt;
      setSettings({ ...settings, recoveryOk: recoveryId });
    }

    function recoveryMessage(code, first) {
      return [
        first ? 'Your log is end-to-end encrypted: it is encrypted on your devices before upload, so nobody else can read it, including whoever runs this site. Your recovery key:' : 'Your new recovery key (the old one no longer works):',
        '',
        `  ${code}`,
        '',
        'Save it somewhere safe, like a password manager. It is the only way back into your log if you lose access to all your devices, and nobody else, including whoever runs this site, can recover it for you.',
        '',
        'Once it is saved, confirm it: /recovery check, then paste the key. Until then you get a reminder once a day.',
        ...(first ? ['', 'To add another device, type /link here.'] : []),
      ].join('\n');
    }

    // Work out this device's encryption state, creating the account's key if
    // this is the first device to get here.
    async function prepareVault() {
      const who = owner;
      const saved = localKey(who);
      if (saved) {
        await unlock(saved);
        return;
      }
      const { data, error } = await fetchKeyring();
      if (owner !== who) return;
      if (error) {
        if (missingTable(error)) {
          vault = { mode: allowPlain ? 'plain' : 'unsupported' };
          if (!allowPlain) onNotice("Sync is off: this server isn't set up for encryption (run supabase/schema.sql). Your log stays on this device.", 'err');
          return;
        }
        throw error;
      }
      if (data) {
        if (pendingPasskey && await unlockWithSecret(pendingPasskey, data.recovery && data.recovery.kid)) return;
        lock();
        return;
      }
      // Encryption is required: an account without it gets it now, before
      // anything is uploaded (vaultOpen holds sync until then).
      vault = { mode: 'none' };
      setTimeout(autoEncrypt, 0);
    }

    function autoEncrypt() {
      if (autoEncrypting || vault.mode !== 'none') return;
      autoEncrypting = true;
      enableEncryption()
        .catch((err) => { if (vault.mode === 'none') onNotice(`could not turn on encryption yet (${err.message}); retrying on the next sync`, 'err'); })
        .finally(() => { autoEncrypting = false; });
    }

    // Turn encryption on for this account: create the master key, lock a copy
    // with a new recovery key, and re-upload every entry encrypted. Runs by
    // itself for accounts that don't have it (encryption is required).
    async function enableEncryption() {
      requireClient();
      if (!user) throw new Error('not signed in · /login you@example.com');
      if (vault.mode === 'pending' || vault.mode === 'plain' || vault.mode === 'none' || vault.mode === 'unsupported') await schedule(prepareVault);
      if (vault.mode === 'ready') throw new Error('encryption is already on, and this device has the key');
      if (vault.mode === 'locked') throw new Error("encryption is already on for this account; this device doesn't have the key yet (/link or /recover)");
      if (vault.mode === 'plain' || vault.mode === 'unsupported') throw new Error('encryption is not available: the server needs the latest supabase/schema.sql');
      const who = owner;
      const raw = V.newMasterKey();
      const code = V.newRecoveryCode();
      const recovery = { ...(await V.wrap(raw, code)), kid: await V.keyId(raw) };
      const created = await client.from('keyring').insert({ user_id: who, recovery });
      if (created.error) {
        if (created.error.code === '23505') { // another device got there first
          lock();
          throw new Error('another device turned encryption on first; link this one with /link');
        }
        throw created.error;
      }
      await unlock(raw);
      recoveryShown(recovery);
      onNotice(recoveryMessage(code, true), 'key');
      await sync({ full: true }); // re-uploads existing entries encrypted
    }

    // Before uploading with this device's key, check it is still the
    // account's key: after /reset-encryption on another device it isn't, and
    // anything encrypted with it would be unreadable. Keys from before this
    // check get their fingerprint added here.
    async function verifyKey() {
      if (vault.mode !== 'ready') return;
      const who = owner;
      const { data, error } = await fetchKeyring();
      if (error) {
        if (missingTable(error)) return;
        throw error;
      }
      if (owner !== who || !data || !data.recovery) return;
      recoveryId = data.recovery.salt;
      // A /link copy nobody used: it has expired, so take it off the server.
      if (data.link && !(data.link.expires > Date.now())) await client.from('keyring').update({ link: null }).eq('user_id', who);
      const mine = await V.keyId(vault.raw);
      if (!data.recovery.kid) {
        await client.from('keyring').update({ recovery: { ...data.recovery, kid: mine } }).eq('user_id', who);
        return;
      }
      if (data.recovery.kid !== mine) keyWasReset();
    }

    // Another device started over with a new key. This device's key is
    // useless now; lock it until it is linked again, and queue what it has
    // so its copy of the log is uploaded again under the new key.
    function keyWasReset() {
      storage.removeItem(key(owner, 'key'));
      queue = T.enqueueAll(queue, entries.map((e) => ({ op: 'put', entry: e })), inFlight);
      if (Object.keys(settings).length) settingsDirty = true;
      persist();
      persistSettings();
      onNotice(`Encryption for this account was reset on another device, with a new key. Once this device is linked again, the ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} it has are uploaded again.`, 'err');
      lock();
    }

    // /reset-encryption: for a signed-in device that can't get the key (no
    // other device, no recovery key). Deletes the account's synced entries
    // and settings (unreadable without the key), then starts over with a new
    // key. Entries typed on this device and not yet sent are kept.
    async function resetEncryption() {
      requireClient();
      if (!user) throw new Error('not signed in · /login you@example.com');
      if (vault.mode === 'pending') await schedule(prepareVault);
      if (vault.mode === 'ready') throw new Error('this device has the key, so there is nothing to reset. /recovery makes a new recovery key');
      if (vault.mode !== 'locked') throw new Error("this account's log isn't locked, so there is nothing to reset");
      let failure = null;
      const code = await schedule(async () => {
        try {
          return await startOver();
        } catch (err) {
          failure = err;
          return '';
        }
      });
      if (failure) throw failure;
      if (!code) return;
      onNotice(recoveryMessage(code, true), 'key');
      await sync({ full: true });
    }

    async function startOver() {
      const who = owner;
      const raw = V.newMasterKey();
      const code = V.newRecoveryCode();
      const recovery = { ...(await V.wrap(raw, code)), kid: await V.keyId(raw) };
      // Delete first: if this stops halfway, the account is still locked
      // and /reset-encryption can run again.
      const gone = await client.from('entries').delete().eq('user_id', who);
      if (gone.error) throw gone.error;
      const newKey = await V.importMasterKey(raw);
      if (serverSettings !== false) {
        const data = await V.encryptField(newKey, who, 'settings', '{}');
        const put = await client.from('settings').upsert({ user_id: who, data });
        if (put.error && !missingTable(put.error)) throw put.error;
      }
      if (serverRecords !== false) {
        const del = await client.from('records').delete().eq('user_id', who);
        if (del.error && !missingTable(del.error)) throw del.error;
      }
      const keyring = await client.from('keyring').update({ recovery, link: null }).eq('user_id', who);
      if (keyring.error) throw keyring.error;
      if (owner !== who) return '';
      recoveryShown(recovery);
      // Copies locked with passkeys hold the old key: drop them (add the
      // passkeys again for the new one).
      if ((await passkeyWraps()) !== null) await client.from('keyring').update({ passkeys: [] }).eq('user_id', who);
      // Keep only what this device typed and hasn't sent yet.
      entries = T.applyOps([], queue.filter((q) => q.op === 'put'));
      queue = queue.filter((q) => q.op === 'put');
      settings = {};
      settingsDirty = false;
      changedCursor = null;
      // This device's forms go back up, locked with the new key.
      records = records.filter((r) => !r.deleted);
      recordsDirty = records.map((r) => r.id);
      recordsCursor = null;
      persist();
      persistSettings();
      persistRecords();
      await unlock(raw);
      status = 'syncing';
      onChange();
      return code;
    }

    // True when entries can be synced: encrypted, or plain on a server that
    // doesn't support encryption at all (an old supabase/schema.sql). An
    // account still getting its key ('none') waits, so nothing is ever
    // uploaded unencrypted.
    async function vaultOpen() {
      if (vault.mode === 'pending') await prepareVault();
      if (vault.mode === 'locked') {
        status = 'locked';
        onChange();
        return false;
      }
      if (vault.mode === 'unsupported') {
        status = 'error';
        lastError = "the server isn't set up for encryption (supabase/schema.sql)";
        onChange();
        return false;
      }
      if (vault.mode === 'none') setTimeout(autoEncrypt, 0);
      return vault.mode === 'ready' || vault.mode === 'plain';
    }

    // ---- passkeys ----------------------------------------------------------------
    // Signing in is Supabase's (two-step, so the same prompt can also ask for
    // the PRF secret). Unlocking is tymlee's: keyring.passkeys holds the
    // account key locked with each PRF-capable passkey (vault.js).
    let pendingPasskey = null; // { id, secret } from a passkey sign-in, until the vault is ready
    const PASSKEY_SETUP = 'passkeys need the latest supabase/schema.sql, and Passkeys turned on in Supabase (Authentication → Passkeys)';

    function requirePasskeys() {
      requireClient();
      if (!env.passkeys) throw new Error(`passkeys work in the website, not on ${env.place}`);
    }
    function friendly(error) {
      const m = (error && error.message) || String(error);
      if (/NotAllowedError|not allowed|cancel|abort/i.test(m) || (error && error.name === 'NotAllowedError')) return new Error('passkey cancelled');
      if (/passkey.*(disabled|not enabled)|404|not found/i.test(m)) return new Error(PASSKEY_SETUP);
      return error instanceof Error ? error : new Error(m);
    }
    async function passkeyWraps() {
      const { data, error } = await client.from('keyring').select('passkeys').maybeSingle();
      if (error) {
        if (error.code === '42703' || /column .*passkeys.* does not exist/i.test(error.message || '')) return null;
        throw error;
      }
      return data && Array.isArray(data.passkeys) ? data.passkeys : [];
    }
    async function savePasskeyWraps(list) {
      const { error } = await client.from('keyring').update({ passkeys: list }).eq('user_id', owner);
      if (error) throw error;
    }
    async function unlockWithSecret({ id, secret }, kid) {
      const wraps = await passkeyWraps();
      const w = wraps && wraps.find((x) => x.id === id && (!kid || !x.kid || x.kid === kid));
      if (!w) return false;
      let raw;
      try { raw = await V.unwrapWithSecret(w, secret, id); } catch (_) { return false; }
      await unlock(raw);
      onNotice('unlocked with your passkey', 'ok');
      return true;
    }

    async function signInWithPasskey() {
      requirePasskeys();
      try {
        const start = await client.auth.passkey.startAuthentication();
        if (start.error) throw start.error;
        const got = await env.passkeys.get(start.data.options);
        const { data, error } = await client.auth.passkey.verifyAuthentication({ challengeId: start.data.challenge_id, credential: got.credential });
        if (error) throw error;
        pendingPasskey = got.secret ? { id: got.id, secret: got.secret } : null;
        await setUser(data.user || (data.session && data.session.user));
      } catch (err) {
        throw friendly(err);
      } finally {
        pendingPasskey = null;
      }
      if (vault.mode === 'locked') onNotice("this passkey signed you in, but it can't unlock your log on this device yet (it may not support unlocking, or was added before). Use /link or /recover once; then Settings → Passkeys → Add a passkey here.", 'dim');
    }

    // A local prompt (no server challenge) for the PRF secret of one of
    // `ids`: unlocking needs no proof to the server, only the secret.
    async function passkeySecret(ids) {
      const got = await env.passkeys.get({ challenge: env.passkeys.random(), userVerification: 'required', timeout: 120000 }, { allow: ids });
      return got;
    }

    async function addPasskey(name) {
      requirePasskeys();
      requireKey();
      const wraps = await passkeyWraps();
      if (!wraps) throw new Error(PASSKEY_SETUP);
      let made;
      let meta;
      try {
        const start = await client.auth.passkey.startRegistration();
        if (start.error) throw start.error;
        made = await env.passkeys.create(start.data.options);
        const v = await client.auth.passkey.verifyRegistration({ challengeId: start.data.challenge_id, credential: made.credential });
        if (v.error) throw v.error;
        meta = v.data || {};
        if (name && meta.id) await client.auth.passkey.update({ passkeyId: meta.id, friendlyName: String(name).slice(0, 120) });
      } catch (err) {
        throw friendly(err);
      }
      // The secret: some browsers give it when the passkey is made, others
      // only when it's used (one more touch, here).
      let secret = made.secret;
      if (!secret && made.prfEnabled) {
        try { secret = (await passkeySecret([made.id])).secret; } catch (_) { secret = null; }
      }
      if (!secret) return { signIn: true, unlock: false };
      const copy = await V.wrapWithSecret(vault.raw, secret, made.id);
      const entry = { id: made.id, pid: meta.id || '', kid: await V.keyId(vault.raw), at: Date.now(), name: name || '', ...copy };
      await savePasskeyWraps([...wraps.filter((x) => x.id !== made.id), entry]);
      return { signIn: true, unlock: true };
    }

    // A signed-in device without the key: unlock with a passkey instead of
    // /link or the recovery key.
    async function unlockWithPasskey() {
      requirePasskeys();
      if (!user) throw new Error('not signed in · /login you@example.com');
      if (vault.mode === 'ready') throw new Error('this device already has the key');
      const wraps = await passkeyWraps();
      if (!wraps || !wraps.length) throw new Error('no passkey can unlock this account yet: add one (Settings → Passkeys) on a device that has the key');
      let got;
      try { got = await passkeySecret(wraps.map((x) => x.id)); } catch (err) { throw friendly(err); }
      if (!got.secret) throw new Error("this passkey can't unlock (its app or this browser doesn't support it)");
      const { data } = await fetchKeyring();
      if (!(await unlockWithSecret({ id: got.id, secret: got.secret }, data && data.recovery && data.recovery.kid))) throw new Error("that passkey can't unlock this account's current key");
      await sync({ full: true });
    }

    // Supabase's passkeys for this account, and which of them unlock.
    async function listPasskeys() {
      requireClient();
      if (!user) throw new Error('not signed in · /login you@example.com');
      const { data, error } = await client.auth.passkey.list();
      if (error) throw friendly(error);
      const wraps = (await passkeyWraps()) || [];
      return (data || []).map((p) => ({ id: p.id, name: p.friendly_name || 'passkey', created: p.created_at, used: p.last_used_at || '', unlocks: wraps.some((x) => x.pid === p.id) }));
    }

    async function removePasskey(passkeyId) {
      requireClient();
      if (!user) throw new Error('not signed in · /login you@example.com');
      const { error } = await client.auth.passkey.delete({ passkeyId });
      if (error) throw friendly(error);
      const wraps = await passkeyWraps();
      if (wraps && wraps.some((x) => x.pid === passkeyId)) await savePasskeyWraps(wraps.filter((x) => x.pid !== passkeyId));
    }

    function requireKey() {
      requireClient();
      if (!user) throw new Error('not signed in · /login you@example.com');
      if (vault.mode === 'plain' || vault.mode === 'unsupported') throw new Error('encryption is not set up on the server yet (run supabase/schema.sql)');
      if (vault.mode === 'none') throw new Error("encryption isn't turned on for this account yet: /encrypt");
      if (vault.mode !== 'ready') throw new Error("this device doesn't have the key yet: /link <code> or /recover <key>");
    }

    // Show-once code that lets another device fetch the key for 10 minutes.
    async function createLink() {
      requireKey();
      const code = V.newLinkCode();
      const link = { ...(await V.wrap(vault.raw, code)), expires: Date.now() + LINK_TTL_MS };
      const { error } = await client.from('keyring').update({ link }).eq('user_id', owner);
      if (error) throw error;
      return code;
    }

    async function newRecoveryKey() {
      requireKey();
      const code = V.newRecoveryCode();
      const recovery = { ...(await V.wrap(vault.raw, code)), kid: await V.keyId(vault.raw) };
      const { error } = await client.from('keyring').update({ recovery }).eq('user_id', owner);
      if (error) throw error;
      recoveryShown(recovery);
      return recoveryMessage(code, false);
    }

    // Unlock this device with a /link code or the recovery key.
    async function unlockWith(kind, code) {
      requireClient();
      if (!user) throw new Error('not signed in · /login you@example.com');
      if (vault.mode === 'ready') throw new Error('this device already has the key');
      if (vault.mode === 'plain' || vault.mode === 'unsupported') throw new Error('encryption is not set up on the server yet');
      const { data, error } = await fetchKeyring();
      if (error) throw error;
      if (!data) throw new Error("encryption isn't turned on for this account yet: /encrypt");
      const blob = kind === 'link' ? data.link : data.recovery;
      if (kind === 'link' && (!blob || blob.expires < Date.now())) {
        throw new Error('no active link code. On a device that is set up, type /link (codes last 10 minutes)');
      }
      let raw;
      try {
        raw = await V.unwrap(blob, code);
      } catch (_) {
        throw new Error(kind === 'link' ? 'that link code is not right' : 'that recovery key is not right');
      }
      await unlock(raw);
      if (kind === 'link') await client.from('keyring').update({ link: null }).eq('user_id', owner);
      await sync({ full: true });
    }

    // Send queued changes, then fetch. `full` downloads the whole log;
    // otherwise only recent entries, unless a full download is overdue.
    // Resolves once the sync, and any follow-up it queued (such as sending
    // entries that got new IDs), is done, so the status it leaves is final.
    function sync({ full = false } = {}) {
      if (!user) return Promise.resolve();
      return idle(schedule(async () => {
        const now = Date.now();
        const fullNow = full || now - lastFullPull > FULL_EVERY_MS;
        // Re-check older servers now and then, so new features switch on
        // after supabase/schema.sql has been run.
        if (fullNow && (vault.mode === 'plain' || vault.mode === 'none' || vault.mode === 'unsupported')) vault = { mode: 'pending' };
        if (fullNow && (serverVersion === 1 || !serverNotes || !serverWo)) serverVersion = null;
        if (fullNow && serverSettings === false) serverSettings = null;
        if (fullNow && serverRecords === false) serverRecords = null;
        if (fullNow && !queue.length) await verifyKey(); // flush checks when it has something to send
        const offline = madeOffline(now);
        const known = new Set(entries.map((e) => e.id));
        await flush();
        if (vault.mode === 'locked') return;
        await pull(fullNow);
        if (fullNow) lastFullPull = now;
        if (offline.size) noteInterleaved(offline, known);
        await syncSettings();
        await syncRecords();
        if (vault.mode === 'ready' && !recoveryId) await verifyKey(); // once a session: which recovery key is current
        remindRecovery();
      }));
    }

    // Two devices logging while one (or both) was offline: once they sync,
    // their entries share one timeline, which can switch back and forth
    // between them (each entry runs until the next one starts). Say so when
    // it happens, so it can be fixed.
    const OFFLINE_MS = 5 * 60000;
    function madeOffline(now) {
      const since = Number(storage.getItem(key(owner, 'unsentSince'))) || 0;
      if (!since || now - since < OFFLINE_MS) return new Set();
      // Entries started around then, not old ones queued again (an import,
      // or uploading everything under a new key).
      return new Set(queue.filter((q) => q.op === 'put' && q.entry.ts >= since - 12 * 3600000).map((q) => q.entry.id));
    }
    function noteInterleaved(mine, known) {
      const theirs = (e) => !known.has(e.id) && !mine.has(e.id);
      const both = entries.filter((e) => mine.has(e.id) || theirs(e));
      if (!both.some((e) => !mine.has(e.id))) return;
      // Interleaved: some entry from one device lies between two of the other's.
      let from = null;
      let prev = null;
      let switches = 0;
      let first = null;
      let last = null;
      for (const e of both) {
        const side = mine.has(e.id);
        if (from !== null && side !== from) {
          switches++;
          if (!first) first = prev;
          last = e;
        }
        from = side;
        prev = e;
      }
      if (switches < 2) return;
      const day = T.ymd(first.ts);
      onNotice(`While this device was offline, another device logged entries in the same hours (${day}, ${T.clock(first.ts)}–${T.clock(last.ts)}). They're now on one timeline, switching between the two. /log ${day} shows it; /edit fixes it.`, 'err');
    }

    // After `run`, wait for whatever was queued behind it meanwhile.
    async function idle(run) {
      await run;
      while (true) {
        const last = chain;
        await last;
        if (last === chain) return;
      }
    }

    // ---- auth --------------------------------------------------------------

    async function setUser(next) {
      const id = next ? next.id : null;
      if ((user && user.id) === id) {
        if (next) user = { id: next.id, email: next.email };
        return;
      }
      user = next ? { id: next.id, email: next.email } : null;
      vault = { mode: 'pending' };
      lastFullPull = 0;
      changedCursor = null;
      serverSettings = null;
      settingsNoticeShown = false;
      serverRecords = null;
      recordsCursor = null;
      loadOwner(user ? user.id : LOCAL);
      status = user ? 'syncing' : 'signed-out';
      onChange();
      if (!user) return;
      onNotice(`signed in as ${user.email}`, 'ok');
      await sync({ full: true });
      const local = read(key(LOCAL, 'entries'), []).filter(valid);
      if (local.length) {
        onNotice(`${local.length} entr${local.length === 1 ? 'y was' : 'ies were'} logged on ${env.place} while signed out. /import adds them to your account.`, 'dim');
      }
    }

    async function init() {
      migrateLegacy();
      loadOwner(LOCAL);
      if (!configured) return;
      try {
        // Accept the project URL with or without the Data API path on the end.
        const url = config.supabaseUrl.trim().replace(/\/(rest|auth)\/v1\/?$/, '').replace(/\/+$/, '');
        client = await env.createClient(url, config.supabaseAnonKey.trim(), {
          persistSession: true, autoRefreshToken: true, storageKey: 'tymlee.auth',
        });
      } catch (err) {
        status = 'error';
        lastError = err.message;
        onNotice(`sync unavailable: ${err.message}`, 'err');
        return;
      }
      client.auth.onAuthStateChange((event, session) => {
        // Supabase asks that no other Supabase calls are awaited inside this callback.
        if (event === 'SIGNED_OUT' && user && !signingOut) {
          // Not /logout: the session ended (its renewal was refused, or the
          // browser cleared it). Kept for /problem.
          try { storage.setItem('tymlee.lastSignOut', JSON.stringify({ at: Date.now(), online: env.isOnline(), error: lastError || '' })); } catch (_) { /* fine */ }
          setTimeout(() => onNotice(`you were signed out: the session ended. Sign in again${env.passkeys ? ' (with a passkey it is one touch)' : ''}; your log on this device is kept.`, 'err'), 0);
        }
        setTimeout(() => setUser(session ? session.user : null), 0);
      });
      const { data } = await client.auth.getSession();
      const session = data && data.session;
      if (session) await setUser(session.user);

      env.watch({
        online: () => sync(),
        offline: () => { if (user) { status = 'offline'; onChange(); } },
        visible: () => sync(),
        tick: () => sync(),
      }, PULL_EVERY_MS);
    }

    function redirectUrl() {
      return env.redirectUrl();
    }

    async function login(email) {
      requireClient();
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectUrl(), shouldCreateUser: true },
      });
      if (error) throw error;
    }

    async function verify(email, code) {
      requireClient();
      const { data, error } = await client.auth.verifyOtp({ email, token: code, type: 'email' });
      if (error) throw error;
      await setUser(data.user || (data.session && data.session.user));
    }

    let signingOut = false;
    async function logout() {
      requireClient();
      const who = owner;
      await chain; // let any in-progress sync finish first
      signingOut = true;
      const { error } = await client.auth.signOut().finally(() => setTimeout(() => { signingOut = false; }, 1000));
      if (error) throw error;
      await setUser(null);
      // Don't leave the account's entries behind on this browser.
      if (who !== LOCAL) clearOwner(who);
    }

    // Move entries logged while signed out into the signed-in account.
    function importLocal() {
      if (!user) throw new Error('not signed in · /login you@example.com');
      const local = read(key(LOCAL, 'entries'), []).filter(valid);
      const have = new Set(entries.map((e) => e.id));
      const fresh = local.filter((e) => !have.has(e.id));
      queue = T.enqueueAll(queue, fresh.map((e) => ({ op: 'put', entry: e })), inFlight);
      entries = T.applyOps(entries, fresh.map((e) => ({ op: 'put', entry: e })));
      persist();
      clearOwner(LOCAL);
      onChange();
      schedule(flush);
      return fresh.length;
    }

    function requireClient() {
      if (!configured) throw new Error('sync is not configured; see README (config.js)');
      if (!client) throw new Error(`sync unavailable: ${lastError || 'still starting'}`);
    }

    return {
      init,
      add,
      remove,
      apply,
      sync,
      login,
      verify,
      logout,
      importLocal,
      enableEncryption,
      createLink,
      unlockWith,
      newRecoveryKey,
      checkRecovery,
      signInWithPasskey,
      addPasskey,
      unlockWithPasskey,
      listPasskeys,
      removePasskey,
      get passkeysAvailable() { return Boolean(configured && env.passkeys); },
      lastSignOut() {
        try { return JSON.parse(storage.getItem('tymlee.lastSignOut') || 'null'); } catch (_) { return null; }
      },
      get recoveryConfirmed() { return recoveryConfirmed(); },
      resetEncryption,
      get encryption() { return vault.mode; },
      supports,
      notesSupported: () => supports('notes'),
      get timesSealed() { return vault.mode === 'ready' && serverVersion === 2; },
      get entries() { return entries; },
      get settings() { return settings; },
      setSettings,
      recordsReady,
      listRecords,
      putRecord,
      deleteRecords,
      // For full backups: every record as stored, and adding back missing ones.
      allRecords: () => records.filter((r) => !r.deleted).map((r) => ({ id: r.id, kind: r.kind, body: r.body, at: r.at })),
      importRecords(list) {
        const have = new Set(records.map((r) => r.id));
        const fresh = list.filter((r) => !have.has(r.id));
        for (const r of fresh) {
          records.push({ id: r.id, kind: r.kind, body: r.body, at: r.at || Date.now() });
          touchRecord(r.id);
        }
        if (fresh.length) {
          persistRecords();
          onChange();
          if (user) schedule(syncRecords);
        }
        return fresh.length;
      },
      get user() { return user; },
      get pending() { return queue.length; },
      // Since when changes have been waiting to be sent (0: nothing waiting).
      get unsentSince() {
        if (!user || !queue.length) return 0;
        try { return Number(storage.getItem(key(owner, 'unsentSince'))) || 0; } catch (_) { return 0; }
      },
      get status() { return status; },
      get lastError() { return lastError; },
      get configured() { return configured; },
      reloadFromStorage() { loadOwner(owner); onChange(); },
      settingsKey() { return key(owner, 'settings'); },
      // Stored keys that, changed by another tab, mean reloading.
      watchedKeys() { return ['entries', 'settings', 'records'].map((w) => key(owner, w)); },
      // Resolves once queued network work (sending changes, syncing) is done.
      whenIdle() { return chain; },
      get client() { return client; },
      storageKey() { return key(owner, 'entries'); },
    };
  }

  const api = { createStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TymleeStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
