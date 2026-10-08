// Minimal stand-in for the supabase-js subset used by store.js. Data lives in
// the Node test process (window.fakeDb) so several browser contexts share it.
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
    },
    from(table) {
      // This stand-in is a server where supabase/schema.sql's encryption part
      // hasn't been run: the keyring table doesn't exist.
      if (table === 'keyring') {
        const missing = async () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.keyring' in the schema cache" } });
        return { select: () => ({ maybeSingle: missing }), insert: missing, update: () => ({ eq: missing }) };
      }
      return {
        select(cols) {
          let since = null;
          const noColumn = async () => ({ data: null, error: { code: '42703', message: 'column entries.modified_at does not exist' } });
          const q = { gte(col, v) { since = v; return q; }, order() { return q; }, range: (a, b) => (cols && cols.includes('modified_at') ? noColumn() : call('select', a, b, since)) };
          return q;
        },
        upsert: (rows) => call('upsert', rows),
        delete() { return { in: (col, ids) => call('delete', ids) }; },
      };
    },
  };
  // Simulates the redirect back from the emailed sign-in link.
  window.__clickLink = () => {
    const session = { user: { id: 'user-' + window.__otpEmail, email: window.__otpEmail } };
    localStorage.setItem('fake.session', JSON.stringify(session));
    emit('SIGNED_IN', session);
  };
  window.supabase = { createClient: () => client };
})();
