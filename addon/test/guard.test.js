/**
 * Mid-turn edit detection — the compare-and-swap from protocol.md §Concurrency.
 *
 * Sheets gives us no ETag and no If-Match, and LockService does not cover a
 * human typing in the UI. So a write is guarded by re-hashing the region Claude
 * read, inside the same execution as the write, plus an onEdit marker for edits
 * that land outside that region.
 *
 * The subtle requirement is that the guard must be blind to *our own* writes:
 * a turn that writes twice would otherwise reject its own second op.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadAddon } = require('./fake-sheets');

function seeded() {
  const { api, ss, properties } = loadAddon();
  const s1 = ss.getSheetByName('Sheet1');
  s1.seed('A1', [
    ['Item', 'Qty'],
    ['Widget', 2],
    ['Gadget', 5],
  ]);
  return { api, ss, s1, properties };
}

/** The guard a sidebar would build after reading a region. */
function guardFrom(api, a1) {
  const c = api.getContext({ sheetName: 'Sheet1', a1 });
  return {
    sheetName: c.active.sheetName,
    a1: c.active.a1,
    hash: c.active.contextHash,
    since: c.editWatermark ? c.editWatermark.at : Date.now(),
  };
}

/** Simulate a person typing: what the onEdit simple trigger records. */
function humanTyped(api, properties, sheetName, a1, at) {
  properties.set('claude.humanEdit', JSON.stringify({ at, sheetName, a1 }));
}

// ------------------------------------------------------------- the hash check

test('an untouched region lets the write through', () => {
  const { api, s1 } = seeded();
  const res = api.applyOps({
    guard: guardFrom(api, 'A1:B3'),
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['ok']] }],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(s1.getRange('D1').getValues()[0][0], 'ok');
});

test('a cell edited inside the read region aborts the write', () => {
  const { api, s1 } = seeded();
  const guard = guardFrom(api, 'A1:B3');

  s1.seed('B2', [[999]]);   // a person types while Claude is thinking

  const res = api.applyOps({
    guard,
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['blocked']] }],
  });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'CONTEXT_STALE');
  assert.match(res.error.message, /Sheet1!A1:B3 changed/);
  assert.match(res.error.message, /Nothing was changed/);
  assert.strictEqual(s1.getRange('D1').getValues()[0][0], '', 'the write never happened');
});

test('the whole turn aborts, not just the op that noticed', () => {
  const { api, s1 } = seeded();
  const guard = guardFrom(api, 'A1:B3');
  s1.seed('A2', [['edited by a person']]);

  const res = api.applyOps({
    guard,
    ops: [
      { type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['one']] },
      { type: 'setValues', sheetName: 'Sheet1', a1: 'D2', values: [['two']] },
    ],
  });

  assert.strictEqual(res.results, undefined, 'nothing was attempted');
  assert.strictEqual(s1.getRange('D1').getValues()[0][0], '');
  assert.strictEqual(s1.getRange('D2').getValues()[0][0], '');
});

// -------------------------------------------------- blindness to our own work

test("a turn's own writes do not trip its guard", () => {
  // The failure this prevents: op 1 changes the guarded region, so op 2 sees a
  // hash mismatch caused by us and refuses to run.
  const { api, s1 } = seeded();
  let guard = guardFrom(api, 'A1:B3');

  // Deliberately writes INSIDE the guarded region — that is the only case that
  // can trip the check, and therefore the only one worth testing.
  const first = api.applyOps({
    guard,
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'B2', values: [[99]] }],
  });
  assert.strictEqual(first.ok, true);
  assert.ok(first.guard, 'a refreshed guard came back');
  assert.notStrictEqual(first.guard.hash, guard.hash, 'the region really did change');

  const second = api.applyOps({
    guard: first.guard,
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'B3', values: [[7]] }],
  });
  assert.strictEqual(second.ok, true, 'the second write is not blocked by the first');
  assert.strictEqual(s1.getRange('B3').getValues()[0][0], 7);
});

test('the refreshed guard still catches a human editing after it', () => {
  const { api, s1 } = seeded();
  const first = api.applyOps({
    guard: guardFrom(api, 'A1:B3'),
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'A2', values: [['Widget Pro']] }],
  });

  s1.seed('B3', [[42]]);   // person types after our write

  const second = api.applyOps({
    guard: first.guard,
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['nope']] }],
  });
  assert.strictEqual(second.error.code, 'CONTEXT_STALE', 'still sensitive to everyone but us');
});

// -------------------------------------------------------- the onEdit watermark

test('an edit outside the read region is caught by the watermark', () => {
  // The hash covers A1:B3 only. A person typing in Z50 is invisible to it —
  // this is exactly the gap the onEdit marker exists to close.
  const { api, s1, properties } = seeded();
  const guard = guardFrom(api, 'A1:B3');

  humanTyped(api, properties, 'Sheet1', 'Z50', guard.since + 1000);

  const res = api.applyOps({
    guard,
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['blocked']] }],
  });
  assert.strictEqual(res.error.code, 'CONTEXT_STALE');
  assert.match(res.error.message, /Sheet1!Z50/, 'says where it happened');
  assert.strictEqual(s1.getRange('D1').getValues()[0][0], '');
});

test('an edit from before the turn does not block anything', () => {
  const { api, properties } = seeded();
  humanTyped(api, properties, 'Sheet1', 'Z50', 1000);        // ancient history
  const guard = guardFrom(api, 'A1:B3');
  guard.since = 5000;

  const res = api.applyOps({
    guard,
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['fine']] }],
  });
  assert.strictEqual(res.ok, true);
});

test('a corrupt marker is ignored rather than blocking every write', () => {
  const { api, properties } = seeded();
  properties.set('claude.humanEdit', 'not json at all');
  const res = api.applyOps({
    guard: guardFrom(api, 'A1:B3'),
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['fine']] }],
  });
  assert.strictEqual(res.ok, true, 'a broken marker must not lock the user out');
});

// -------------------------------------------------------------------- corners

test('no guard means no check — reads and first writes still work', () => {
  const { api, s1 } = seeded();
  const res = api.applyOps({
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['ok']] }],
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(s1.getRange('D1').getValues()[0][0], 'ok');
});

test('a structural op leaves a guard describing the sheet as it now is', () => {
  // Deleting a row shifts everything under it, so the pre-delete hash is
  // meaningless afterwards. The refreshed guard must describe the new reality,
  // or the next write in the turn would be rejected for our own restructuring.
  const { api } = seeded();
  const before = guardFrom(api, 'A1:B3');

  const res = api.applyOps({
    guard: before,
    confirmed: ['op_s'],
    ops: [{ opId: 'op_s', type: 'deleteRows', sheetName: 'Sheet1', index: 2, count: 1 }],
  });
  assert.strictEqual(res.ok, true);
  assert.ok(res.guard, 'a guard came back');
  assert.strictEqual(res.guard.hash, guardFrom(api, 'A1:B3').hash,
    'it matches the sheet as it stands now');

  const next = api.applyOps({
    guard: res.guard,
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['after']] }],
  });
  assert.strictEqual(next.ok, true, 'the turn can keep working');
});

test('a guard naming a sheet that no longer exists fails loudly, not silently', () => {
  const { api } = seeded();
  const res = api.applyOps({
    guard: { sheetName: 'Ghost', a1: 'A1:B3', hash: 'whatever' },
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'D1', values: [['x']] }],
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'SHEET_NOT_FOUND');
});
