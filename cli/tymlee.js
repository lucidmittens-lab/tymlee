#!/usr/bin/env node
// tymlee in the terminal: the same shell as the website (public/commands.js),
// with the same account, sync and encryption.
//
//   tymlee                 open the tymlee shell
//   tymlee <entry or /command>   run one line and exit, e.g. tymlee /log week
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const { T, V, WEB, configDir, ensureDir, loadConfig, fileStorage, nodeEnv } = require('./env.js');
const { createStore } = require(path.join(WEB, 'store.js'));
const { createShell } = require(path.join(WEB, 'commands.js'));

const stdin = process.stdin;
const stdout = process.stdout;
const args = process.argv.slice(2);
const oneShot = args.length > 0;
const tty = Boolean(stdin.isTTY && stdout.isTTY);
const color = Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

if (args[0] === '--help' || args[0] === '-h') {
  stdout.write([
    'usage: tymlee                     open the tymlee shell',
    '       tymlee <entry or /command>  run one line and exit, e.g. tymlee /log week',
    '',
    `data: ${configDir()}`,
    '',
  ].join('\n'));
  process.exit(0);
}
if (args[0] === '--version' || args[0] === '-v') {
  stdout.write(`${require('./package.json').version}\n`);
  process.exit(0);
}

// ---- output ----------------------------------------------------------------

const sgr = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

function style(text, cls) {
  const classes = String(cls || '').split(/\s+/);
  const lines = String(text).split('\n');
  if (classes.includes('key')) return lines.map((l) => `${sgr('32', '│')} ${sgr('1', l)}`).join('\n');
  if (classes.includes('err')) return lines.map((l) => sgr('31', l)).join('\n');
  if (classes.includes('ok')) return lines.map((l) => sgr('32', l)).join('\n');
  if (classes.includes('dim')) return lines.map((l) => sgr('90', l)).join('\n');
  return lines.join('\n');
}

let rl = null;
let promptShown = false;
let quiet = oneShot; // one-shot mode: keep start-up notices out of the output

function print(text, cls) {
  const out = `${style(text, cls)}\n`;
  if (rl && promptShown && tty) {
    // Print above the prompt without disturbing what is being typed.
    readline.clearLine(stdout, 0);
    readline.cursorTo(stdout, 0);
    stdout.write(out);
    rl.prompt(true);
  } else {
    stdout.write(out);
  }
}

// ---- status line -------------------------------------------------------------
// A live status line on the terminal's bottom row, like the website's status
// bar. The rows above it scroll as usual (an ANSI scroll region).

let statusOn = false;
let rows = 0;

// The rows that scroll: below the pinned timeline (if any), above the status line.
function setRegion() {
  stdout.write(`\x1b7\x1b[${pane ? pane.height + 1 : 1};${rows - 1}r\x1b8`);
}

function visibleLength(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function statusText() {
  const st = shell.status(Date.now());
  const cols = stdout.columns || 80;
  let left;
  let middle = '';
  if (st.state === 'idle') left = st.text;
  else if (st.state === 'off') { left = `${sgr('90', '■ off')}  since ${st.since}`; middle = st.today; }
  else { left = `${sgr('32', `▶ ${st.clock}`)}  ${st.what}`; middle = cols >= 70 ? `${st.today} · since ${st.since}` : st.today; }
  const syncColor = { synced: '32', error: '31', offline: '31', locked: '31' }[st.sync.status] || '90';
  const right = sgr(syncColor, st.sync.label);
  const tail = `${middle ? `${sgr('90', middle)}   ` : ''}${right}`;
  const room = cols - visibleLength(tail) - 2;
  if (visibleLength(left) > room) {
    // Shorten the entry text so the totals and sync state stay visible.
    const plain = left.replace(/\x1b\[[0-9;]*m/g, '');
    left = plain.slice(0, Math.max(0, room - 1)) + '…';
  }
  const gap = Math.max(1, cols - visibleLength(left) - visibleLength(tail));
  return `${left}${' '.repeat(gap)}${tail}`;
}

function drawStatus() {
  if (!statusOn) return;
  stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K${color ? '\x1b[7m' : ''}${statusText()}${color ? '\x1b[0m' : ''}\x1b8`);
}

// Ask the terminal where the cursor is (row), or null if it doesn't answer.
// Only used at start-up, before the prompt takes over the keyboard.
function cursorRow() {
  return new Promise((resolve) => {
    let buf = '';
    const wasRaw = stdin.isRaw;
    const finish = (row) => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(row);
    };
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/\x1b\[(\d+);(\d+)R/);
      if (m) finish(Number(m[1]));
    };
    const timer = setTimeout(() => finish(null), 300);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdout.write('\x1b[6n');
  });
}

async function statusStart() {
  if (!tty || process.env.TYMLEE_NO_STATUS || (stdout.rows || 0) < 6) return;
  rows = stdout.rows;
  const row = (await cursorRow()) || rows;
  if (row >= rows) stdout.write('\n\x1b[1A'); // make room for the status row
  setRegion();
  // Keep the prompt on the bottom row, like a shell with a full screen:
  // move what is on screen down to meet it.
  const gap = rows - 1 - Math.min(row, rows - 1);
  if (gap > 0) stdout.write(`\x1b[${gap}T\x1b[${rows - 1};1H`);
  statusOn = true;
  drawStatus();
}

// Put the status line back after something else used the whole screen
// (your editor). Editors restore the cursor, so there is no need to ask.
function statusRestore() {
  if (!tty || process.env.TYMLEE_NO_STATUS || (stdout.rows || 0) < 6) return;
  rows = stdout.rows;
  setRegion();
  statusOn = true;
  drawPane(true);
  drawStatus();
}

function statusStop() {
  if (!statusOn) return;
  statusOn = false;
  stdout.write(`\x1b7\x1b[r\x1b[${rows};1H\x1b[2K\x1b8`);
}

function statusResize() {
  if (!statusOn) return;
  stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K\x1b8`);
  rows = stdout.rows;
  if (pane) return pinTimeline(pane.args, { quiet: true }); // re-fit the pane
  setRegion();
  drawStatus();
}

// ---- terminal helpers for the shell ---------------------------------------------

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}-${i}${ext}`);
  return candidate;
}

function copyToClipboard(text) {
  const tools = {
    darwin: [['pbcopy', []]],
    win32: [['clip', []]],
  }[process.platform] || [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, cmdArgs] of tools) {
    const r = spawnSync(cmd, cmdArgs, { input: text });
    if (!r.error && r.status === 0) return;
  }
  throw new Error(process.platform === 'linux' ? 'no clipboard tool found (install wl-clipboard or xclip)' : 'could not copy');
}

function editorCommand() {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
}

// Open text in your editor; resolves with the saved text (null if it failed).
function editText(text) {
  const file = path.join(os.tmpdir(), `tymlee-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  const wasOn = statusOn;
  statusStop();
  if (rl) rl.pause();
  if (tty) stdin.setRawMode(false);
  const r = spawnSync(`${editorCommand()} "${file}"`, { stdio: 'inherit', shell: true });
  let edited = null;
  try {
    if (!r.error && r.status === 0) edited = fs.readFileSync(file, 'utf8');
    else print(`could not run your editor (${editorCommand()}); set $EDITOR`, 'err');
  } finally {
    fs.rmSync(file, { force: true }); // it held your entries in plain text
  }
  if (tty && rl) stdin.setRawMode(true);
  if (rl) rl.resume();
  if (wasOn) statusRestore();
  return Promise.resolve(edited);
}

function confirm(question) {
  if (!rl) return Promise.resolve(false);
  return new Promise((resolve) => {
    rl.question(`${question} [Y/n] `, (answer) => resolve(!/^n/i.test(answer.trim())));
  });
}

function readBackupFile(fileArgs) {
  let file = fileArgs.join(' ');
  if (file.startsWith('~')) file = path.join(os.homedir(), file.slice(1));
  try {
    const stat = fs.statSync(file);
    if (stat.size > 5 * 1024 * 1024) {
      print(`${file} is too large to be a tymlee backup`, 'err');
      return Promise.resolve(null);
    }
    return Promise.resolve(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    print(`could not read ${file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`, 'err');
    return Promise.resolve(null);
  }
}

// ---- /note: choosing an entry, then typing its notes ---------------------------
// Both take over the prompt line until Enter (Esc cancels).

const PROMPT = tty ? sgr('32', '> ') : '';
let modal = null; // { kind: 'pick', name, choices, idx, resolve } or { kind: 'ask', multiline, resolve }

// Line breaks in notes are shown as ↵ on the one-line prompt.
const BREAK = '↵';

function pickPrompt() {
  const { choices, idx } = modal;
  return `${sgr('32', `${modal.name} ›`)} ${choices[idx].label} ${sgr('90', `(${idx + 1}/${choices.length})`)} `;
}

function pickEntry(choices, name) {
  if (!rl || !tty) {
    print('choosing an entry needs the tymlee shell; use /note <#> [notes]', 'err');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    modal = { kind: 'pick', name: name || 'pick', choices, idx: 0, resolve };
    print('Tab: older · Shift+Tab: newer · Enter: select · Esc: cancel', 'dim');
    rl.setPrompt(pickPrompt());
    promptShown = true;
    rl.prompt();
  });
}

function ask(label, initial, name) {
  if (!rl || !tty) {
    print('typing notes needs the tymlee shell; use /note <#> <notes>', 'err');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const multiline = name === 'notes';
    modal = { kind: 'ask', multiline, resolve };
    print(`${label} · ${multiline ? 'Option/Alt+Enter: new line · ' : ''}Enter: save · Esc: cancel`, 'dim');
    rl.setPrompt(sgr('32', `${name || 'answer'} › `));
    promptShown = true;
    rl.prompt();
    if (initial) rl.write(initial.split('\n').join(BREAK));
  });
}

function endModal(value) {
  const m = modal;
  modal = null;
  promptShown = false;
  rl.setPrompt(PROMPT);
  m.resolve(value);
}

function clearInput() {
  rl.write(null, { ctrl: true, name: 'e' });
  rl.write(null, { ctrl: true, name: 'u' });
}

// Keys while /note has the prompt line. Runs after readline's own handling.
function modalKey(key) {
  if (!modal || !key) return;
  if (key.name === 'escape') {
    clearInput();
    stdout.write('\n');
    endModal(null);
    return;
  }
  if (modal.kind === 'ask') {
    // Option/Alt+Enter (and Shift+Enter, where the terminal reports it):
    // readline ignores these, so add the line break here.
    if (modal.multiline && key.name === 'return' && (key.meta || key.shift)) rl.write(BREAK);
    return;
  }
  if (modal.kind !== 'pick') return;
  const older = (key.name === 'tab' && !key.shift) || key.name === 'up';
  const newer = (key.name === 'tab' && key.shift) || key.name === 'down';
  if (older || newer) modal.idx = Math.min(modal.choices.length - 1, Math.max(0, modal.idx + (older ? 1 : -1)));
  if (key.name !== 'return' && key.name !== 'enter') {
    if (rl.line) clearInput(); // choosing, not typing
    rl.setPrompt(pickPrompt());
    rl.prompt(true);
  }
}

// ---- /timeline colors ----------------------------------------------------------
// The same categorical palette as the website (dark-mode steps), in 24-bit
// color where the terminal supports it and the nearest 256-color otherwise.

const TIMELINE_HEX = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '');

function ansiColor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (truecolor) return `38;2;${r};${g};${b}`;
  const q = (v) => Math.round((v / 255) * 5);
  return `38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}`;
}

function paint(slot, text) {
  if (!color) return text;
  if (slot == null) return sgr('90', text); // off time
  return sgr(slot < 0 ? '37' : ansiColor(TIMELINE_HEX[slot]), text);
}

// Clear the screen, leaving the prompt on the bottom row.
function clearScreen() {
  stdout.write('\x1b[2J');
  if (statusOn) {
    setRegion();
    stdout.write(`\x1b[${rows - 1};1H`);
    drawPane(true);
    drawStatus();
  } else {
    stdout.write(`\x1b[${stdout.rows || 1};1H`);
  }
}

// ---- /timeline-p: a pinned, live timeline ------------------------------------------
// The timeline drawn in the top rows of the terminal, above the rows that
// scroll, and redrawn as entries change (and as the clock moves).
// /timeline-h hides it again. Terminal only.

let pane = null; // { args, max, height, last }

function fitLine(line, cols) {
  // Cut a painted line to `cols` visible characters, keeping its colors.
  let seen = 0;
  let outText = '';
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { outText += part; continue; }
    const room = cols - seen;
    if (room <= 0) continue;
    outText += part.length > room ? `${part.slice(0, room - 1)}…` : part;
    seen += Math.min(part.length, room);
  }
  return `${outText}${color && line.includes('\x1b[') ? '\x1b[0m' : ''}`;
}

function paneLines() {
  const now = Date.now();
  const cols = stdout.columns || 80;
  const range = T.parseRange(pane.args.join(''), now);
  const body = T.formatTimeline(store.entries, range, now, { paint, width: cols }).split('\n');
  const room = pane.max - 1; // the last row is the divider
  // The legend stays on top; long days show their latest blocks.
  const shown = body.length <= room ? body : [body[0], ...body.slice(body.length - (room - 1))];
  const label = ` timeline · ${range.label} · /timeline-h hides `;
  const divider = `${'─'.repeat(2)}${label}${'─'.repeat(Math.max(0, cols - 2 - label.length))}`;
  return [...shown.map((l) => fitLine(l, cols)), sgr('90', divider.slice(0, cols))];
}

// The pane is as tall as the timeline, up to about half the screen. The
// prompt stays on the bottom row, so growing only covers old output.
function drawPane(force) {
  if (!pane || !statusOn) return;
  const lines = paneLines();
  const key = lines.join('\n');
  if (!force && key === pane.last) return;
  pane.last = key;
  let seq = '\x1b7';
  for (let i = lines.length + 1; i <= pane.height; i++) seq += `\x1b[${i};1H\x1b[2K`; // it shrank
  lines.forEach((l, i) => { seq += `\x1b[${i + 1};1H\x1b[2K${l}`; });
  stdout.write(`${seq}\x1b8`);
  if (lines.length !== pane.height) {
    pane.height = lines.length;
    setRegion();
  }
}

function pinTimeline(rangeArgs, { quiet: silent } = {}) {
  if (!statusOn) {
    print('/timeline-p needs an interactive terminal at least 16 rows tall', 'err');
    return;
  }
  if (!T.parseRange(rangeArgs.join(''), Date.now())) {
    print(`unknown range "${rangeArgs.join('')}"; try today, yesterday, week, month, all, 3d or 2026-01-31`, 'err');
    return;
  }
  const max = Math.min(30, Math.floor((rows - 1) * 0.55));
  if (max < 6 || rows - 1 - max < 6) {
    pane = null;
    setRegion();
    print('the terminal is too short to pin the timeline (it needs about 16 rows)', 'err');
    return;
  }
  pane = { args: rangeArgs, max, height: 0, last: null };
  // Start from a clean screen: the timeline on top, the prompt at the bottom.
  clearScreen();
  if (!silent) print('timeline pinned; it updates as you go (/timeline-h hides it)', 'dim');
  else if (rl && promptShown) rl.prompt(true);
}

function hideTimeline() {
  if (!pane) return print('the timeline is not pinned; /timeline-p pins it', 'err');
  const height = pane.height;
  pane = null;
  let seq = '\x1b7';
  for (let i = 1; i <= height; i++) seq += `\x1b[${i};1H\x1b[2K`;
  stdout.write(`${seq}\x1b8`);
  setRegion();
  print('timeline hidden', 'ok');
}


// ---- set up ----------------------------------------------------------------------

const dir = configDir();
ensureDir(dir);
const config = loadConfig(dir);
let store = null;
const storage = fileStorage(path.join(dir, 'data.json'), () => {
  if (store) store.reloadFromStorage(); // another tymlee changed the log
});

store = createStore({
  env: nodeEnv({ config, storage }),
  onChange: () => { drawPane(); drawStatus(); },
  onNotice: (text, cls) => { if (!quiet) print(text, cls); },
});

const shell = createShell({
  store,
  T,
  V,
  io: {
    print,
    storage,
    place: 'this computer',
    compact: () => (stdout.columns || 80) < 70,
    async save(name, body) {
      const file = uniquePath(process.cwd(), name);
      fs.writeFileSync(file, body);
      return path.relative(process.cwd(), file) || file;
    },
    async copy(text) { copyToClipboard(text); },
    clear: clearScreen,
    pickFile: readBackupFile,
    restoreUsage: '/restore [file]',
    keys: [
      'Keys:   Tab           complete a category or command',
      '        Up / Down     previous inputs',
      '        Ctrl+L        clear the screen',
      '        Ctrl+D        quit (or /exit)',
    ],
    linkSignIn: false,
    paint,
    width: () => stdout.columns || 80,
    pickEntry,
    ask,
    editor: { edit: editText, confirm },
    extra: {
      'timeline-p': {
        usage: '/timeline-p [range]',
        about: 'pin a live timeline to the top of the terminal (today by default)',
        run(rangeArgs) { pinTimeline(rangeArgs); },
      },
      'timeline-h': {
        usage: '/timeline-h',
        about: 'hide the pinned timeline',
        run() { hideTimeline(); },
      },
      exit: {
        usage: '/exit',
        about: 'leave tymlee (Ctrl+D)',
        run() { if (rl) rl.close(); },
      },
    },
  },
});

// ---- history --------------------------------------------------------------------

const HISTORY_FILE = path.join(dir, 'history');
const HISTORY_SIZE = 500;

function loadHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_SIZE).reverse();
  } catch (_) {
    return shell.recentTexts(100).reverse();
  }
}

function saveHistory(list) {
  try {
    fs.writeFileSync(HISTORY_FILE, `${list.slice(0, HISTORY_SIZE).reverse().join('\n')}\n`, { mode: 0o600 });
  } catch (_) { /* history is a convenience */ }
}

// ---- run ----------------------------------------------------------------------------

function cleanup() {
  statusStop();
}
process.on('exit', cleanup);
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

async function runOnce() {
  try {
    await store.init();
  } catch (err) {
    print(`startup error: ${err.message || err}`, 'err');
  }
  quiet = false;
  await shell.run(shell.route(args.join(' ')));
  await store.whenIdle(); // send the change before exiting
  if (store.pending && store.user) print(`${store.pending} change(s) not synced yet; they'll be sent next time`, 'dim');
  process.exit(0);
}

async function interactive() {
  print('tymlee · type what you are starting and press Enter · /help for commands', 'dim');
  await statusStart();
  try {
    await store.init();
  } catch (err) {
    print(`startup error: ${err.message || err}`, 'err');
  }
  if (store.entries.length) {
    const now = Date.now();
    print(T.formatReport(store.entries, T.parseRange('today', now), now, { compact: (stdout.columns || 80) < 70 }), 'report');
  }
  drawStatus();
  const clock = setInterval(() => { drawPane(); drawStatus(); }, 1000);
  clock.unref();

  rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: PROMPT,
    history: loadHistory(),
    historySize: HISTORY_SIZE,
    removeHistoryDuplicates: true,
    completer(line) {
      if (modal || /\s/.test(line)) return [[], line];
      const hits = shell.completions(line, { includeExact: true, limit: 50 });
      return [hits.map((h) => `${h} `), line];
    },
  });
  rl.on('history', saveHistory);
  stdout.on('resize', statusResize);
  // Redrawing the prompt line can clear the rows below it, status line
  // included, so draw it again right after each key.
  let redraw = false;
  stdin.on('keypress', (_, key) => {
    modalKey(key);
    if (key && key.ctrl && key.name === 'l') {
      // readline cleared the screen from the top; keep the prompt at the bottom.
      setImmediate(() => { clearScreen(); rl.prompt(true); });
      return;
    }
    if (redraw) return;
    redraw = true;
    setImmediate(() => { redraw = false; drawStatus(); });
  });

  let lastInterrupt = 0;
  rl.on('SIGINT', () => {
    if (modal) return modalKey({ name: 'escape' });
    if (rl.line) {
      rl.write(null, { ctrl: true, name: 'u' }); // clear the line
      return;
    }
    if (Date.now() - lastInterrupt < 2000) return rl.close();
    lastInterrupt = Date.now();
    print('(press Ctrl+C again, Ctrl+D or type /exit to quit)', 'dim');
  });

  // Lines run one at a time, in order, even if typed while one is running.
  let queue = Promise.resolve();
  rl.on('line', (raw) => {
    if (modal) {
      // The choice or notes, not a command; keep it out of the history.
      if (rl.history[0] === raw) rl.history.shift();
      const m = modal;
      endModal(m.kind === 'pick' ? m.choices[m.idx] : raw.split(BREAK).join('\n'));
      return;
    }
    promptShown = false;
    const line = shell.route(raw);
    queue = queue.then(async () => {
      await shell.run(line);
      drawStatus();
      if (!rl.closed) {
        promptShown = true;
        rl.prompt();
      }
    });
  });

  rl.on('close', async () => {
    promptShown = false;
    clearInterval(clock);
    await queue;
    await store.whenIdle();
    if (store.pending && store.user) print(`${store.pending} change(s) not synced yet; they'll be sent next time`, 'dim');
    process.exit(0);
  });

  promptShown = true;
  rl.prompt();
}

(oneShot ? runOnce() : interactive()).catch((err) => {
  statusStop();
  stdout.write(`${err.stack || err}\n`);
  process.exit(1);
});
