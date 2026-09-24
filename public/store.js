// Entry storage. Always works offline from localStorage; when Supabase is
// configured (config.js) and the user is signed in, changes are queued and
// synced to their account, and the account's entries are pulled back down.
// Entry text is encrypted before upload once the account has a key (vault.js).
(function () {
  'use strict';

  const T = window.Tymlee;
  const V = window.TymleeVault;
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

  function createStore({ onChange, onNotice }) {
    const config = window.TYMLEE_CONFIG || {};
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
        const v = JSON.parse(localStorage.getItem(k));
        return Array.isArray(v) ? v : fallback;
      } catch (_) {
        return fallback;
      }
    }

    function write(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (_) {
        onNotice('warning: could not save to browser storage', 'err');
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
      localStorage.removeItem(key(who, 'entries'));
      localStorage.removeItem(key(who, 'queue'));
      localStorage.removeItem(key(who, 'key'));
    }

    // This device's copy of the account's master key.
    function localKey(who) {
      try { return localStorage.getItem(key(who, 'key')) || ''; } catch (_) { return ''; }
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
      localStorage.removeItem(LEGACY_KEY);
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
      status = navigator.onLine === false ? 'offline' : 'error';
      onChange();
    }

    function settle() {
      if (!user) return;
      status = queue.length ? (navigator.onLine === false ? 'offline' : 'pending') : 'synced';
      lastError = '';
      onChange();
    }

    // Send queued changes, in order, in batches.
    async function flush() {
      if (!user || !client) return;
      if (!(await vaultOpen())) return;
      const who = owner;
      let batch;
      while (owner === who && (batch = T.nextBatch(queue, 500))) {
        status = 'syncing';
        inFlight = batch.ops.length;
        try {
          const table = client.from('entries');
          const { error } = batch.kind === 'put'
            ? await table.upsert(await Promise.all(batch.ops.map((q) => sealRow(q.entry, who))))
            : await table.delete().in('id', batch.ops.map((q) => q.id));
          if (error) throw error;
        } finally {
          inFlight = 0;
        }
        if (owner !== who) return;
        queue = queue.slice(batch.ops.length);
        write(key(owner, 'queue'), queue);
      }
      settle();
    }

    // The row to upload for an entry: its text encrypted when this device
    // holds the account's key.
    async function sealRow(entry, who) {
      const text = vault.mode === 'ready' ? await V.encryptText(vault.key, entry.id, entry.text) : entry.text;
      return { id: entry.id, ts: entry.ts, text, user_id: who };
    }

    // Download the account's entries (all of them, or only those since
    // `since`), then re-apply unsent changes on top.
    async function pull(since) {
      if (!user || !client) return;
      if (!(await vaultOpen())) return;
      const who = owner;
      const rows = [];
      const plain = []; // uploaded before encryption was on; re-sent encrypted
      let unreadable = 0;
      let sawEncrypted = false;
      const page = 1000;
      for (let from = 0; ; from += page) {
        let query = client.from('entries').select('id,ts,text');
        if (since != null) query = query.gte('ts', since);
        const { data, error } = await query.order('ts', { ascending: true }).range(from, from + page - 1);
        if (error) throw error;
        const opened = await Promise.all(data.map(async (r) => {
          const e = { id: r.id, ts: Number(r.ts), text: r.text };
          if (V.isEncrypted(r.text)) {
            if (vault.mode !== 'ready') {
              sawEncrypted = true;
              return null;
            }
            try {
              e.text = await V.decryptText(vault.key, r.id, r.text);
            } catch (_) {
              unreadable++;
              return null;
            }
          } else if (vault.mode === 'ready') {
            plain.push(e);
          }
          return e;
        }));
        rows.push(...opened.filter(Boolean));
        if (data.length < page) break;
      }
      if (owner !== who) return;
      const base = since == null ? rows : T.mergeRecent(entries, rows, since);
      // Encrypt anything that is still stored as plain text, unless a newer
      // local change for it is already waiting to be sent.
      const waiting = new Set(queue.map((q) => (q.op === 'put' ? q.entry.id : q.id)));
      for (const e of plain) {
        if (!waiting.has(e.id)) queue = T.enqueue(queue, { op: 'put', entry: e }, inFlight);
      }
      entries = T.applyOps(base, queue);
      persist();
      if (unreadable) onNotice(`${unreadable} entr${unreadable === 1 ? 'y' : 'ies'} could not be decrypted and are hidden`, 'err');
      if (plain.length) schedule(flush);
      settle();
      // Another device has turned encryption on: find out and lock this one.
      if (sawEncrypted && (vault.mode === 'none' || vault.mode === 'plain')) {
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
      try { localStorage.setItem(key(owner, 'key'), raw); } catch (_) { /* this session only */ }
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
        // Re-check servers without encryption support now and then, so it
        // switches on after supabase/schema.sql has been run.
        if (fullNow && (vault.mode === 'plain' || vault.mode === 'none')) vault = { mode: 'pending' };
        await flush();
        if (vault.mode === 'locked') return;
        if (fullNow) {
          await pull();
          lastFullPull = now;
        } else {
          await pull(now - RECENT_MS);
        }
      });
    }

    // ---- auth --------------------------------------------------------------

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.append(s);
      });
    }

    async function setUser(next) {
      const id = next ? next.id : null;
      if ((user && user.id) === id) {
        if (next) user = { id: next.id, email: next.email };
        return;
      }
      user = next ? { id: next.id, email: next.email } : null;
      vault = { mode: 'pending' };
      lastFullPull = 0;
      loadOwner(user ? user.id : LOCAL);
      status = user ? 'syncing' : 'signed-out';
      onChange();
      if (!user) return;
      onNotice(`signed in as ${user.email}`, 'ok');
      await sync({ full: true });
      const local = read(key(LOCAL, 'entries'), []).filter(valid);
      if (local.length) {
        onNotice(`${local.length} entr${local.length === 1 ? 'y was' : 'ies were'} logged in this browser while signed out. /import adds them to your account.`, 'dim');
      }
    }

    async function init() {
      migrateLegacy();
      loadOwner(LOCAL);
      if (!configured) return;
      try {
        if (!window.supabase) await loadScript(SUPABASE_SRC);
        // Accept the project URL with or without the Data API path on the end.
        const url = config.supabaseUrl.trim().replace(/\/(rest|auth)\/v1\/?$/, '').replace(/\/+$/, '');
        client = window.supabase.createClient(url, config.supabaseAnonKey.trim(), {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'tymlee.auth' },
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

      window.addEventListener('online', () => sync());
      window.addEventListener('offline', () => { if (user) { status = 'offline'; onChange(); } });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') sync();
      });
      setInterval(() => { if (document.visibilityState !== 'hidden') sync(); }, PULL_EVERY_MS);
    }

    function redirectUrl() {
      return location.origin + location.pathname;
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
      get entries() { return entries; },
      get user() { return user; },
      get pending() { return queue.length; },
      get status() { return status; },
      get lastError() { return lastError; },
      get configured() { return configured; },
      reloadFromStorage() { loadOwner(owner); onChange(); },
      storageKey() { return key(owner, 'entries'); },
    };
  }

  window.TymleeStore = { createStore };
})();
