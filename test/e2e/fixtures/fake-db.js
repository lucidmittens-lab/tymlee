// A stand-in Supabase server kept in a JSON file, so a browser test and
// terminal processes can share it. fakeDb(uid, table, op, ...args).
const fs = require('fs');
const FILE = process.env.TYMLEE_FAKE_DB;
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { entries: {}, keyring: {}, stamp: 0 }; } };
const save = (db) => fs.writeFileSync(FILE, JSON.stringify(db));
function fakeDb(uid, table, op, ...a) {
  if (!uid) return { data: null, error: { message: 'JWT required' } };
  const db = load();
  const stamp = () => new Date((db.stamp = Math.max(Date.now(), db.stamp + 1))).toISOString();
  try {
    if (table === 'keyring') {
      if (op === 'single') return { data: db.keyring[uid] || null, error: null };
      if (op === 'insert') {
        if (db.keyring[uid]) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        db.keyring[uid] = { recovery: a[0].recovery, link: null };
        return { data: null, error: null };
      }
      if (op === 'update') { if (a[1] === uid && db.keyring[uid]) Object.assign(db.keyring[uid], a[0]); return { data: null, error: null }; }
    }
    if (op === 'select') {
      const q = a[0];
      let rows = Object.values(db.entries).filter((r) => r.user_id === uid);
      if (q.gte) { const [c, v] = q.gte; rows = rows.filter((r) => (c === 'modified_at' ? Date.parse(r.modified_at) >= Date.parse(v) : r[c] >= v)); }
      const by = q.order || 'id';
      rows.sort((x, y) => (x[by] < y[by] ? -1 : x[by] > y[by] ? 1 : 0));
      const cols = q.cols.split(',');
      return { data: rows.slice(q.from, q.to + 1).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), error: null };
    }
    if (op === 'upsert') {
      for (const r of a[0]) if (r.user_id !== uid) return { data: null, error: { message: 'row-level security' } };
      for (const r of a[0]) db.entries[r.id] = { ...(db.entries[r.id] || {}), ...r, modified_at: stamp(), deleted: r.deleted || false };
      return { data: null, error: null };
    }
    if (table === 'records') return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.records' in the schema cache" } };
  return { data: null, error: { message: `unexpected ${table}.${op}` } };
  } finally {
    save(db);
  }
}
module.exports = { fakeDb, load };
