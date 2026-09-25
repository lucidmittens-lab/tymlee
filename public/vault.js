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

  // Stored entry text that starts with one of these is ciphertext. Typed
  // entries can never start with "/" (that is a command), so plain text can't
  // clash. /e1/ holds just the text; /e2/ ("sealed") holds the time and text
  // together, so the server doesn't see when entries start either.
  const PREFIX = '/e1/';
  const SEALED = '/e2/';
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

  function isSealed(text) {
    return typeof text === 'string' && text.startsWith(SEALED);
  }

  // The entry id is bound in as additional data, so ciphertext can't be
  // moved from one entry to another without detection.
  async function encryptWith(prefix, key, id, plain) {
    const iv = randomBytes(12);
    const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(id) }, key, enc.encode(plain));
    const out = new Uint8Array(12 + data.byteLength);
    out.set(iv);
    out.set(new Uint8Array(data), 12);
    return prefix + toBase64(out);
  }

  async function decryptWith(prefix, key, id, stored) {
    const bytes = fromBase64(stored.slice(prefix.length));
    const data = await subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(id) },
      key,
      bytes.slice(12),
    );
    return dec.decode(data);
  }

  // A short public fingerprint of the master key, stored next to its locked
  // copies. Devices compare it with their own key to notice when the account
  // started over with a new key (/reset-encryption). One-way: it reveals
  // nothing about the key.
  async function keyId(rawBase64) {
    const digest = await subtle.digest('SHA-256', enc.encode(`tymlee key id:${rawBase64}`));
    return toBase64(new Uint8Array(digest)).slice(0, 22);
  }

  const encryptText = (key, id, text) => encryptWith(PREFIX, key, id, text);
  const decryptText = (key, id, stored) => decryptWith(PREFIX, key, id, stored);

  // Seal an entry's start time, text, notes and work order together.
  function sealEntry(key, id, entry) {
    const payload = { t: entry.ts, x: entry.text };
    if (entry.notes) payload.n = entry.notes;
    if (entry.wo) {
      payload.w = entry.wo;
      if (entry.wl) payload.l = 1;
    }
    return encryptWith(SEALED, key, id, JSON.stringify(payload));
  }

  // { ts, text } plus notes / wo / wl when the entry has them.
  async function openEntry(key, id, stored) {
    const { t, x, n, w, l } = JSON.parse(await decryptWith(SEALED, key, id, stored));
    if (typeof t !== 'number' || typeof x !== 'string') throw new Error('bad sealed entry');
    const entry = { ts: t, text: x };
    if (typeof n === 'string' && n) entry.notes = n;
    if (typeof w === 'string' && w) {
      entry.wo = w;
      if (l) entry.wl = true;
    }
    return entry;
  }

  // Fields kept in their own column (servers without sealed entries) are
  // encrypted like text, bound to the entry id plus "#<field>".
  const encryptField = (key, id, field, value) => encryptWith(PREFIX, key, `${id}#${field}`, value);
  const decryptField = (key, id, field, stored) => decryptWith(PREFIX, key, `${id}#${field}`, stored);
  const encryptNotes = (key, id, notes) => encryptField(key, id, 'notes', notes);
  const decryptNotes = (key, id, stored) => decryptField(key, id, 'notes', stored);

  const api = {
    PREFIX, newRecoveryCode, newLinkCode, normalizeCode, looksLikeCode,
    newMasterKey, importMasterKey, wrap, unwrap, keyId, isEncrypted, encryptText, decryptText,
    isSealed, sealEntry, openEntry, encryptNotes, decryptNotes, encryptField, decryptField,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TymleeVault = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
