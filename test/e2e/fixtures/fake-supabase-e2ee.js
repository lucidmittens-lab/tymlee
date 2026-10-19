// Stand-in for supabase-js backed by window.fakeDb(uid, table, op, ...args),
// which lives in the Node test process so several browser contexts share it.
(() => {
  window.TYMLEE_CONFIG = { supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'anon', allowUnencrypted: window.__strict ? undefined : true };
  const listeners = [];
  const getSession = () => JSON.parse(localStorage.getItem('fake.session') || 'null');
  const emit = (ev, s) => listeners.forEach((cb) => cb(ev, s));
  const call = async (...args) => {
    if (window.__offline) return { data: null, error: { message: 'Failed to fetch' } };
    const s = getSession();
    return window.fakeDb(s && s.user.id, ...args);
  };
  const client = {
    auth: {
      async getSession() { return { data: { session: getSession() } }; },
      onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithOtp({ email }) { window.__otpEmail = email; return { error: null }; },
      async verifyOtp({ email, token }) {
        if (token !== '123456') return { data: {}, error: { message: 'Token has expired or is invalid' } };
        const session = { user: { id: 'user-' + email, email } };
        localStorage.setItem('fake.session', JSON.stringify(session));
        emit('SIGNED_IN', session);
        return { data: { user: session.user, session }, error: null };
      },
      async signOut() { localStorage.removeItem('fake.session'); emit('SIGNED_OUT', null); return { error: null }; },
      // Passkeys: answered by window.fakePasskeys(op, user, params) when a
      // test provides it (passkey-e2e.js); otherwise "not enabled".
      passkey: (() => {
        const ask = async (op, params) => {
          if (!window.fakePasskeys) return { data: null, error: { message: 'passkeys are not enabled (404)' } };
          const s = getSession();
          return window.fakePasskeys(op, s && s.user, params || null);
        };
        return {
          startRegistration: () => ask('regStart'),
          verifyRegistration: (p) => ask('regVerify', p),
          startAuthentication: () => ask('authStart'),
          async verifyAuthentication(p) {
            const r = await ask('authVerify', p);
            if (r.data && r.data.user) {
              const session = { user: r.data.user };
              localStorage.setItem('fake.session', JSON.stringify(session));
              r.data.session = session;
              emit('SIGNED_IN', session);
            }
            return r;
          },
          list: () => ask('list'),
          update: (p) => ask('update', p),
          delete: (p) => ask('delete', p),
        };
      })(),
    },
    from(table) {
      const run = (...args) => call(table, ...args);
      return {
        select(cols) {
          const spec = { cols, gte: null, order: null };
          const q = {
            gte(c, v) { spec.gte = [c, v]; return q; },
            order(c) { spec.order = c; return q; },
            range: (a, b) => run('select', { ...spec, from: a, to: b }),
            maybeSingle: () => run('single', spec),
          };
          return q;
        },
        upsert: (rows) => run('upsert', rows),
        insert: (row) => run('insert', row),
        update: (fields) => ({ eq: (c, v) => run('update', fields, v) }),
        delete() { return { in: (c, ids) => run('delete', ids), eq: (c, v) => run('deleteAll', v) }; },
      };
    },
  };
  window.supabase = { createClient: () => client };
})();
