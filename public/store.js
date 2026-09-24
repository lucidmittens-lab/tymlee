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
    };
  }

  function createStore({ onChange, onNotice, env: givenEnv }) {
    const env = givenEnv || browserEnv();
    const { T, V, storage } = env;
    const config = env.config || {};
    const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);

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
    //   'plain'    the server has no keyring table yet: sync without encryption
    //   'none'     encryption is available but not turned on (/encrypt)
    //   'locked'   the account is encrypted but this device has no key yet
    //   'ready'    this device holds the key; text is encrypted on upload
    let vault = { mode: 'pending' };
    let promptedEncrypt = false; // the /encrypt suggestion is shown once per page load

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
    }

    function persist() {
      write(key(owner, 'entries'), entries);
      write(key(owner, 'queue'), queue);
    }

    function clearOwner(who) {
      storage.removeItem(key(who, 'entries'));
      storage.removeItem(key(who, 'queue'));
      storage.removeItem(key(who, 'key'));
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
    function apply(ops) {
      if (!ops.length) return;
      for (const op of ops) queue = owner === LOCAL ? [] : T.enqueue(queue, op, inFlight);
      entries = T.applyOps(entries, ops);
      persist();
      onChange();
      if (user) schedule(flush);
    }

    function change(op) {
      apply([op]);
    }

    function add(text) {
      const last = entries[entries.length - 1];
      const ts = Math.max(Date.now(), last ? last.ts + 1 : 0);
      const entry = { id: T.uuid(), ts, text };
      change({ op: 'put', entry });
      return entry;
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
    let changedCursor = null; // latest modified_at seen (ms), v2 only
    const CURSOR_MARGIN_MS = 2 * 60000; // re-read a little overlap, in case of slow writes
    const V2_COLUMNS = 'id,ts,text,modified_at,deleted';

    function missingColumn(error) {
      return error.code === '42703' || error.code === 'PGRST204' ||
        /column .*does not exist|could not find the .* column/i.test(error.message || '');
    }

    async function detectServer() {
      if (serverVersion) return;
      const { error } = await client.from('entries').select(V2_COLUMNS).order('id', { ascending: true }).range(0, 0);
      if (error && !missingColumn(error)) throw error;
      serverVersion = error ? 1 : 2;
    }

    // Send queued changes, in order, in batches.
    async function flush() {
      if (!user || !client) return;
      if (!(await vaultOpen())) return;
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

    // The row to upload for an entry. With the account's key, the text (and
    // on v2 servers the start time too) is encrypted.
    async function sealRow(entry, who) {
      const row = { id: entry.id, user_id: who, ts: entry.ts, text: entry.text };
      if (vault.mode === 'ready' && serverVersion === 2) {
        row.ts = 0;
        row.text = await V.sealEntry(vault.key, entry.id, entry);
      } else if (vault.mode === 'ready') {
        row.text = await V.encryptText(vault.key, entry.id, entry.text);
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
      let reseal = false;
      const encrypted = V.isSealed(text) || V.isEncrypted(text);
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
          ({ ts, text } = await V.openEntry(vault.key, r.id, text));
        }
      } catch (_) {
        seen.unreadable++;
        return null;
      }
      if (!encrypted && vault.mode === 'ready') reseal = true;
      return { entry: { id: r.id, ts, text }, reseal };
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
      const seen = { encrypted: false, unreadable: 0 };
      let newest = changedCursor;
      const page = 1000;
      for (let from = 0; ; from += page) {
        let query = client.from('entries').select(v2 ? V2_COLUMNS : 'id,ts,text');
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
      for (const o of reseal) queue = T.enqueue(queue, { op: 'put', entry: o.entry }, inFlight);
      entries = T.applyOps(base, queue);
      persist();
      if (seen.unreadable) onNotice(`${seen.unreadable} entr${seen.unreadable === 1 ? 'y' : 'ies'} could not be decrypted and are hidden`, 'err');
      if (reseal.length) schedule(flush);
      settle();
      // Another device has turned encryption on: find out and lock this one.
      if (seen.encrypted && (vault.mode === 'none' || vault.mode === 'plain')) {
        vault = { mode: 'pending' };
        schedule(prepareVault);
      }
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
      ].join('\n'), 'key');
    }

    function recoveryMessage(code, first) {
      return [
        first ? 'Encryption is on for this account. Your recovery key:' : 'Your new recovery key (the old one no longer works):',
        '',
        `  ${code}`,
        '',
        'Save it somewhere safe, like a password manager. It is the only way back into your log if you lose access to all your devices, and nobody else, including whoever runs this site, can recover it for you.',
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
        if (missingTable(error)) { vault = { mode: 'plain' }; return; }
        throw error;
      }
      if (data) { lock(); return; }
      // Encryption is available but this account hasn't turned it on yet.
      const firstTime = !promptedEncrypt;
      vault = { mode: 'none' };
      if (firstTime) {
        promptedEncrypt = true;
        onNotice([
          'Your log is not encrypted yet.',
          '',
          'Type /encrypt to turn on end-to-end encryption: your entries are encrypted on your devices before they are uploaded, so nobody else can read them, including whoever runs this site. You will get a recovery key to save.',
        ].join('\n'), 'key');
      }
    }

    // Turn encryption on for this account: create the master key, lock a copy
    // with a new recovery key, and re-upload every entry encrypted.
    async function enableEncryption() {
      requireClient();
      if (!user) throw new Error('sign in first: /login you@example.com');
      if (vault.mode === 'pending' || vault.mode === 'plain' || vault.mode === 'none') await schedule(prepareVault);
      if (vault.mode === 'ready') throw new Error('encryption is already on, and this device has the key');
      if (vault.mode === 'locked') throw new Error("encryption is already on for this account; this device doesn't have the key yet (/link or /recover)");
      if (vault.mode === 'plain') throw new Error('encryption is not available: the server needs the latest supabase/schema.sql');
      const who = owner;
      const raw = V.newMasterKey();
      const code = V.newRecoveryCode();
      const recovery = await V.wrap(raw, code);
      const created = await client.from('keyring').insert({ user_id: who, recovery });
      if (created.error) {
        if (created.error.code === '23505') { // another device got there first
          lock();
          throw new Error('another device turned encryption on first; link this one with /link');
        }
        throw created.error;
      }
      await unlock(raw);
      onNotice(recoveryMessage(code, true), 'key');
      await sync({ full: true }); // re-uploads existing entries encrypted
    }

    // True when entries can be synced (encrypted, or plain on a server that
    // doesn't support encryption yet).
    async function vaultOpen() {
      if (vault.mode === 'pending') await prepareVault();
      if (vault.mode === 'locked') {
        status = 'locked';
        onChange();
        return false;
      }
      return vault.mode === 'ready' || vault.mode === 'plain' || vault.mode === 'none';
    }

    function requireKey() {
      requireClient();
      if (!user) throw new Error('sign in first: /login you@example.com');
      if (vault.mode === 'plain') throw new Error('encryption is not set up on the server yet (run supabase/schema.sql)');
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
      const recovery = await V.wrap(vault.raw, code);
      const { error } = await client.from('keyring').update({ recovery }).eq('user_id', owner);
      if (error) throw error;
      return recoveryMessage(code, false);
    }

    // Unlock this device with a /link code or the recovery key.
    async function unlockWith(kind, code) {
      requireClient();
      if (!user) throw new Error('sign in first: /login you@example.com');
      if (vault.mode === 'ready') throw new Error('this device already has the key');
      if (vault.mode === 'plain') throw new Error('encryption is not set up on the server yet');
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
    function sync({ full = false } = {}) {
      if (!user) return Promise.resolve();
      return schedule(async () => {
        const now = Date.now();
        const fullNow = full || now - lastFullPull > FULL_EVERY_MS;
        // Re-check older servers now and then, so new features switch on
        // after supabase/schema.sql has been run.
        if (fullNow && (vault.mode === 'plain' || vault.mode === 'none')) vault = { mode: 'pending' };
        if (fullNow && serverVersion === 1) serverVersion = null;
        await flush();
        if (vault.mode === 'locked') return;
        await pull(fullNow);
        if (fullNow) lastFullPull = now;
      });
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

    async function logout() {
      requireClient();
      const who = owner;
      await chain; // let any in-progress sync finish first
      const { error } = await client.auth.signOut();
      if (error) throw error;
      await setUser(null);
      // Don't leave the account's entries behind on this browser.
      if (who !== LOCAL) clearOwner(who);
    }

    // Move entries logged while signed out into the signed-in account.
    function importLocal() {
      if (!user) throw new Error('sign in first: /login you@example.com');
      const local = read(key(LOCAL, 'entries'), []).filter(valid);
      const have = new Set(entries.map((e) => e.id));
      const fresh = local.filter((e) => !have.has(e.id));
      for (const e of fresh) queue = T.enqueue(queue, { op: 'put', entry: e }, inFlight);
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
      get encryption() { return vault.mode; },
      get timesSealed() { return vault.mode === 'ready' && serverVersion === 2; },
      get entries() { return entries; },
      get user() { return user; },
      get pending() { return queue.length; },
      get status() { return status; },
      get lastError() { return lastError; },
      get configured() { return configured; },
      reloadFromStorage() { loadOwner(owner); onChange(); },
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
