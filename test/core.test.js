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
  assert.equal(spans[1].n, '000020');
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
    '             start  end       dur  category  note',
    '  ID:000030  09:00  09:45    0:45  dev       fixing login bug',
    '  ID:000040  09:45  10:00    0:15  mtg       standup',
    '  ID:000050  10:00  now      0:12  dev       code review',
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
  assert.match(report, / {2}ID:000020 {2}17:30 {2}09:00 {3}15:30 {2}off\n/);
  assert.match(report, / {2}total {6}18:12$/);
});

test('empty range', () => {
  assert.equal(T.formatReport(LOG, T.parseRange('2026-01-01', NOW), NOW), 'no entries (2026-01-01)');
});

test('csv export quotes fields and leaves the running end blank', () => {
  const log = [...LOG, { ts: at('2026-09-24T10:05:00Z'), text: 'mtg sync, "roadmap"' }];
  const lines = T.toCSV(log, T.parseRange('today', NOW), NOW).trimEnd().split('\n');
  assert.equal(lines[0], 'n,wo,start,end,minutes,category,note,notes,files');
  assert.equal(lines[1], '000030,,2026-09-24T09:00:00.000Z,2026-09-24T09:45:00.000Z,45.0,dev,fixing login bug,,');
  assert.equal(lines[4], '000060,,2026-09-24T10:05:00.000Z,,7.0,mtg,"sync, ""roadmap""",,');
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

test('compact report (phones): two lines an entry, and restore reads it back', () => {
  const text = T.formatReport(WO_LOG, T.parseRange('today', NOW), NOW, { compact: true });
  assert.equal(text, [
    'Thu 2026-09-24',
    '  ID:000010  09:00   0:45  [4471]',
    '             dev fixing login bug',
    '  ID:000020  09:45   0:15',
    '             mtg standup',
    '  ID:000030  10:00   0:12  [WO-88]',
    '             dev code review',
    '             > PR #42',
    '  ' + '-'.repeat(36),
    '  dev         0:57   79%',
    '  mtg         0:15   21%',
    '  total       1:12',
  ].join('\n'));
  const back = T.parseBackup(text);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.entries.map((e) => [e.text, e.wo || '', e.notes || '']),
    [['dev fixing login bug', '4471', ''], ['mtg standup', '', ''], ['dev code review', 'WO-88', 'PR #42']]);
  // Exports made on the 12-hour clock read back too.
  try {
    T.setClock('12');
    const twelve = T.parseBackup(T.formatReport(LOG, T.parseRange('today', NOW), NOW));
    assert.deepEqual(twelve.errors, []);
    assert.deepEqual(twelve.entries.map((e) => T.hhmm(e.ts)), ['09:00', '09:45', '10:00']);
  } finally {
    T.setClock('24');
  }
});

test('compact report keeps the summary', () => {
  assert.equal(T.formatReport(LOG, T.parseRange('today', NOW), NOW, { compact: true }).split('\n').slice(-4).join('\n'), [
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
  assert.deepEqual(items.map((i) => i.n), ['000010', '000020', '000030', '000040']);
  assert.equal(text.split('\n').filter((l) => !l.startsWith('#')).join('\n'), [
    'Wed 2026-09-23',
    '  ID:000010  17:30  off',
    'Thu 2026-09-24',
    '  ID:000020  09:00  dev fixing login bug',
    '  ID:000030  09:45  mtg standup',
    '  ID:000040  10:00  dev code review',
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
    '  ID:000010  17:30  off',
    'Thu 2026-09-24',
    '  ID:000020  09:00  dev   fixing the login bug',
    '  ID:000040  09:55  dev code review',
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
    '  ID:000020  09:00  dev a',
    '  ID:000020  09:10  dev b',
    '  ID:000090  09:20  dev c',
    '  ID:000030  25:00  mtg',
    '  ID:000040  10:30  dev later than now',
    'just some words',
    'Mon 2026-02-30',
  ].join('\n'), items, NOW);
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.errors.map((e) => e.split(':')[0]), ['line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
  assert.match(r.errors[0], /more than once/);
  assert.match(r.errors[1], /no entry ID:000090/);
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
    '             start  end       dur  category  note',
    '  ID:000010  09:00  09:45    0:45  dev       fixing login bug',
    '  ID:000020  09:45  10:00       -  (off)',
    '  ID:000030  10:00  10:05    0:05  mtg       standup',
    '  ID:000040  10:05  now         -  (off)',
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
  assert.match(text, /  ID:000020  09:45  \/off\n/);
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
  assert.match(report, / {2}ID:000010 {2}09:00 {2}09:45 {4}0:45 {2}dev {7}fixing login bug\n {13}> root cause: expired token\n {13}> fix in auth.js\n {2}ID:000020 {2}09:45/);
  assert.match(report, /code review\n {13}> PR #42\n/);
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
  assert.match(text, / {2}ID:000010 {2}09:00 {2}dev fixing login bug\n {20}> root cause: expired token\n {20}> fix in auth\.js\n/);
  assert.deepEqual(T.parseEditable(text, items, NOW).ops, []);
  const edited = text
    .replace('> PR #42', '> PR #42, approved')
    .replace('  ID:000020  09:45  mtg standup', '  ID:000020  09:45  mtg standup\n> ran long')
    .replace(/ {20}> root cause.*\n.*fix in auth\.js\n/, '');
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
    '  ID:000010  09:00-09:45    0:45  fixing login bug',
    '             > root cause: expired token',
    '             > fix in auth.js',
    '  ID:000030  10:00-now      0:12  code review',
    '             > PR #42',
    '',
    'mtg                     0:15   21%  1 entry',
    '  ID:000020  09:45-10:00    0:15  standup',
    '',
    '-'.repeat(48),
    'total                   1:12        3 entries',
  ].join('\n'));
  const week = T.formatCategoryReport(LOG, T.parseRange('week', NOW), NOW);
  assert.match(week, /report: week \(2026-09-23 \.\. 2026-09-24\)/);
  assert.match(week, / {2}ID:000010 {2}Wed 09-23 16:00-17:30 {4}1:30 {2}wrap up/);
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
    '             wo       start  end       dur  category  note',
    '  ID:000010  [4471]   09:00  09:45    0:45  dev       fixing login bug',
    '  ID:000020           09:45  10:00    0:15  mtg       standup',
    '  ID:000030  [WO-88]  10:00  now      0:12  dev       code review',
    '             > PR #42',
  ].join('\n'));
  // No work orders in view: no column.
  assert.ok(!/ wo /.test(T.formatReport(LOG, T.parseRange('today', NOW), NOW)));
  assert.match(T.formatCategoryReport(WO_LOG, T.parseRange('today', NOW), NOW), / {2}ID:000010 {2}\[4471\] {3}09:00-09:45 {4}0:45 {2}fixing login bug\n/);
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
  assert.match(text, / {2}ID:000010 {2}\[4471\] {2}09:00 {2}dev fixing login bug\n/);
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

// ---- editing an entry from the GUI -----------------------------------------------

test('editEntry applies the card fields with the /edit rules', () => {
  const e = { id: 'x', ts: at('2026-09-24T09:00:30Z'), text: 'dev fixing login bug', wo: '4471', wl: true, notes: 'a' };
  const same = T.editEntry(e, { time: '09:00', wo: '4471', text: 'dev fixing login bug', notes: 'a' }, NOW);
  assert.equal(same.changed, false);
  assert.equal(same.entry.ts, e.ts, 'an unchanged time keeps its seconds');
  const r = T.editEntry(e, { time: '8:45', wo: '[5000]', text: '  dev   fixing the bug ', notes: 'line 1  \nline 2\n' }, NOW);
  assert.deepEqual(r.entry, { id: 'x', ts: at('2026-09-24T08:45:00Z'), text: 'dev fixing the bug', notes: 'line 1\nline 2', wo: '5000' });
  assert.equal(r.changed, true);
  assert.equal(T.editEntry(e, { time: '09:00', wo: '', text: 'dev x', notes: '' }, NOW).entry.wo, undefined);
  assert.match(T.editEntry(e, { time: '25:00', text: 'dev' }, NOW).error, /14:30/);
  assert.match(T.editEntry(e, { time: '11:00', text: 'dev' }, NOW).error, /future/);
  assert.match(T.editEntry(e, { time: '09:00', text: '' }, NOW).error, /needs some text/);
  assert.match(T.editEntry(e, { time: '09:00', text: '/log' }, NOW).error, /can't start/);
  assert.match(T.editEntry(e, { time: '09:00', text: 'dev', wo: 'a b' }, NOW).error, /not a valid work order/);
});

test('earnings: rate, weekly overtime, and settings that change over time', () => {
  const h = 3600000;
  const mon = new Date(2026, 8, 21, 9).getTime(); // Monday 09:00
  const day = (d, hour) => mon + d * 24 * h + (hour - 9) * h;
  // Mon-Fri 9:00-18:00 (9h a day, 45h in the week), then Monday of next week.
  const entries = [];
  for (let d = 0; d < 5; d++) {
    entries.push({ id: `w${d}`, ts: day(d, 9), text: 'dev work' }, { id: `o${d}`, ts: day(d, 18), text: '/off' });
  }
  entries.push({ id: 'next', ts: day(7, 9), text: 'dev new week' }, { id: 'nextOff', ts: day(7, 11), text: '/off' });
  const now = day(8, 12);

  assert.equal(T.hasPay({}), false);
  let pay = T.setPay({}, 'rate', 20, day(2, 12)); // set midweek: covers earlier time too
  assert.equal(T.payValue(pay, 'rate', day(0, 9)), 20);
  let e = T.earnings(entries, pay, now);
  assert.equal(e.get('w0').money, 180);
  assert.equal(e.get('o0'), undefined); // off time earns nothing

  pay = T.setPay(pay, 'otmin', 40, day(2, 12)); // 40h a week, 1.5x by default
  e = T.earnings(entries, pay, now);
  assert.equal(e.get('w3').money, 180); // 27h..36h: all regular
  assert.equal(e.get('w4').money, 4 * 20 + 5 * 20 * 1.5); // 36h..45h: 4 regular, 5 overtime
  assert.equal(e.get('w4').ot, true);
  assert.equal(e.get('w3').ot, false);
  assert.equal(e.get('next').money, 40); // a new week starts regular again

  // Weeks run Sunday to Saturday: a Sunday starts a new one.
  assert.equal(T.ymd(T.weekStart(day(0, 9))), '2026-09-20');
  assert.equal(T.ymd(T.weekStart(day(6, 9))), '2026-09-27');
  assert.equal(T.ymd(T.weekStart(day(5, 23))), '2026-09-20');

  pay = T.setPay(pay, 'otrate', 2, day(2, 12));
  assert.equal(T.earnings(entries, pay, now).get('w4').money, 4 * 20 + 5 * 20 * 2);

  pay = T.setPay(pay, 'rate', 30, day(4, 8)); // a raise from Friday morning on
  e = T.earnings(entries, pay, now);
  assert.equal(e.get('w3').money, 180); // Thursday keeps the old rate
  assert.equal(e.get('w4').money, 4 * 30 + 5 * 30 * 2);

  pay = T.setPay(pay, 'rate', null, day(6, 0)); // turned off from Sunday
  assert.equal(T.earnings(entries, pay, now).get('next').money, null);
  assert.equal(T.earnings(entries, pay, now).get('w4').money, 4 * 30 + 5 * 30 * 2);

  assert.equal(T.formatMoney(1234.567), '$1,234.57');
  assert.equal(T.parseAmount('$1,200.50'), 1200.5);
  assert.equal(T.parseAmount('abc'), null);
});

test('mergeSettings keeps the pay changes of both copies', () => {
  const a = { pay: { rate: [{ from: 0, value: 30 }], otrate: [{ from: 0, value: 2 }] } };
  const b = { pay: { rate: [{ from: 0, value: 30 }, { from: 500, value: 35 }], otmin: [{ from: 0, value: 40 }] } };
  const m = T.mergeSettings(a, b);
  assert.deepEqual(m.pay.rate, [{ from: 0, value: 30 }, { from: 500, value: 35 }]);
  assert.deepEqual(m.pay.otmin, [{ from: 0, value: 40 }]);
  assert.deepEqual(m.pay.otrate, [{ from: 0, value: 2 }]);
  // The same step changed on both: the first copy (this device's) wins.
  assert.deepEqual(T.mergeSettings({ pay: { rate: [{ from: 0, value: 1 }] } }, { pay: { rate: [{ from: 0, value: 2 }] } }).pay.rate, [{ from: 0, value: 1 }]);
});

test('the terminal package has the same version as the app', () => {
  assert.match(T.VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(require('../cli/package.json').version, T.VERSION);
});

// ---- the clock ------------------------------------------------------------------

test('/clock 12 shows times as 2:30pm; typing stays HH:MM', () => {
  try {
    T.setClock('12');
    assert.equal(T.clockMode(), '12');
    assert.equal(T.clock(at('2026-09-24T00:05:00Z')), '12:05am');
    assert.equal(T.clock(at('2026-09-24T09:00:00Z')), '9:00am');
    assert.equal(T.clock(at('2026-09-24T12:30:00Z')), '12:30pm');
    assert.equal(T.clock(at('2026-09-24T14:30:00Z')), '2:30pm');
    assert.equal(T.hhmm(at('2026-09-24T14:30:00Z')), '14:30');
    assert.equal(T.hourLabel(0), '12am');
    assert.equal(T.hourLabel(13), '1pm');
    const report = T.formatCategoryReport(NOTED, T.parseRange('today', NOW), NOW);
    assert.match(report, / {2}ID:000010 {2} 9:00am-9:45am {5}0:45 {2}fixing login bug/);
    assert.match(report, / {2}ID:000030 {2}10:00am-now {8}0:12 {2}code review/);
    const log = T.formatReport(NOTED, T.parseRange('today', NOW), NOW);
    assert.match(log, /^ {13}start {4}end {9}dur/m);
    assert.match(log, / {2}ID:000010 {2} 9:00am {2} 9:45am {4}0:45/);
    assert.match(T.formatEditable(NOTED, T.parseRange('today', NOW), NOW).text, / 09:00 {2}dev fixing login bug/);
  } finally {
    T.setClock('24');
  }
  assert.equal(T.clock(at('2026-09-24T14:30:00Z')), '14:30');
  assert.equal(T.hourLabel(9), '09:00');
});

// ---- forms ----------------------------------------------------------------------

const FORM_LOG = [
  { id: 'a', ts: at('2026-09-24T08:00:00Z'), text: 'dev refactor', wo: '4471', notes: 'root cause' },
  { id: 'b', ts: at('2026-09-24T09:30:00Z'), text: 'mtg standup' },
  { id: 'c', ts: at('2026-09-24T10:00:00Z'), text: 'dev review', wo: '4471', notes: 'PR #42' },
  { id: 'd', ts: at('2026-09-24T12:00:00Z'), text: 'dev deploy', wo: '4480' },
  { id: 'e', ts: at('2026-09-24T13:00:00Z'), text: '/off' },
];

test('forms: tokens cover the entries in scope; %{each} repeats per group', () => {
  const day = T.parseRange('2026-09-24', NOW);
  const fill = (t, answer) => T.fillForm(t, FORM_LOG, day, NOW, answer).text;
  assert.equal(fill('%{date} %{day}: %{hours} %{in}-%{out} down %{down} · %{category} · %{wo} · %{entries}\n'),
    '2026-09-24 Thursday: 5:00 08:00-13:00 down 0:00 · dev, mtg · 4471, 4480 · 4\n');
  assert.equal(fill('%{each category}\n%{category} %{hours} %{in}-%{out} down %{down} [%{titles}]\n%{notes}\n%{end}\n'), [
    'dev 4:30 08:00-13:00 down 0:30 [refactor, review, deploy]',
    'root cause\nPR #42',
    '',
    '-'.repeat(40),
    '',
    'mtg 0:30 09:30-10:00 down 0:00 [standup]',
    '',
  ].join('\n'));
  // Work orders: time without one gets its own "(none)" section, last.
  const byWo = fill('%{each wo}\n%{wo}: %{hours} %{ask:System}\n%{end}', (label, where) => `${label}@${where}`);
  assert.equal(byWo, `4471: 3:30 System@[4471]\n\n${'-'.repeat(40)}\n\n4480: 1:00 System@[4480]\n\n${'-'.repeat(40)}\n\n(none): 0:30 System@no work order\n`);
  // Nested: no dividers inside.
  assert.equal(fill('%{each category}\n%{category}\n%{each entry}\n- %{in} %{titles}\n%{end}\n%{end}\n'),
    `dev\n- 08:00 refactor\n- 10:00 review\n- 12:00 deploy\n\n${'-'.repeat(40)}\n\nmtg\n- 09:30 standup\n`);
  assert.deepEqual(T.formQuestions('%{ask:System} %{each wo}%{ask:System}%{end}', FORM_LOG, day, NOW).map((q) => q.where), ['', '[4471]', '[4480]', 'no work order']);
  assert.deepEqual(T.fillForm('%{each day}\n%{hourz}\n%{ask:}', FORM_LOG, day, NOW).errors, [
    '%{each day}: use %{each category}, %{each wo}, %{each equipment} or %{each entry}',
    'unknown token %{hourz} (/form tokens lists them)',
    '%{ask:...} needs a label, e.g. %{ask:System}',
    '%{each day} without an %{end}',
  ]);
});

test('day names are ranges: the latest one, today included', () => {
  // NOW is Thursday 2026-09-24.
  assert.equal(T.parseRange('thu', NOW).label, '2026-09-24');
  assert.equal(T.parseRange('tuesday', NOW).label, '2026-09-22');
  assert.equal(T.parseRange('fri', NOW).label, '2026-09-18');
  assert.equal(T.parseRange('th', NOW), null);
});

test('forms: %{dur}, %{in12} / %{out12}, %{title} and equipment', () => {
  const log = FORM_LOG.map((e) => (e.id === 'a' || e.id === 'c' ? { ...e, eq: 'ler-resolve-07', ql: true } : e));
  const day = T.parseRange('2026-09-24', NOW);
  const fill = (t) => T.fillForm(t, log, day, NOW).text;
  assert.equal(fill('%{each title}\n%{title} - %{dur}\n%{end}'), 'refactor - 1:30\nstandup - 0:30\nreview - 2:00\ndeploy - 1:00\n');
  assert.equal(fill('%{in12}-%{out12} / %{in24}-%{out24} / %{in}-%{out}\n'), '8:00am-1:00pm / 08:00-13:00 / 08:00-13:00\n');
  assert.equal(fill('%{equipment}|%{eq}\n'), 'ler-resolve-07|ler-resolve-07\n');
  assert.equal(fill('%{each equipment}\n%{equipment}: %{hours}\n%{end}'), `ler-resolve-07: 3:30\n\n${'-'.repeat(40)}\n\n(none): 1:30\n`);
});

test('equipment is kept through makeEntry, the entry card and /edit', () => {
  const e = T.makeEntry({ id: 'x', ts: at('2026-09-24T09:00:00Z'), text: 'dev a', eq: 'rig-1', ql: true });
  assert.deepEqual(e, { id: 'x', ts: at('2026-09-24T09:00:00Z'), text: 'dev a', eq: 'rig-1', ql: true });
  assert.deepEqual(T.makeEntry(e, { notes: 'n' }).eq, 'rig-1');
  // The card: unchanged when it doesn't send the field; set (unlinked) when it does.
  const kept = T.editEntry(e, { time: '09:00', text: 'dev b', notes: '' }, NOW);
  assert.equal(kept.entry.eq, 'rig-1');
  assert.equal(kept.entry.ql, true);
  const set = T.editEntry(e, { time: '09:00', text: 'dev a', eq: '{rig-2}', notes: '' }, NOW);
  assert.equal(set.entry.eq, 'rig-2');
  assert.equal(set.entry.ql, undefined);
  assert.match(T.editEntry(e, { time: '09:00', text: 'dev a', eq: 'rig{1}' }, NOW).error, /not valid equipment/);
  assert.equal(T.editEntry(e, { time: '09:00', text: 'dev a', eq: 'rig-1 ,rig 2, RIG-1' }, NOW).entry.eq, 'rig-1, rig 2');
  // /edit: the text doesn't show equipment, and saving keeps it.
  const { text, items } = T.formatEditable([e], T.parseRange('2026-09-24', NOW), NOW);
  const r = T.parseEditable(text.replace('dev a', 'dev renamed'), items, NOW);
  assert.equal(r.ops[0].entry.eq, 'rig-1');
  assert.equal(r.ops[0].entry.text, 'dev renamed');
});

test('equipment lists: several names, each its own %{each equipment} section', () => {
  assert.equal(T.normalizeEq('ler-resolve-01, ler-resolve-07'), 'ler-resolve-01, ler-resolve-07');
  assert.equal(T.normalizeEq('{a,b}'), 'a, b');
  assert.equal(T.normalizeEq(' a ,, A , b  c '), 'a, b c');
  assert.equal(T.normalizeEq('a[1]'), null);
  assert.equal(T.normalizeEq('x'.repeat(41)), null);
  const log = FORM_LOG.map((e) => (e.id === 'a' ? { ...e, eq: 'r-01, r-07' } : e.id === 'c' ? { ...e, eq: 'r-07' } : e));
  const day = T.parseRange('2026-09-24', NOW);
  const fill = (t) => T.fillForm(t, log, day, NOW).text;
  assert.equal(fill('%{equipment}\n'), 'r-01, r-07\n');
  const div = `\n\n${'-'.repeat(40)}\n\n`;
  assert.equal(fill('%{each equipment}\n%{equipment}: %{hours} %{titles}\n%{end}'),
    `r-01: 1:30 refactor${div}r-07: 3:30 refactor, review${div}(none): 1:30 standup, deploy\n`);
});

test('forms: a token alone on its line leaves no blank line when empty', () => {
  const day = T.parseRange('2026-09-24', NOW);
  const t = '%{each entry}\n%{title} %{in}-%{out}\n  %{notes}\n%{wo}\n%{end}\nWO: %{wo}\n';
  assert.equal(T.fillForm(t, FORM_LOG.slice(0, 2), day, NOW).text,
    'refactor 08:00-09:30\n  root cause\n4471\nstandup 09:30-now\nWO: 4471\n');
  const multi = [{ ...FORM_LOG[0], notes: 'one\ntwo' }, FORM_LOG[1]];
  assert.equal(T.fillForm('> %{notes}\n  %{notes}\n', multi, day, NOW).text, '> one\ntwo\n  one\n  two\n');
});

test('timeline colors are per range: a day\'s categories get distinct colors', () => {
  const log = [];
  // Ten categories on Wednesday, then three new ones on Thursday.
  for (let i = 0; i < 10; i++) log.push({ id: `w${i}`, ts: at(`2026-09-23T${String(8 + i).padStart(2, '0')}:00:00Z`), text: `cat${i} x` });
  log.push({ id: 'o', ts: at('2026-09-23T19:00:00Z'), text: '/off' });
  for (const [i, c] of ['alpha', 'beta', 'gamma'].entries()) log.push({ id: `t${i}`, ts: at(`2026-09-24T${String(8 + i).padStart(2, '0')}:00:00Z`), text: `${c} y` });
  const thu = T.timelineDays(log, T.parseRange('2026-09-24', NOW), NOW);
  assert.deepEqual(thu.days[0].blocks.map((b) => b.slot), [0, 1, 2]);
  const wed = T.timelineDays(log, T.parseRange('2026-09-23', NOW), NOW);
  // Past 8 they cycle rather than going grey.
  assert.deepEqual(wed.days[0].blocks.filter((b) => !b.off).map((b) => b.slot), [0, 1, 2, 3, 4, 5, 6, 7, 0, 1]);
});

// ---- entry IDs ------------------------------------------------------------------

test('entry IDs: a log without them is numbered by position x10; new ones get the next ten', () => {
  const log = [
    { id: 'b', ts: at('2026-09-24T09:00:00Z'), text: 'dev a' },
    { id: 'a', ts: at('2026-09-24T10:00:00Z'), text: 'mtg b' },
    { id: 'l', ts: at('2026-09-24T00:00:00Z'), text: '/wo dev', wo: '1' }, // a link: no ID
    { id: 'c', ts: at('2026-09-24T11:00:00Z'), text: '/off' },
  ];
  const first = T.assignIds(log);
  assert.deepEqual(first.changed.map((e) => [e.id, e.sid]), [['b', 10], ['a', 20], ['c', 30]]);
  const numbered = T.applyOps(log, first.changed.map((entry) => ({ op: 'put', entry })));
  assert.deepEqual(T.assignIds(numbered).changed, []);
  // At the end: the next multiple of ten. In between: the next free number
  // after the one before.
  const more = numbered.concat(
    { id: 'n', ts: at('2026-09-24T12:00:00Z'), text: 'dev new' },
    { id: 'i1', ts: at('2026-09-24T09:30:00Z'), text: 'dev between' },
    { id: 'i2', ts: at('2026-09-24T09:40:00Z'), text: 'dev between again' },
  );
  const r = T.assignIds(T.sortEntries(more));
  assert.deepEqual(r.changed.map((e) => [e.id, e.sid]).sort(), [['i1', 11], ['i2', 12], ['n', 40]]);
  assert.equal(r.renumbered, 0);
  // Time edits don't change IDs; spans show them six digits wide.
  const spans = T.withSpans(T.applyOps(numbered, r.changed.map((entry) => ({ op: 'put', entry }))), NOW);
  assert.deepEqual(spans.map((s) => s.n), ['000010', '000011', '000012', '000020', '000030', '000040']);
});

test('entry IDs: no room in between means the next ten; duplicates get a new one', () => {
  const log = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((sid, i) => ({ id: `e${i}`, ts: at('2026-09-24T09:00:00Z') + i * 60000, sid, text: 'dev x' }));
  log.push({ id: 'new', ts: at('2026-09-24T09:05:30Z'), text: 'dev squeezed' });
  const r = T.assignIds(T.sortEntries(log));
  assert.deepEqual(r.changed.map((e) => e.sid), [30]);
  // Two devices both made 000020 offline: the lower internal id keeps it.
  const dup = [
    { id: 'x', ts: at('2026-09-24T09:00:00Z'), sid: 10, text: 'dev a' },
    { id: 'zz', ts: at('2026-09-24T10:00:00Z'), sid: 20, text: 'dev from laptop' },
    { id: 'yy', ts: at('2026-09-24T10:05:00Z'), sid: 20, text: 'dev from phone' },
  ];
  const d = T.assignIds(dup);
  assert.equal(d.renumbered, 1);
  assert.deepEqual(d.changed.map((e) => [e.id, e.sid]), [['zz', 11]]); // it sits between 10 and 20
});

test('entry IDs: typed IDs, in full or by their last digits', () => {
  const spans = [10, 20, 450, 1450, 15620].map((sid, i) => ({ n: T.idText(sid), i }));
  assert.equal(T.findById(spans, '000450').i, 2);
  assert.equal(T.findById(spans, '#015620').i, 4);
  assert.equal(T.findById(spans, '450').i, 3, 'the latest ending in 450');
  assert.equal(T.findById(spans, '20').i, 4);
  assert.equal(T.findById(spans, '99'), null);
  assert.equal(T.findById(spans, 'abc'), null);
  // Kept through makeEntry and the entry card.
  const e = T.makeEntry({ id: 'q', ts: at('2026-09-24T09:00:00Z'), text: 'dev a', sid: 450 });
  assert.equal(T.makeEntry(e, { notes: 'n' }).sid, 450);
  assert.equal(T.editEntry(e, { time: '08:00', text: 'dev b', notes: '' }, NOW).entry.sid, 450);
});

// ---- breaks and calendar ranges ----------------------------------------------------

test('breaks: unpaid is not counted (like /off); paid counts, on its own line', () => {
  const log = [
    { id: 'a', ts: at('2026-09-24T09:00:00Z'), text: 'dev work' },
    { id: 'b', ts: at('2026-09-24T10:00:00Z'), text: '/break-paid' },
    { id: 'c', ts: at('2026-09-24T10:15:00Z'), text: 'dev more' },
    { id: 'd', ts: at('2026-09-24T11:00:00Z'), text: '/break-unpaid' },
    { id: 'e', ts: at('2026-09-24T11:30:00Z'), text: 'dev after lunch' },
    { id: 'f', ts: at('2026-09-24T12:00:00Z'), text: '/off' },
  ];
  const day = T.parseRange('2026-09-24', NOW);
  const spans = T.withSpans(log, NOW);
  assert.deepEqual(spans.map((s) => [s.category, s.off]), [['dev', false], ['(paid break)', false], ['dev', false], ['(unpaid break)', true], ['dev', false], ['(off)', true]]);
  const log1 = T.formatReport(log, day, NOW);
  assert.match(log1, /ID:000020 {2}10:00 {2}10:15 {4}0:15 {2}\(paid break\)/);
  assert.match(log1, /ID:000040 {2}11:00 {2}11:30 {7}- {2}\(unpaid break\)/);
  assert.match(log1, /\(paid break\) +0:15 +10%\n {2}total +2:30/, 'paid counts toward the total; unpaid doesn\'t');
  assert.deepEqual(T.knownCategories(log), ['dev'], 'breaks are not categories to suggest');
  // Pay: the paid break is paid, the unpaid one isn't.
  const pay = T.setPay({}, 'rate', 60, 0);
  const earned = T.earnings(log, pay, NOW);
  assert.equal(earned.get('b').money, 15);
  assert.ok(!earned.get('d') || !earned.get('d').money);
  // /edit and backups keep them.
  const back = T.parseBackup(log1);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.entries.map((e) => e.text), log.map((e) => e.text));
  const later = at('2026-09-24T13:00:00Z');
  const { text, items } = T.formatEditable(log, day, later);
  assert.match(text, /ID:000020 {2}10:00 {2}\/break-paid\n/);
  assert.deepEqual(T.parseEditable(text, items, later).errors, []);
});

test('calweek is Sunday to Saturday; calmonth the calendar month', () => {
  // NOW is Thursday 2026-09-24.
  const w = T.parseRange('calweek', NOW);
  assert.equal(T.ymd(w.from), '2026-09-20');
  assert.equal(T.ymd(T.addDays(w.to, -1)), '2026-09-26');
  const m = T.parseRange('calmonth', NOW);
  assert.equal(T.ymd(m.from), '2026-09-01');
  assert.equal(T.ymd(T.addDays(m.to, -1)), '2026-09-30');
  // week and month stay "the last 7 / 30 days".
  assert.equal(T.ymd(T.parseRange('week', NOW).from), '2026-09-18');
});

test('/find: every word, in text, notes, file paths or work orders; newest first', () => {
  const log = [
    { id: 'a', ts: at('2026-09-23T09:00:00Z'), text: 'dev stems for the label', wo: '4471', files: '/Work/stems.zip\n/Work/other.wav' },
    { id: 'b', ts: at('2026-09-24T09:00:00Z'), text: 'mtg standup', notes: 'talked about the label\nlunch plans' },
    { id: 'c', ts: at('2026-09-24T09:30:00Z'), text: 'dev other' },
  ];
  const r = T.formatSearch(log, 'LABEL', NOW);
  assert.equal(r.count, 2);
  assert.equal(r.text, [
    'found "LABEL": 2 entries',
    '',
    'Thu 2026-09-24',
    '  ID:000020  09:00   0:30  mtg standup',
    '             > talked about the label',
    '',
    'Wed 2026-09-23',
    '  ID:000010  09:00  24:00  [4471] dev stems for the label',
  ].join('\n'));
  assert.match(T.formatSearch(log, 'stems.zip', NOW).text, /@ \/Work\/ stems\.zip other\.wav/);
  assert.equal(T.formatSearch(log, '4471 label', NOW).count, 1);
  assert.equal(T.formatSearch(log, 'nope', NOW).text, 'nothing found for "nope"');
});

test('due days: today, tomorrow, the next day name, +N, dates; labels say overdue', () => {
  const now = new Date(2026, 9, 2, 10).getTime(); // a Friday
  assert.equal(T.parseDue('today', now), '2026-10-02');
  assert.equal(T.parseDue('tomorrow', now), '2026-10-03');
  assert.equal(T.parseDue('fri', now), '2026-10-02');
  assert.equal(T.parseDue('Monday', now), '2026-10-05');
  assert.equal(T.parseDue('+3', now), '2026-10-05');
  assert.equal(T.parseDue('10-09', now), '2026-10-09');
  assert.equal(T.parseDue('01-05', now), '2027-01-05');
  assert.equal(T.parseDue('09-29', now), '2026-09-29');
  assert.equal(T.dueLabel('2027-01-05', now).text, 'due Tue 2027-01-05');
  assert.equal(T.parseDue('2026-02-30', now), null);
  assert.equal(T.parseDue('soon', now), null);
  assert.deepEqual(T.dueLabel('2026-09-30', now), { text: 'overdue, was due Wed 09-30', late: true, soon: true });
  assert.equal(T.dueLabel('2026-10-02', now).text, 'due today');
  assert.equal(T.dueLabel('2026-10-03', now).text, 'due tomorrow');
  assert.equal(T.dueLabel('2026-10-09', now).text, 'due Fri 10-09');
});

test('/find on a phone: two lines an entry, like the compact /log', () => {
  const log = [{ id: 'a', ts: at('2026-09-23T09:00:00Z'), text: 'dev stems for the label', wo: '4471' }, { id: 'b', ts: at('2026-09-23T10:00:00Z'), text: '/off' }];
  assert.equal(T.formatSearch(log, 'label', NOW, 100, { compact: true }).text, [
    'found "label": 1 entry',
    '',
    'Wed 2026-09-23',
    '  ID:000010  09:00   1:00  [4471]',
    '             dev stems for the label',
  ].join('\n'));
});

test('accent colors: named ones step for dark screens; any #rrggbb works; text on it stays readable', () => {
  assert.deepEqual(T.accentColors(''), { name: 'indigo', light: { accent: '#4f46e5', on: '#ffffff' }, dark: { accent: '#8b8cf8', on: '#111318' } });
  assert.equal(T.accentColors('Teal').light.accent, '#0f766e');
  const y = T.accentColors('#FFD400');
  assert.equal(y.name, '#ffd400');
  assert.equal(y.light.on, '#111318'); // dark text on yellow
  assert.equal(y.dark.accent, '#ffe359'); // lighter for dark screens
  assert.equal(T.accentColors('#0a7d4f').light.on, '#ffffff');
  assert.equal(T.accentColors('nope'), null);
  assert.equal(T.accentColors('#12345'), null);
});

test('file paths: a folder then its files, commas or spaces, carried across lines; shown grouped', () => {
  assert.deepEqual(T.parseFiles('/Volumes/Work/SP/ stems.zip mix_v7.wav, ref.wav'), ['/Volumes/Work/SP/stems.zip', '/Volumes/Work/SP/mix_v7.wav', '/Volumes/Work/SP/ref.wav']);
  assert.deepEqual(T.parseFiles('/Volumes/Work/SP stems.zip'), ['/Volumes/Work/SP/stems.zip']);
  assert.deepEqual(T.parseFiles('/Volumes/Work/SP/\nstems.zip\nmix_v7.wav\n/Other/one.wav'), ['/Volumes/Work/SP/stems.zip', '/Volumes/Work/SP/mix_v7.wav', '/Other/one.wav']);
  assert.deepEqual(T.parseFiles('/a/x.wav /b/y.wav'), ['/a/x.wav', '/b/y.wav']);
  assert.deepEqual(T.parseFiles('/a/ x y /b/ z'), ['/a/x', '/a/y', '/b/z']);
  assert.deepEqual(T.parseFiles('/Volumes/Work/SP/'), ['/Volumes/Work/SP/']); // a folder on its own
  assert.deepEqual(T.parseFiles('"/Volumes/Work/stems v3/stems.zip"'), ['/Volumes/Work/stems v3/stems.zip']);
  const full = '/Volumes/Work/SP/stems.zip\n/Volumes/Work/SP/mix_v7.wav\n/Other/one.wav';
  assert.deepEqual(T.groupFiles(full), ['/Volumes/Work/SP/ stems.zip mix_v7.wav', '/Other/one.wav']);
  assert.equal(T.parseFiles(T.groupFiles(full).join('\n')).join('\n'), full); // shown, then read back: the same
  assert.equal(T.filesList(full), '/Volumes/Work/SP/\n  stems.zip\n  mix_v7.wav\n/Other/one.wav');
});

test('/ai request: structured output, effort by task, fallbacks only where supported; replies are checked', () => {
  const A = require('../public/ai.js');
  const r = A.buildRequest({ model: 'opus', context: 'ctx', text: 'do it' });
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.output_config.format.type, 'json_schema');
  assert.equal(r.output_config.effort, 'low');
  assert.deepEqual(r.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(r.fallbacks, 'default');
  assert.equal(r.messages[0].content.at(-1).text, 'ctx\n\nRequest: do it');
  const p = A.buildRequest({ model: 'opus', context: 'ctx', text: '', files: [{ kind: 'pdf', name: 's.pdf', data: 'QUJD' }, { kind: 'image', name: 'board.png', media_type: 'image/png', data: 'QUJD' }, { kind: 'text', name: 'a.csv', text: 'x,y' }] });
  assert.deepEqual(p.messages[0].content.map((b) => b.type), ['document', 'image', 'text', 'document', 'text']);
  assert.equal(p.messages[0].content[2].text, '(The image above is board.png.)');
  assert.deepEqual(p.messages[0].content[3].source, { type: 'text', media_type: 'text/plain', data: 'x,y' });
  assert.match(p.messages[0].content.at(-1).text, /Request: Link the work orders/);
  assert.equal(p.output_config.effort, 'medium');
  const h = A.buildRequest({ model: 'haiku', context: 'ctx', text: 'x' });
  assert.equal(h.model, 'claude-haiku-4-5');
  assert.equal(h.output_config.effort, undefined);
  assert.equal(h.betas, undefined);
  const msg = (text, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text }] });
  const ok = A.readReply(msg(JSON.stringify({ message: ' hi ', changes: [{ action: 'off', time: '16:00' }, { action: 'rm -rf', id: '1' }] })));
  assert.equal(ok.message, 'hi');
  assert.equal(ok.changes.length, 1); // an unknown action is dropped
  assert.equal(ok.changes[0].time, '16:00');
  assert.equal(ok.changes[0].category, ''); // missing fields become ""
  assert.equal(ok.changes[0].notes, '');
  // Title and notes are kept apart, with a glossary.
  assert.deepEqual(['title', 'notes'].map((f) => f in A.SCHEMA.properties.changes.items.properties), [true, true]);
  assert.match(A.SYSTEM, /Glossary/);
  assert.match(A.SYSTEM, /it goes in notes, never in title/);
  assert.match(A.readReply(msg('not json')).error, /unexpected/);
  assert.match(A.readReply(msg('{}', 'refusal')).error, /declined/);
  assert.match(A.readReply(msg('{"mess', 'max_tokens')).error, /cut off/);
});

// A zip (as Word, Excel and PowerPoint files are), deflated like the real ones.
function zipOf(files) {
  const zlib = require('node:zlib');
  const locals = [];
  const central = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name);
    const data = zlib.deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(Buffer.byteLength(text), 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(at, 42);
    locals.push(local, n, data);
    central.push(dir, n);
    at += 30 + n.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dirBytes.length, 12); end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...locals, dirBytes, end]));
}

test('/ai attachments: any kind is checked; Word, Excel and PowerPoint become text', async () => {
  const A = require('../public/ai.js');
  const tools = { toBase64: (b) => Buffer.from(b).toString('base64'), inflateRaw: async (b) => new Uint8Array(require('node:zlib').inflateRawSync(b)) };
  const enc = (t) => new Uint8Array(Buffer.from(t));
  assert.equal(A.kindOf('Schedule.PDF'), 'pdf');
  assert.equal(A.kindOf('board.jpeg'), 'image');
  assert.equal(A.kindOf('notes', 'text/plain'), 'text');
  assert.equal(A.kindOf('cal.ics'), 'text');
  assert.equal(A.kindOf('sheet.xlsx'), 'office');
  assert.equal(A.kindOf('take.wav'), '');
  assert.match(A.checkFile({ name: 'take.wav', size: 10 }), /can't read this kind/);
  assert.match(A.checkFile({ name: 'big.png', size: 6 * 1024 * 1024 }), /too large \(5 MB/);
  assert.equal(A.checkFile({ name: 'ok.pdf', size: 1000 }), '');

  const pdf = await A.readAttachment({ name: 's.pdf', type: '', bytes: enc('ABC') }, tools);
  assert.deepEqual(pdf, { name: 's.pdf', kind: 'pdf', media_type: 'application/pdf', data: 'QUJD' });
  assert.equal((await A.readAttachment({ name: 'n.csv', type: '', bytes: enc('a,b') }, tools)).text, 'a,b');
  assert.match((await A.readAttachment({ name: 'x.zip', type: '', bytes: enc('PK') }, tools)).error, /can't read/);
  assert.match((await A.readAttachment({ name: 'bad.docx', type: '', bytes: enc('not a zip') }, tools)).error, /couldn't read bad.docx/);

  const docx = zipOf({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>WO 4471</w:t></w:r><w:r><w:tab/><w:t>Hachette &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>Room B</w:t></w:r></w:p></w:body></w:document>',
  });
  const d = await A.readAttachment({ name: 'Schedule.docx', type: '', bytes: docx }, tools);
  assert.equal(d.kind, 'text');
  assert.equal(d.text, 'WO 4471\tHachette & Co\nRoom B');

  const xlsx = zipOf({
    'xl/sharedStrings.xml': '<sst><si><t>WO</t></si><si><t>Client</t></si><si><r><t>Life </t></r><r><t>of Fish</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>4471</v></c><c r="B2" t="s"><v>2</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>note</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  assert.equal(await A.officeText(xlsx, 'xlsx', tools.inflateRaw), 'Sheet 1\nWO\tClient\n4471\tLife of Fish\nnote\n\nSheet 2\nClient');

  const pptx = zipOf({
    'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>',
  });
  assert.equal(await A.officeText(pptx, 'pptx', tools.inflateRaw), 'Slide 1\nFirst\n\nSlide 2\nLast');
});

test('/ai context: a calendar of last, this and next week (Sunday to Saturday), across months', () => {
  const A = require('../public/ai.js');
  const now = new Date(2026, 9, 1, 15, 0).getTime(); // Thursday 1 October
  const old = { id: 'o', ts: new Date(2026, 8, 19, 9, 0).getTime(), text: 'ACME older' }; // before last week
  const lastWeek = { id: 'l', ts: new Date(2026, 8, 21, 9, 0).getTime(), text: 'ACME monday last week' };
  const ctx = A.contextText({ T, now, entries: [old, lastWeek], names: {}, todos: [] });
  assert.match(ctx, /This week: Sun 2026-09-27, Mon 2026-09-28, Tue 2026-09-29, Wed 2026-09-30, Thu 2026-10-01, Fri 2026-10-02, Sat 2026-10-03/);
  assert.match(ctx, /Last week: Sun 2026-09-20, /);
  assert.match(ctx, /Next week: Sun 2026-10-04, /);
  assert.ok(ctx.includes('monday last week') && !ctx.includes('ACME older'), 'entries from the start of last week');
  assert.match(A.SYSTEM, /never assume it stays in one month/);
});

test('/ai follow-up: earlier turns go first (files with the first), the log as it is now with the last', () => {
  const A = require('../public/ai.js');
  const files = [{ kind: 'text', name: 'a.csv', text: 'x,y' }];
  const r = A.buildRequest({ model: 'haiku', context: 'CTX', text: 'make it 3pm', files, history: [{ text: 'add a call at 2', reply: '{"message":"ok","changes":[]}' }] });
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(r.messages[0].content[0].type, 'document');
  assert.equal(r.messages[0].content.at(-1).text, 'Request: add a call at 2');
  assert.equal(r.messages[1].content[0].text, '{"message":"ok","changes":[]}');
  assert.match(r.messages[2].content[0].text, /^CTX\n\nFollow-up: make it 3pm/);
  assert.match(r.messages[2].content[0].text, /complete set of changes/);
  assert.ok(!r.messages[0].content.some((b) => b.text && b.text.includes('CTX')), 'the context only once, as it is now');
  const reply = A.readReply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"message":"hi","changes":[]}' }] });
  assert.equal(reply.raw, '{"message":"hi","changes":[]}');
});

test('_headers: the content policy allows index.html\'s one inline style, by its hash', () => {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const headers = fs.readFileSync(path.join(__dirname, '../public/_headers'), 'utf8');
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.equal(styles.length, 1);
  const hash = crypto.createHash('sha256').update(styles[0]).digest('base64');
  assert.ok(headers.includes(`'sha256-${hash}'`), 'update the hash in public/_headers');
  assert.ok(!/<script>/.test(html), 'no inline scripts (script-src is self only)');
  assert.match(headers, /frame-ancestors 'none'/);
});

test('enqueueAll: the same queue as enqueue one at a time, in one pass', () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const ops = Array.from({ length: 12 }, () => {
      const id = `e${rand(5)}`;
      return rand(3) ? { op: 'put', entry: { id, ts: rand(100), text: 'x' } } : { op: 'del', id };
    });
    const start = ops.slice(0, rand(6));
    let one = [];
    for (const op of start) one = T.enqueue(one, op);
    const locked = Math.min(rand(3), one.length); // ops being sent: always the queue's first ones
    let all = one.slice();
    const more = ops.slice(start.length);
    for (const op of more) one = T.enqueue(one, op, locked);
    all = T.enqueueAll(all, more, locked);
    assert.deepEqual(all, one);
  }
  const many = Array.from({ length: 20000 }, (_, i) => ({ op: 'put', entry: { id: `id${i}`, ts: i, text: 'x' } }));
  const t = Date.now();
  assert.equal(T.enqueueAll([], many, 0).length, 20000);
  assert.ok(Date.now() - t < 500, 'a long log queues quickly');
});
