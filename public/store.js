// Entry storage. Always works offline from localStorage; when Supabase is
// configured (config.js) and the user is signed in, changes are queued and
// synced to their account, and the account's entries are pulled back down.
(function () {
  'use strict';

  const T = window.Tymlee;
  const LEGACY_KEY = 'tymlee.entries.v1';
  const LOCAL = 'local'; // owner id for the signed-out, this-browser-only log
  const SUPABASE_SRC = 'vendor/supabase.js';
  const PULL_EVERY_MS = 60000;
  // Routine checks only download entries from the last two weeks, so their
  // size stays small however long the log gets. A full download happens on
  // page load, sign-in, /sync, and at least every few hours.
  const RECENT_MS = 14 * 86400000;
  const FULL_EVERY_MS = 6 * 3600000;

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
      const who = owner;
      let batch;
      while (owner === who && (batch = T.nextBatch(queue, 500))) {
        status = 'syncing';
        inFlight = batch.ops.length;
        try {
          const table = client.from('entries');
          const { error } = batch.kind === 'put'
            ? await table.upsert(batch.ops.map((q) => ({ ...q.entry, user_id: who })))
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

    // Download the account's entries (all of them, or only those since
    // `since`), then re-apply unsent changes on top.
    async function pull(since) {
      if (!user || !client) return;
      const who = owner;
      const rows = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        let query = client.from('entries').select('id,ts,text');
        if (since != null) query = query.gte('ts', since);
        const { data, error } = await query.order('ts', { ascending: true }).range(from, from + page - 1);
        if (error) throw error;
        rows.push(...data.map((r) => ({ id: r.id, ts: Number(r.ts), text: r.text })));
        if (data.length < page) break;
      }
      if (owner !== who) return;
      const base = since == null ? rows : T.mergeRecent(entries, rows, since);
      entries = T.applyOps(base, queue);
      write(key(owner, 'entries'), entries);
      settle();
    }

    // Send queued changes, then fetch. `full` downloads the whole log;
    // otherwise only recent entries, unless a full download is overdue.
    function sync({ full = false } = {}) {
      if (!user) return Promise.resolve();
      return schedule(async () => {
        await flush();
        const now = Date.now();
        if (full || now - lastFullPull > FULL_EVERY_MS) {
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
