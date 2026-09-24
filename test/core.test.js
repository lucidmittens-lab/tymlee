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
  assert.equal(lines[0], 'n,start,end,minutes,category,note');
  assert.equal(lines[1], '3,2026-09-24T09:00:00.000Z,2026-09-24T09:45:00.000Z,45.0,dev,fixing login bug');
  assert.equal(lines[4], '6,2026-09-24T10:05:00.000Z,,7.0,mtg,"sync, ""roadmap"""');
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
