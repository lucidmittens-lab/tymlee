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
