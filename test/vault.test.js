const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/vault.js');

const FAST = 1000; // PBKDF2 iterations for tests; the app uses far more

test('codes are grouped Crockford base32 and forgiving to type', () => {
  const r = V.newRecoveryCode();
  assert.match(r, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  assert.match(V.newLinkCode(), /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
  assert.notEqual(r, V.newRecoveryCode());
  assert.equal(V.normalizeCode(' ab0o-1il '), 'AB00111');
  assert.ok(V.looksLikeCode(r.toLowerCase().replace(/-/g, ' '), 20));
  assert.ok(!V.looksLikeCode('hello', 20));
});

test('wrap and unwrap the master key; a wrong code fails', async () => {
  const raw = V.newMasterKey();
  const code = V.newRecoveryCode();
  const blob = await V.wrap(raw, code, FAST);
  assert.ok(!JSON.stringify(blob).includes(raw));
  assert.equal(await V.unwrap(blob, code.toLowerCase()), raw);
  await assert.rejects(V.unwrap(blob, V.newRecoveryCode()));
});

test('entry text round-trips and is bound to its entry id', async () => {
  const key = await V.importMasterKey(V.newMasterKey());
  const stored = await V.encryptText(key, 'id-1', 'dev fixing the login bug ✓');
  assert.ok(V.isEncrypted(stored));
  assert.ok(!stored.includes('login'));
  assert.equal(await V.decryptText(key, 'id-1', stored), 'dev fixing the login bug ✓');
  // Same text encrypts differently every time.
  assert.notEqual(stored, await V.encryptText(key, 'id-1', 'dev fixing the login bug ✓'));
  // Moved to another entry, or read with another key: rejected.
  await assert.rejects(V.decryptText(key, 'id-2', stored));
  const other = await V.importMasterKey(V.newMasterKey());
  await assert.rejects(V.decryptText(other, 'id-1', stored));
  assert.ok(!V.isEncrypted('dev plain text'));
  assert.ok(!V.isEncrypted('/off'));
});

test('sealed entries hide the time as well as the text', async () => {
  const key = await V.importMasterKey(V.newMasterKey());
  const ts = Date.UTC(2026, 8, 24, 9, 45);
  const stored = await V.sealEntry(key, 'id-1', { ts, text: 'mtg standup' });
  assert.ok(V.isSealed(stored) && !V.isEncrypted(stored));
  assert.ok(!stored.includes('standup') && !stored.includes(String(ts)));
  assert.deepEqual(await V.openEntry(key, 'id-1', stored), { ts, text: 'mtg standup' });
  await assert.rejects(V.openEntry(key, 'id-2', stored));
  assert.ok(!V.isSealed('/e1/abc') && !V.isSealed('/off'));
});

test('notes are sealed with the entry, or encrypted in their own column', async () => {
  const key = await V.importMasterKey(V.newMasterKey());
  const entry = { ts: 5, text: 'dev x', notes: 'secret detail' };
  const stored = await V.sealEntry(key, 'id-1', entry);
  assert.ok(!stored.includes('secret'));
  assert.deepEqual(await V.openEntry(key, 'id-1', stored), entry);
  assert.deepEqual(await V.openEntry(key, 'id-1', await V.sealEntry(key, 'id-1', { ts: 5, text: 'dev x' })), { ts: 5, text: 'dev x' });
  const col = await V.encryptNotes(key, 'id-1', 'secret detail');
  assert.equal(await V.decryptNotes(key, 'id-1', col), 'secret detail');
  await assert.rejects(V.decryptText(key, 'id-1', col)); // not interchangeable with the text
});

test('work orders are sealed with the entry', async () => {
  const key = await V.importMasterKey(V.newMasterKey());
  const entry = { ts: 5, text: 'dev x', wo: '4471', wl: true };
  const stored = await V.sealEntry(key, 'id-1', entry);
  assert.ok(!stored.includes('4471'));
  assert.deepEqual(await V.openEntry(key, 'id-1', stored), entry);
  const col = await V.encryptField(key, 'id-1', 'wo', '4471');
  assert.equal(await V.decryptField(key, 'id-1', 'wo', col), '4471');
  await assert.rejects(V.decryptNotes(key, 'id-1', col));
});
