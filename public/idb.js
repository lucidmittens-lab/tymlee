// Browser storage for the log: IndexedDB, which has room for decades of
// entries (local storage stops at about 5 MB). Everything is read into memory
// when the page opens, so the store reads and writes it like local storage;
// changes are written to IndexedDB in the background, and other open tabs
// are told so they can reload.
//
// Small view preferences (the chosen view, the console size) stay in local
// storage; the log, its queue, settings and key move here.
(function (root) {
  'use strict';

  const DB_NAME = 'tymlee';
  const STORE = 'kv';
  const MOVES = /^tymlee\.(v2\.|entries\.v1$)/;

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function open() {
    const req = root.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    return request(req);
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  }

  async function readAll(db, keys) {
    const tx = db.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    if (keys) return Promise.all(keys.map(async (k) => [k, await request(os.get(k))]));
    const [ks, vs] = await Promise.all([request(os.getAllKeys()), request(os.getAll())]);
    return ks.map((k, i) => [k, vs[i]]);
  }

  // A storage object for the store: getItem / setItem / removeItem like
  // local storage, plus onChange(cb) for changes made in other tabs. Falls
  // back to local storage itself when IndexedDB can't be opened (some
  // private browsing modes).
  async function createStorage() {
    const local = root.localStorage;
    let db;
    try {
      db = await open();
    } catch (_) {
      return {
        kind: 'local storage',
        getItem: (k) => local.getItem(k),
        setItem: (k, v) => local.setItem(k, v),
        removeItem: (k) => local.removeItem(k),
        flushed: () => Promise.resolve(),
        onChange(cb) { root.addEventListener('storage', (e) => { if (e.key) cb([e.key]); }); },
      };
    }
    const values = new Map();
    for (const [k, v] of await readAll(db)) if (typeof v === 'string') values.set(k, v);

    const pending = new Set();
    let writing = null;
    let failed = false;
    const listeners = [];
    const channel = typeof root.BroadcastChannel === 'function' ? new root.BroadcastChannel('tymlee-storage') : null;

    async function flush() {
      while (pending.size) {
        const keys = [...pending];
        pending.clear();
        const tx = db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        for (const k of keys) {
          if (values.has(k)) os.put(values.get(k), k);
          else os.delete(k);
        }
        try {
          await done(tx);
          failed = false;
          if (channel) channel.postMessage(keys);
        } catch (err) {
          for (const k of keys) pending.add(k); // try again with the next change
          if (!failed) console.error('tymlee: could not save to IndexedDB', err);
          failed = true;
          return;
        }
      }
    }

    function schedule() {
      if (!writing) writing = Promise.resolve().then(flush).finally(() => { writing = null; });
    }

    // Move what older versions kept in local storage, then remove it there
    // once it is safely written here.
    const moving = [];
    for (let i = 0; i < local.length; i++) {
      const k = local.key(i);
      if (MOVES.test(k)) moving.push(k);
    }
    if (moving.length) {
      for (const k of moving) {
        values.set(k, local.getItem(k));
        pending.add(k);
      }
      await flush();
      if (!pending.size) for (const k of moving) local.removeItem(k);
    }

    if (channel) {
      channel.onmessage = async (e) => {
        const keys = Array.isArray(e.data) ? e.data : [];
        for (const [k, v] of await readAll(db, keys)) {
          if (typeof v === 'string') values.set(k, v);
          else values.delete(k);
        }
        for (const cb of listeners) cb(keys);
      };
    }

    // Ask the browser not to clear this site's data when space runs low
    // (Chrome decides quietly; Firefox would ask, so it isn't asked there).
    const nav = root.navigator;
    if (nav.storage && nav.storage.persist && !/Firefox\//.test(nav.userAgent)) nav.storage.persist().catch(() => {});

    return {
      kind: 'IndexedDB',
      getItem: (k) => (values.has(k) ? values.get(k) : null),
      setItem(k, v) {
        values.set(k, String(v));
        pending.add(k);
        schedule();
      },
      removeItem(k) {
        values.delete(k);
        pending.add(k);
        schedule();
      },
      // Resolves once everything changed so far is written.
      flushed: () => (writing || Promise.resolve()).then(() => (pending.size ? flush() : undefined)),
      onChange(cb) { listeners.push(cb); },
    };
  }

  root.TymleeIdb = { createStorage };
})(typeof globalThis !== 'undefined' ? globalThis : this);
