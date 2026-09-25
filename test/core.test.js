// Run with TZ=UTC (see package.json) so local-time formatting is deterministic.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/core.js');

test('category is the text before the first space', () => {
  assert.deepEqual(T.parseInput('dev fixing the login bug'), { category: 'dev', note: 'fixing the login bug' });
  assert.deepEqual(T.parseInput('  lunch  '), { category: 'lunch', note: '' });
  assert.deepEqual(T.parseInput('mtg   standup  call'), { category: 'mtg', note: 'standup call' });
});

test('known categories are unique, case-insensitive, most recent first', () => {
  const entries = [
    { ts: 1, text: 'dev a' },
    { ts: 2, text: 'email' },
    { ts: 3, text: 'Dev b' },
  ];
  assert.deepEqual(T.knownCategories(entries), ['Dev', 'email']);
});

test('suggest completes the first word only', () => {
  const cats = ['design', 'dev', 'email'];
  assert.deepEqual(T.suggest('de', cats), ['design', 'dev']);
  assert.deepEqual(T.suggest('DE', cats), ['design', 'dev']);
  assert.deepEqual(T.suggest('dev', cats), []);
  assert.deepEqual(T.suggest('dev', cats, { includeExact: true }), ['dev']);
  assert.deepEqual(T.suggest('dev ', cats), []);
  assert.deepEqual(T.suggest('', cats), cats);
});

test('each entry runs until the next one starts', () => {
  const spans = T.withSpans([{ ts: 0, text: 'a' }, { ts: 100, text: 'b x' }], 250);
  assert.equal(spans[0].duration, 100);
  assert.equal(spans[0].running, false);
  assert.equal(spans[1].duration, 150);
  assert.equal(spans[1].running, true);
  assert.equal(spans[1].note, 'x');
  assert.equal(spans[1].n, 2);
});

test('summarize groups by category, largest first', () => {
  const spans = T.withSpans([
    { ts: 0, text: 'dev a' },
    { ts: 100, text: 'lunch' },
    { ts: 200, text: 'DEV b' },
  ], 400);
  assert.deepEqual(T.summarize(spans), [
    { category: 'DEV', ms: 300 },
    { category: 'lunch', ms: 100 },
  ]);
});

test('duration formats', () => {
  assert.equal(T.formatHM(45 * 60000), '0:45');
  assert.equal(T.formatHM((26 * 60 + 5) * 60000 + 59000), '26:05');
  assert.equal(T.formatClock(3723000), '1:02:03');
});

const at = (s) => new Date(s).getTime();
const NOW = at('2026-09-24T10:12:00Z');

test('parseRange', () => {
  const today = T.parseRange('', NOW);
  assert.equal(today.from, at('2026-09-24T00:00:00Z'));
  assert.equal(today.to, at('2026-09-25T00:00:00Z'));
  assert.equal(T.parseRange('yesterday', NOW).from, at('2026-09-23T00:00:00Z'));
  assert.equal(T.parseRange('week', NOW).from, at('2026-09-18T00:00:00Z'));
  assert.equal(T.parseRange('3d', NOW).from, at('2026-09-22T00:00:00Z'));
  assert.equal(T.parseRange('2026-01-31', NOW).to, at('2026-02-01T00:00:00Z'));
  const span = T.parseRange('2026-09-01..2026-09-03', NOW);
  assert.equal(span.from, at('2026-09-01T00:00:00Z'));
  assert.equal(span.to, at('2026-09-04T00:00:00Z'));
  assert.equal(T.parseRange('all', NOW).from, -Infinity);
  assert.equal(T.parseRange('2026-02-30', NOW), null);
  assert.equal(T.parseRange('soon', NOW), null);
});

const LOG = [
  { ts: at('2026-09-23T16:00:00Z'), text: 'dev wrap up' },
  { ts: at('2026-09-23T17:30:00Z'), text: 'off' },
  { ts: at('2026-09-24T09:00:00Z'), text: 'dev fixing login bug' },
  { ts: at('2026-09-24T09:45:00Z'), text: 'mtg standup' },
  { ts: at('2026-09-24T10:00:00Z'), text: 'dev code review' },
];

test('single-day report is fixed-width with a summary', () => {
  assert.equal(T.formatReport(LOG, T.parseRange('today', NOW), NOW), [
    'Thu 2026-09-24',
    '  #  start  end       dur  category  note',
    '  3  09:00  09:45    0:45  dev       fixing login bug',
    '  4  09:45  10:00    0:15  mtg       standup',
    '  5  10:00  now      0:12  dev       code review',
    '  ' + '-'.repeat(56),
    '  dev         0:57   79%',
    '  mtg         0:15   21%',
    '  total       1:12',
  ].join('\n'));
});

test('multi-day report adds an overall summary', () => {
  const report = T.formatReport(LOG, T.parseRange('week', NOW), NOW);
  assert.match(report, /^Wed 2026-09-23\n/);
  assert.match(report, /\nThu 2026-09-24\n/);
  assert.match(report, /\nweek: 2026-09-23 \.\. 2026-09-24, 2 days\n/);
  // "off" runs overnight until the first entry of the next day.
  assert.match(report, / {2}2 {2}17:30 {2}09:00 {3}15:30 {2}off\n/);
  assert.match(report, / {2}total {6}18:12$/);
});

test('empty range', () => {
  assert.equal(T.formatReport(LOG, T.parseRange('2026-01-01', NOW), NOW), 'no entries (2026-01-01)');
});

test('csv export quotes fields and leaves the running end blank', () => {
  const log = [...LOG, { ts: at('2026-09-24T10:05:00Z'), text: 'mtg sync, "roadmap"' }];
  const lines = T.toCSV(log, T.parseRange('today', NOW), NOW).trimEnd().split('\n');
  assert.equal(lines[0], 'n,wo,start,end,minutes,category,note,notes');
  assert.equal(lines[1], '3,,2026-09-24T09:00:00.000Z,2026-09-24T09:45:00.000Z,45.0,dev,fixing login bug,');
  assert.equal(lines[4], '6,,2026-09-24T10:05:00.000Z,,7.0,mtg,"sync, ""roadmap""",');
});

// ---- sync ------------------------------------------------------------------

const put = (id, ts, text) => ({ op: 'put', entry: { id, ts, text: text || id } });
const del = (id) => ({ op: 'del', id });

test('uuid looks like a v4 uuid and is unique', () => {
  const a = T.uuid();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, T.uuid());
});

test('applyOps puts, replaces and deletes, keeping ts order', () => {
  const remote = [{ id: 'a', ts: 1, text: 'a' }, { id: 'c', ts: 3, text: 'c' }];
  const out = T.applyOps(remote, [put('b', 2), del('a'), put('c', 3, 'c2')]);
  assert.deepEqual(out, [{ id: 'b', ts: 2, text: 'b' }, { id: 'c', ts: 3, text: 'c2' }]);
});

test('enqueue: deleting an unsent entry cancels both operations', () => {
  assert.deepEqual(T.enqueue([put('a', 1), put('b', 2)], del('a'), 0), [put('b', 2)]);
});

test('enqueue: deleting an entry that may be in flight still sends the delete', () => {
  assert.deepEqual(T.enqueue([put('a', 1)], del('a'), 1), [put('a', 1), del('a')]);
});

test('enqueue: a later put replaces an earlier unsent put', () => {
  assert.deepEqual(T.enqueue([put('a', 1, 'x')], put('a', 1, 'y'), 0), [put('a', 1, 'y')]);
});

test('enqueue: deleting a synced entry queues a delete', () => {
  assert.deepEqual(T.enqueue([], del('a'), 0), [del('a')]);
});

test('nextBatch takes a run of same-kind operations', () => {
  const q = [put('a', 1), put('b', 2), del('c'), put('d', 4)];
  assert.deepEqual(T.nextBatch(q), { kind: 'put', ops: q.slice(0, 2) });
  assert.deepEqual(T.nextBatch(q, 1), { kind: 'put', ops: q.slice(0, 1) });
  assert.deepEqual(T.nextBatch(q.slice(2)), { kind: 'del', ops: [del('c')] });
  assert.equal(T.nextBatch([]), null);
});

test('compact report drops the end column', () => {
  assert.equal(T.formatReport(LOG, T.parseRange('today', NOW), NOW, { compact: true }), [
    'Thu 2026-09-24',
    '  #  start     dur  category  note',
    '  3  09:00    0:45  dev       fixing login bug',
    '  4  09:45    0:15  mtg       standup',
    '  5  10:00    0:12  dev       code review',
    '  ' + '-'.repeat(36),
    '  dev         0:57   79%',
    '  mtg         0:15   21%',
    '  total       1:12',
  ].join('\n'));
});

// ---- editing ---------------------------------------------------------------

const EDIT_LOG = [
  { id: 'a', ts: at('2026-09-23T17:30:00Z'), text: 'off' },
  { id: 'b', ts: at('2026-09-24T09:00:05Z'), text: 'dev fixing login bug' },
  { id: 'c', ts: at('2026-09-24T09:45:00Z'), text: 'mtg standup' },
  { id: 'd', ts: at('2026-09-24T10:00:00Z'), text: 'dev code review' },
];
const last24h = { from: NOW - 86400000, to: Infinity, label: '24h' };

test('formatEditable lists entries under day headers', () => {
  const { text, items } = T.formatEditable(EDIT_LOG, last24h, NOW);
  assert.deepEqual(items.map((i) => i.n), [1, 2, 3, 4]);
  assert.equal(text.split('\n').filter((l) => !l.startsWith('#')).join('\n'), [
    'Wed 2026-09-23',
    '  1  17:30  off',
    'Thu 2026-09-24',
    '  2  09:00  dev fixing login bug',
    '  3  09:45  mtg standup',
    '  4  10:00  dev code review',
    '',
  ].join('\n'));
});

test('parseEditable: unchanged text produces no operations', () => {
  const { text, items } = T.formatEditable(EDIT_LOG, last24h, NOW);
  const r = T.parseEditable(text, items, NOW);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.ops, []);
});

test('parseEditable: edit text and time, delete, and add', () => {
  const { items } = T.formatEditable(EDIT_LOG, last24h, NOW);
  const edited = [
    'Wed 2026-09-23',
    '  1  17:30  off',
    'Thu 2026-09-24',
    '  2  09:00  dev   fixing the login bug',
    '  4  09:55  dev code review',
    '09:30 email inbox',
  ].join('\n');
  const r = T.parseEditable(edited, items, NOW);
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.changed, r.added, r.removed], [2, 1, 1]);
  // Unchanged time keeps its seconds; the text is normalized.
  assert.deepEqual(r.ops[0], { op: 'put', entry: { id: 'b', ts: at('2026-09-24T09:00:05Z'), text: 'dev fixing the login bug' } });
  assert.deepEqual(r.ops[1], { op: 'put', entry: { id: 'd', ts: at('2026-09-24T09:55:00Z'), text: 'dev code review' } });
  assert.equal(r.ops[2].op, 'put');
  assert.equal(r.ops[2].entry.ts, at('2026-09-24T09:30:00Z'));
  assert.equal(r.ops[2].entry.text, 'email inbox');
  assert.deepEqual(r.ops[3], { op: 'del', id: 'c' });
  // Applying the ops gives the expected log.
  assert.deepEqual(T.applyOps(EDIT_LOG, r.ops).map((e) => e.text), [
    'off', 'dev fixing the login bug', 'email inbox', 'dev code review',
  ]);
});

test('parseEditable: reports errors and makes no changes', () => {
  const { items } = T.formatEditable(EDIT_LOG, last24h, NOW);
  const r = T.parseEditable([
    'Thu 2026-09-24',
    '  2  09:00  dev a',
    '  2  09:10  dev b',
    '  9  09:20  dev c',
    '  3  25:00  mtg',
    '  4  10:30  dev later than now',
    'just some words',
    'Mon 2026-02-30',
  ].join('\n'), items, NOW);
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.errors.map((e) => e.split(':')[0]), ['line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
  assert.match(r.errors[0], /more than once/);
  assert.match(r.errors[1], /no entry #9/);
  assert.match(r.errors[2], /not a valid time/);
  assert.match(r.errors[3], /in the future/);
  assert.match(r.errors[4], /expected "HH:MM text"/);
  assert.match(r.errors[5], /not a real date/);
});

test('parseEditable: new lines before any header use today', () => {
  const r = T.parseEditable('08:15 gym', [], NOW);
  assert.equal(r.ops[0].entry.ts, at('2026-09-24T08:15:00Z'));
});

// ---- /off ------------------------------------------------------------------

const OFF_LOG = [
  { id: 'a', ts: at('2026-09-24T09:00:00Z'), text: 'dev fixing login bug' },
  { id: 'b', ts: at('2026-09-24T09:45:00Z'), text: T.OFF },
  { id: 'c', ts: at('2026-09-24T10:00:00Z'), text: 'mtg standup' },
  { id: 'd', ts: at('2026-09-24T10:05:00Z'), text: T.OFF },
];

test('off time is shown but not counted', () => {
  const spans = T.withSpans(OFF_LOG, NOW);
  assert.deepEqual(spans.map((s) => s.off), [false, true, false, true]);
  assert.deepEqual(T.summarize(spans), [
    { category: 'dev', ms: 45 * 60000 },
    { category: 'mtg', ms: 5 * 60000 },
  ]);
  assert.deepEqual(T.knownCategories(OFF_LOG), ['mtg', 'dev']);
  assert.equal(T.formatReport(OFF_LOG, T.parseRange('today', NOW), NOW), [
    'Thu 2026-09-24',
    '  #  start  end       dur  category  note',
    '  1  09:00  09:45    0:45  dev       fixing login bug',
    '  2  09:45  10:00       -  (off)',
    '  3  10:00  10:05    0:05  mtg       standup',
    '  4  10:05  now         -  (off)',
    '  ' + '-'.repeat(56),
    '  dev         0:45   90%',
    '  mtg         0:05   10%',
    '  total       0:50',
  ].join('\n'));
  const csv = T.toCSV(OFF_LOG, T.parseRange('today', NOW), NOW).trimEnd().split('\n');
  assert.equal(csv.length, 3);
});

test('/edit keeps /off lines and rejects other "/" text', () => {
  const { text, items } = T.formatEditable(OFF_LOG, { from: 0, to: Infinity, label: 'all' }, NOW);
  assert.match(text, /  2  09:45  \/off\n/);
  assert.deepEqual(T.parseEditable(text, items, NOW).ops, []);
  const added = T.parseEditable(text + '10:10 /off\n', items, NOW);
  assert.equal(added.added, 1);
  const bad = T.parseEditable(text + '10:10 /log\n', items, NOW);
  assert.match(bad.errors[0], /can't start with/);
});

// ---- restore ---------------------------------------------------------------

const BACKUP_LOG = [
  { id: 'a', ts: at('2026-09-23T16:00:00Z'), text: 'dev wrap up' },
  { id: 'b', ts: at('2026-09-23T17:30:00Z'), text: T.OFF },
  { id: 'c', ts: at('2026-09-24T09:00:00Z'), text: 'dev fixing login bug' },
  { id: 'd', ts: at('2026-09-24T09:45:00Z'), text: 'mtg standup' },
  { id: 'e', ts: at('2026-09-24T10:00:00Z'), text: 'dev code review' },
];
const strip = (list) => list.map(({ ts, text }) => ({ ts, text }));
const ALL = { from: -Infinity, to: Infinity, label: 'all' };

test('restore reads back the .txt export (full and compact)', () => {
  for (const compact of [false, true]) {
    const r = T.parseBackup(T.formatReport(BACKUP_LOG, ALL, NOW, { compact }));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.entries, strip(BACKUP_LOG));
  }
});

test('restore reads back the csv export, rebuilding off time', () => {
  const r = T.parseBackup(T.toCSV(BACKUP_LOG, ALL, NOW));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.entries, strip(BACKUP_LOG));
  // A trailing /off (entry that ended with nothing after it) is kept too.
  const ended = [...BACKUP_LOG, { id: 'f', ts: at('2026-09-24T10:10:00Z'), text: T.OFF }];
  assert.deepEqual(T.parseBackup(T.toCSV(ended, ALL, NOW)).entries, strip(ended));
});

test('restore reads the /edit format and pasted text with comments', () => {
  const { text } = T.formatEditable(BACKUP_LOG, ALL, NOW);
  assert.deepEqual(T.parseBackup(text).entries, strip(BACKUP_LOG));
  const r = T.parseBackup('# pasted\nThu 2026-09-24\n08:15 gym\n  09:00  dev x\n');
  assert.deepEqual(r.entries.map((e) => e.text), ['gym', 'dev x']);
});

test('restore reports unreadable lines', () => {
  const r = T.parseBackup('08:00 gym\nThu 2026-09-24\n25:00 late\nhello there\n10:00 /log\n');
  assert.deepEqual(r.errors.map((e) => e.split(':')[0]), ['line 1', 'line 3', 'line 4', 'line 5']);
  assert.match(r.errors[0], /no date above/);
  const csv = T.parseBackup('n,start,end,minutes,category,note\n1,not a date,,1.0,dev,x\n');
  assert.match(csv.errors[0], /csv row 2/);
});

test('mergeBackup skips entries already in the log', () => {
  const backup = T.parseBackup(T.formatReport(BACKUP_LOG, ALL, NOW)).entries;
  assert.equal(T.mergeBackup(BACKUP_LOG, backup).length, 0);
  const fresh = T.mergeBackup(BACKUP_LOG.slice(0, 2), backup);
  assert.deepEqual(strip(fresh), strip(BACKUP_LOG.slice(2)));
  assert.ok(fresh.every((e) => typeof e.id === 'string'));
});

// ---- partial sync ------------------------------------------------------------

test('mergeRecent replaces only the recent part of the log', () => {
  const local = [
    { id: 'old', ts: 10, text: 'old' },
    { id: 'gone', ts: 100, text: 'deleted on another device' },
    { id: 'kept', ts: 110, text: 'kept' },
  ];
  const recent = [
    { id: 'kept', ts: 110, text: 'kept, edited elsewhere' },
    { id: 'new', ts: 120, text: 'added elsewhere' },
    { id: 'old', ts: 130, text: 'old entry moved into the window' },
  ];
  assert.deepEqual(T.mergeRecent(local, recent, 100), [
    { id: 'kept', ts: 110, text: 'kept, edited elsewhere' },
    { id: 'new', ts: 120, text: 'added elsewhere' },
    { id: 'old', ts: 130, text: 'old entry moved into the window' },
  ]);
  // Entries before the window are left alone.
  assert.deepEqual(T.mergeRecent(local, [], 50), [{ id: 'old', ts: 10, text: 'old' }]);
});

test('restore finds the csv header after comments and blank lines', () => {
  const csv = '# pasted\n\n\n' + T.toCSV(BACKUP_LOG, ALL, NOW);
  const r = T.parseBackup(csv);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.entries, strip(BACKUP_LOG));
});

// ---- notes and /report -------------------------------------------------------

const NOTED = [
  { id: 'a', ts: at('2026-09-24T09:00:00Z'), text: 'dev fixing login bug', notes: 'root cause: expired token\nfix in auth.js' },
  { id: 'b', ts: at('2026-09-24T09:45:00Z'), text: 'mtg standup' },
  { id: 'c', ts: at('2026-09-24T10:00:00Z'), text: 'dev code review', notes: 'PR #42' },
];

test('notes show under their entry in /log', () => {
  const report = T.formatReport(NOTED, T.parseRange('today', NOW), NOW);
  assert.match(report, / {2}1 {2}09:00 {2}09:45 {4}0:45 {2}dev {7}fixing login bug\n {5}> root cause: expired token\n {5}> fix in auth.js\n {2}2 {2}09:45/);
  assert.match(report, /code review\n {5}> PR #42\n/);
});

test('notes survive the txt and csv backups', () => {
  const want = NOTED.map(({ ts, text, notes }) => (notes ? { ts, text, notes } : { ts, text }));
  for (const text of [T.formatReport(NOTED, ALL, NOW), T.formatReport(NOTED, ALL, NOW, { compact: true }), T.toCSV(NOTED, ALL, NOW)]) {
    const r = T.parseBackup(text);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.entries, want);
  }
  // Older csv exports without the notes column still restore.
  const old = 'n,start,end,minutes,category,note\n1,2026-09-24T09:00:00.000Z,,1.0,dev,x\n';
  assert.deepEqual(T.parseBackup(old).entries, [{ ts: at('2026-09-24T09:00:00Z'), text: 'dev x' }]);
});

test('/edit shows notes and saves changes to them', () => {
  const { text, items } = T.formatEditable(NOTED, ALL, NOW);
  assert.match(text, / {2}1 {2}09:00 {2}dev fixing login bug\n {12}> root cause: expired token\n {12}> fix in auth\.js\n/);
  assert.deepEqual(T.parseEditable(text, items, NOW).ops, []);
  const edited = text
    .replace('> PR #42', '> PR #42, approved')
    .replace('  2  09:45  mtg standup', '  2  09:45  mtg standup\n> ran long')
    .replace(/ {12}> root cause.*\n.*fix in auth\.js\n/, '');
  const r = T.parseEditable(edited, items, NOW);
  assert.deepEqual(r.errors, []);
  assert.equal(r.changed, 3);
  const byId = Object.fromEntries(r.ops.map((o) => [o.entry.id, o.entry]));
  assert.equal(byId.a.notes, undefined);
  assert.equal(byId.b.notes, 'ran long');
  assert.equal(byId.c.notes, 'PR #42, approved');
  const bad = T.parseEditable('> orphan\n' + text, items, NOW);
  assert.match(bad.errors[0], /must go under an entry/);
});

test('/report groups entries by category, largest first', () => {
  assert.equal(T.formatCategoryReport(NOTED, T.parseRange('today', NOW), NOW), [
    'report: today (2026-09-24)',
    '',
    'dev                     0:57   79%  2 entries',
    '  1  09:00    0:45  fixing login bug',
    '     > root cause: expired token',
    '     > fix in auth.js',
    '  3  10:00    0:12  code review',
    '     > PR #42',
    '',
    'mtg                     0:15   21%  1 entry',
    '  2  09:45    0:15  standup',
    '',
    '-'.repeat(48),
    'total                   1:12        3 entries',
  ].join('\n'));
  const week = T.formatCategoryReport(LOG, T.parseRange('week', NOW), NOW);
  assert.match(week, /report: week \(2026-09-23 \.\. 2026-09-24\)/);
  assert.match(week, / {2}1 {2}Wed 09-23 16:00 {4}1:30 {2}wrap up/);
  assert.ok(!/\(off\)/.test(week), 'off time is left out');
  assert.equal(T.formatCategoryReport(NOTED, T.parseRange('2026-01-01', NOW), NOW), 'no entries (2026-01-01)');
});

// ---- work orders ---------------------------------------------------------------

const WO_LOG = [
  { id: 'a', ts: at('2026-09-24T09:00:00Z'), text: 'dev fixing login bug', wo: '4471', wl: true },
  { id: 'b', ts: at('2026-09-24T09:45:00Z'), text: 'mtg standup' },
  { id: 'c', ts: at('2026-09-24T10:00:00Z'), text: 'dev code review', wo: 'WO-88', notes: 'PR #42' },
];

test('work orders show in a column before the time', () => {
  assert.equal(T.formatReport(WO_LOG, T.parseRange('today', NOW), NOW).split('\n').slice(1, 6).join('\n'), [
    '  #  wo       start  end       dur  category  note',
    '  1  [4471]   09:00  09:45    0:45  dev       fixing login bug',
    '  2           09:45  10:00    0:15  mtg       standup',
    '  3  [WO-88]  10:00  now      0:12  dev       code review',
    '     > PR #42',
  ].join('\n'));
  // No work orders in view: no column.
  assert.ok(!/ wo /.test(T.formatReport(LOG, T.parseRange('today', NOW), NOW)));
  assert.match(T.formatCategoryReport(WO_LOG, T.parseRange('today', NOW), NOW), / {2}1 {2}\[4471\] {3}09:00 {4}0:45 {2}fixing login bug\n/);
});

test('/wolist totals time per work order', () => {
  assert.equal(T.formatWorkOrders(WO_LOG, T.parseRange('today', NOW), NOW), [
    'work orders: today (2026-09-24)',
    '',
    '[4471]      0:45   63%  1 entry      dev',
    '[WO-88]     0:12   17%  1 entry      dev',
    '(none)      0:15   21%  1 entry      mtg',
    '-'.repeat(48),
    'total       1:12        3 entries',
  ].join('\n'));
});

test('work orders survive backups and /edit', () => {
  const want = WO_LOG.map(({ ts, text, notes, wo }) => Object.assign({ ts, text }, notes ? { notes } : {}, wo ? { wo } : {}));
  for (const text of [T.formatReport(WO_LOG, ALL, NOW), T.formatReport(WO_LOG, ALL, NOW, { compact: true }), T.toCSV(WO_LOG, ALL, NOW)]) {
    const r = T.parseBackup(text);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.entries, want);
  }
  const { text, items } = T.formatEditable(WO_LOG, ALL, NOW);
  assert.match(text, / {2}1 {2}\[4471\] {2}09:00 {2}dev fixing login bug\n/);
  assert.deepEqual(T.parseEditable(text, items, NOW).ops, []);
  const r = T.parseEditable(text.replace('  [4471]  09:00', '  [5000]  09:00').replace('[WO-88]  ', '') + '[77] 10:05 email\n', items, NOW);
  assert.deepEqual(r.errors, []);
  const byText = Object.fromEntries(r.ops.map((o) => [o.entry.text, o.entry]));
  assert.deepEqual([byText['dev fixing login bug'].wo, byText['dev fixing login bug'].wl], ['5000', undefined]);
  assert.equal(byText['dev code review'].wo, undefined);
  assert.equal(byText['email'].wo, '77');
  assert.match(T.parseEditable(text.replace('  [4471]  09:00', '  [has space]  09:00'), items, NOW).errors[0], /not a valid work order/);
  // A work order that looks like a number is never mistaken for an entry number.
  assert.deepEqual(T.parseBackup('Thu 2026-09-24\n  12  [4471]  09:00  dev x\n').entries, [{ ts: at('2026-09-24T09:00:00Z'), text: 'dev x', wo: '4471' }]);
});
