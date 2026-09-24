// The terminal app's environment for the shared store (public/store.js):
// storage in a file under the config folder, the Supabase client from npm,
// and no browser events.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'public');
const T = require(path.join(WEB, 'core.js'));
const V = require(path.join(WEB, 'vault.js'));

// ~/.config/tymlee (or $XDG_CONFIG_HOME/tymlee, %APPDATA%\tymlee on Windows,
// or $TYMLEE_HOME). Holds the local log, the sign-in session and this
// computer's copy of the encryption key, so it is private to your user.
function configDir() {
  if (process.env.TYMLEE_HOME) return process.env.TYMLEE_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'tymlee');
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tymlee');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* not supported on this system */ }
}

// Supabase settings: the website's public/config.js, unless overridden by
// config.json in the config folder or TYMLEE_SUPABASE_URL / _KEY.
function loadConfig(dir) {
  let config = {};
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(WEB, 'config.js'), 'utf8'), sandbox);
    config = { ...sandbox.window.TYMLEE_CONFIG };
  } catch (_) { /* no website config */ }
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')));
  } catch (_) { /* no override file */ }
  if (process.env.TYMLEE_SUPABASE_URL) config.supabaseUrl = process.env.TYMLEE_SUPABASE_URL;
  if (process.env.TYMLEE_SUPABASE_KEY) config.supabaseAnonKey = process.env.TYMLEE_SUPABASE_KEY;
  return config;
}

// A localStorage-like store kept in one JSON file, written atomically and
// readable only by you. `onExternalChange` runs when another tymlee process
// changes the file.
function fileStorage(file, onExternalChange) {
  let data = {};
  let lastWritten = null;

  function load() {
    try {
      const text = fs.readFileSync(file, 'utf8');
      data = JSON.parse(text);
      return text;
    } catch (_) {
      data = {};
      return null;
    }
  }

  function save() {
    const text = JSON.stringify(data);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    lastWritten = text;
  }

  lastWritten = load();
  fs.watchFile(file, { interval: 1000, persistent: false }, () => {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
    if (text === lastWritten) return;
    lastWritten = text;
    try { data = JSON.parse(text); } catch (_) { return; }
    if (onExternalChange) onExternalChange();
  });

  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem(k, v) { data[k] = String(v); save(); },
    removeItem(k) { if (k in data) { delete data[k]; save(); } },
  };
}

function loadClientFactory() {
  // For tests: a module exporting createClient() to use instead of Supabase.
  if (process.env.TYMLEE_CLIENT_MODULE) return require(path.resolve(process.env.TYMLEE_CLIENT_MODULE)).createClient;
  return require('@supabase/supabase-js').createClient;
}

function nodeEnv({ config, storage }) {
  return {
    T,
    V,
    config,
    place: 'this computer',
    storage,
    async createClient(url, key, auth) {
      const createClient = loadClientFactory();
      return createClient(url, key, { auth: { ...auth, storage, detectSessionInUrl: false } });
    },
    isOnline: () => true,
    watch(on, ms) {
      const timer = setInterval(on.tick, ms);
      if (timer.unref) timer.unref();
    },
    redirectUrl: () => config.siteUrl || 'https://tymlee.date/',
  };
}

module.exports = { T, V, WEB, configDir, ensureDir, loadConfig, fileStorage, nodeEnv };
