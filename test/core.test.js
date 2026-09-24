const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../core.js');

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
});

test('totals are clipped to the window and grouped by category', () => {
  const entries = [
    { ts: 0, text: 'dev a' },
    { ts: 100, text: 'lunch' },
    { ts: 200, text: 'DEV b' },
  ];
  assert.deepEqual(T.totalsByCategory(entries, 50, 1000, 300), [
    { category: 'DEV', ms: 150 },
    { category: 'lunch', ms: 100 },
  ]);
});

test('formatDuration', () => {
  assert.equal(T.formatDuration(5000), '5s');
  assert.equal(T.formatDuration(65000), '1m 05s');
  assert.equal(T.formatDuration(3723000), '1h 02m');
});
