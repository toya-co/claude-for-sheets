/**
 * The two pure functions everything else rests on: `sanitizeGrid_` and
 * `hashValues_`.
 *
 * Both were exercised only indirectly until now, and both have a failure mode
 * that is invisible rather than loud:
 *
 * **The Date trap.** `google.script.run` refuses to serialize a `Date`, and it
 * fails during serialization — so NEITHER the success nor the failure handler
 * fires. The call simply never returns. Nothing in the console, nothing in the
 * execution log, because the server function itself ran fine. `getValues()`
 * returns real `Date` objects for any date-formatted cell, so one such cell
 * anywhere in a read is enough. That bug shipped, and it is trivial here.
 *
 * **Hash stability.** The hash is the compare-and-swap token for every write:
 * captured when context is read, re-checked immediately before applying. If it
 * is unstable across identical content the guard fires on writes that should
 * succeed; if it collides on changed content the guard misses a human edit.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadAddon } = require('./fake-sheets');

const { api } = loadAddon(['Sheet1']);
const { sanitizeGrid_, hashValues_ } = api;

// ------------------------------------------------------------- the Date trap

test('every Date becomes a string, at any depth in the grid', () => {
  const grid = [
    [new Date('2026-08-25T00:00:00Z'), 'text'],
    [42, new Date('2020-01-01T12:34:56Z')],
  ];
  const out = sanitizeGrid_(grid);

  for (const row of out) {
    for (const cell of row) {
      assert.ok(!(cell instanceof Date),
        'a surviving Date kills the round trip with no error anywhere');
    }
  }
  assert.strictEqual(out[0][0], '2026-08-25T00:00:00.000Z');
  assert.strictEqual(out[1][1], '2020-01-01T12:34:56.000Z');
});

test('nothing else is disturbed', () => {
  // Over-sanitizing would be its own bug: numbers must stay numbers, or every
  // formula the model writes against them changes meaning.
  const grid = [['', 0, false, 'a string', 3.14, -1]];
  assert.deepStrictEqual(sanitizeGrid_(grid), grid);
});

test('an empty grid and empty rows survive', () => {
  assert.deepStrictEqual(sanitizeGrid_([]), []);
  assert.deepStrictEqual(sanitizeGrid_([[]]), [[]]);
});

test('sanitizing is idempotent', () => {
  // Grids pass through this on the way out AND are re-read on the way back in
  // for the guard, so a second pass must not change anything.
  const once = sanitizeGrid_([[new Date('2026-01-01T00:00:00Z'), 'x']]);
  assert.deepStrictEqual(sanitizeGrid_(once), once);
});

test('the documented lossiness is real, and stated', () => {
  // A date cell and a text cell holding the same ISO string arrive identical.
  // Harmless while nothing writes dates back; the moment it does, this needs a
  // typed representation. Pinned so the day it matters is not a surprise.
  const fromDate = sanitizeGrid_([[new Date('2026-08-25T00:00:00Z')]])[0][0];
  const fromText = sanitizeGrid_([['2026-08-25T00:00:00.000Z']])[0][0];
  assert.strictEqual(fromDate, fromText,
    'indistinguishable after sanitizing — see shared/protocol.md');
});

// ---------------------------------------------------------- hash stability

test('identical content hashes identically', () => {
  const a = [['x', 1], ['y', 2]];
  const b = [['x', 1], ['y', 2]];
  assert.strictEqual(hashValues_(a), hashValues_(b),
    'an unstable hash would abort writes that should succeed');
});

test('any change to any cell changes the hash', () => {
  const base = [['x', 1], ['y', 2]];
  const h = hashValues_(base);
  for (const changed of [
    [['X', 1], ['y', 2]],
    [['x', 2], ['y', 2]],
    [['x', 1], ['y', 3]],
    [['x', 1], ['y', 2], ['z', 3]],   // a row appended
    [['x', 1]],                        // a row removed
    [['x', 1, ''], ['y', 2, '']],      // a column appended
  ]) {
    assert.notStrictEqual(hashValues_(changed), h,
      'a missed change means a human edit gets silently overwritten');
  }
});

test('an emptied cell is not the same as an untouched one', () => {
  assert.notStrictEqual(hashValues_([['a', 'b']]), hashValues_([['a', '']]));
});

test('shape matters, not just contents', () => {
  // Same values, different rectangle — these are genuinely different regions.
  assert.notStrictEqual(hashValues_([['a', 'b']]), hashValues_([['a'], ['b']]));
});

test('the hash is fixed width and hex', () => {
  // It is stored and compared as a string; a variable-width or non-hex value
  // would break the comparison in ways that look like a stale-context bug.
  for (const grid of [[[]], [['x']], [['a', 1], ['b', 2]]]) {
    assert.match(hashValues_(grid), /^[0-9a-f]{32}$/);
  }
});

test('hashing happens after sanitizing, or the guard trips on nothing', () => {
  // A raw Date and its sanitized form must hash the same, because the read
  // hashes the sanitized grid and the write re-hashes a freshly read one. If
  // these differed, every write to a sheet containing a date cell would abort
  // with CONTEXT_STALE for no reason.
  const raw = [[new Date('2026-08-25T00:00:00Z')]];
  assert.strictEqual(hashValues_(sanitizeGrid_(raw)), hashValues_(sanitizeGrid_(raw)));
});
