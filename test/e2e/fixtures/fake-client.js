// Stand-in for @supabase/supabase-js createClient() in the terminal app,
// talking to fake-db.js. Loaded via TYMLEE_CLIENT_MODULE.
const { fakeDb } = require('./fake-db.js');
exports.createClient = (url, key, opts) => {
  const storage = opts.auth.storage;
  const skey = opts.auth.storageKey;
  const listeners = [];
  const getSession = () => JSON.parse(storage.getItem(skey) || 'null');
  const emit = (ev, s) => listeners.forEach((cb) => cb(ev, s));
  const call = async (...args) => { const s = getSession(); return fakeDb(s && s.user.id, ...args); };
  return {
    auth: {
      async getSession() { return { data: { session: getSession() } }; },
      onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithOtp() { return { error: null }; },
      async verifyOtp({ email, token }) {
        if (token !== '123456') return { data: {}, error: { message: 'Token has expired or is invalid' } };
        const session = { user: { id: 'user-' + email, email } };
        storage.setItem(skey, JSON.stringify(session));
        emit('SIGNED_IN', session);
        return { data: { user: session.user, session }, error: null };
      },
      async signOut() { storage.removeItem(skey); emit('SIGNED_OUT', null); return { error: null }; },
    },
    from(table) {
      const run = (...args) => call(table, ...args);
      return {
        select(cols) {
          const spec = { cols, gte: null, order: null };
          const q = { gte(c, v) { spec.gte = [c, v]; return q; }, order(c) { spec.order = c; return q; }, range: (a, b) => run('select', { ...spec, from: a, to: b }), maybeSingle: () => run('single') };
          return q;
        },
        upsert: (rows) => run('upsert', rows),
        insert: (row) => run('insert', row),
        update: (fields) => ({ eq: (c, v) => run('update', fields, v) }),
      };
    },
  };
};
