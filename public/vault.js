// End-to-end encryption helpers (Web Crypto). No DOM access, so it can be
// unit tested in Node.
//
// Each account has one random master key. Entry text is encrypted with it in
// the browser before upload, so the server (and whoever runs it) only ever
// stores ciphertext. The master key itself is stored on the server only in
// "wrapped" (encrypted) copies: one locked with the account's recovery key,
// and briefly one locked with a /link code while adding a device. Codes are
// shown on screen and never sent anywhere.
(function (root) {
  'use strict';

  const subtle = root.crypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Stored entry text that starts with this is ciphertext. Typed entries can
  // never start with "/" (that is a command), so plain text can't clash.
  const PREFIX = '/e1/';
  const ITERATIONS = 300000;

  // Crockford base32: no I, L, O or U, so codes are easy to read and type.
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  function randomBytes(n) {
    return root.crypto.getRandomValues(new Uint8Array(n));
  }

  function toBase64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function fromBase64(text) {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // A random code of `length` characters (5 bits each), in groups.
  function newCode(length, group) {
    const bytes = randomBytes(length);
    let code = '';
    for (let i = 0; i < length; i++) {
      if (i && i % group === 0) code += '-';
      code += ALPHABET[bytes[i] & 31];
    }
    return code;
  }

  const newRecoveryCode = () => newCode(20, 5); // 100 bits: XXXXX-XXXXX-XXXXX-XXXXX
  const newLinkCode = () => newCode(12, 4); //     60 bits: XXXX-XXXX-XXXX

  // Forgiving about case, spaces, dashes and look-alike characters.
  function normalizeCode(text) {
    return String(text)
      .toUpperCase()
      .replace(/[\s-]/g, '')
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1');
  }

  function looksLikeCode(text, length) {
    const c = normalizeCode(text);
    return c.length === length && [...c].every((ch) => ALPHABET.includes(ch));
  }

  async function keyFromCode(code, salt, iterations) {
    const base = await subtle.importKey('raw', enc.encode(normalizeCode(code)), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  function newMasterKey() {
    return toBase64(randomBytes(32));
  }

  function importMasterKey(rawBase64) {
    return subtle.importKey('raw', fromBase64(rawBase64), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  // Lock the master key with a code: { v, salt, iv, data, n }.
  async function wrap(rawBase64, code, iterations) {
    const n = iterations || ITERATIONS;
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await keyFromCode(code, salt, n);
    const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, fromBase64(rawBase64)));
    return { v: 1, n, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) };
  }

  // Throws if the code is wrong (AES-GCM authentication fails).
  async function unwrap(blob, code) {
    const key = await keyFromCode(code, fromBase64(blob.salt), blob.n || ITERATIONS);
    const raw = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(blob.iv) }, key, fromBase64(blob.data));
    return toBase64(new Uint8Array(raw));
  }

  function isEncrypted(text) {
    return typeof text === 'string' && text.startsWith(PREFIX);
  }

  // The entry id is bound in as additional data, so ciphertext can't be
  // moved from one entry to another without detection.
  async function encryptText(key, id, text) {
    const iv = randomBytes(12);
    const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(id) }, key, enc.encode(text));
    const out = new Uint8Array(12 + data.byteLength);
    out.set(iv);
    out.set(new Uint8Array(data), 12);
    return PREFIX + toBase64(out);
  }

  async function decryptText(key, id, stored) {
    const bytes = fromBase64(stored.slice(PREFIX.length));
    const data = await subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(id) },
      key,
      bytes.slice(12),
    );
    return dec.decode(data);
  }

  const api = {
    PREFIX, newRecoveryCode, newLinkCode, normalizeCode, looksLikeCode,
    newMasterKey, importMasterKey, wrap, unwrap, isEncrypted, encryptText, decryptText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TymleeVault = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
