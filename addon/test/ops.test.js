/**
 * Multi-op execution, the confirmation gate, and undo overlap.
 *
 * Runs the real .gs files against a fake SpreadsheetApp (see fake-sheets.js).
 * These are the paths where being wrong is expensive and a live sheet is a bad
 * test rig: the gate decides whether a user is warned before their data is
 * overwritten, and the overlap check decides whether an undo quietly reverts an
 * edit that came after it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadAddon } = require('./fake-sheets');

/** A sheet with a header row, some data, and a formula in D2. */
function seeded() {
  const { api, ss } = loadAddon();
  const s1 = ss.getSheetByName('Sheet1');
  s1.seed('A1', [
    ['Item', 'Qty', 'Price', 'Total'],
    ['Widget', 2, 3.5, ''],
    ['Gadget', 5, 1.25, ''],
  ]);
  s1.seed('D2', [['=B2*C2'], ['=B3*C3']], 'formulas');
  return { api, ss, s1 };
}

// ------------------------------------------------------------ multi-op turns

test('a turn applies its ops in order, each with its own history entry', () => {
  const { api, s1 } = seeded();

  const res = api.applyOps({ ops: [
    { type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['Notes']] },
    { type: 'setValues', sheetName: 'Sheet1', a1: 'F2', values: [['first']] },
  ] });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.results.length, 2);
  assert.strictEqual(s1.getRange('F1').getValues()[0][0], 'Notes');
  assert.strictEqual(s1.getRange('F2').getValues()[0][0], 'first');

  const history = api.getHistory();
  assert.strictEqual(history.length, 2, 'one entry per op, not one per turn');
  assert.notStrictEqual(history[0].opId, history[1].opId);
  assert.strictEqual(history[0].turnId, history[1].turnId, 'grouped by turn');
});

test('each op in a turn can be undone on its own', () => {
  const { api, s1 } = seeded();
  api.applyOps({ ops: [
    { type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['keep']] },
    { type: 'setValues', sheetName: 'Sheet1', a1: 'G1', values: [['drop']] },
  ] });

  const dropEntry = api.getHistory().find((h) => h.target.indexOf('G1') !== -1);
  const res = api.undoOp(dropEntry.opId);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(s1.getRange('G1').getValues()[0][0], '', 'the undone op reverted');
  assert.strictEqual(s1.getRange('F1').getValues()[0][0], 'keep', 'the other op stands');
});

test('a turn stops at the first failure instead of pressing on', () => {
  const { api, s1 } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['ok']] },
    { type: 'teleport', sheetName: 'Sheet1', a1: 'F2' },
    { type: 'setValues', sheetName: 'Sheet1', a1: 'F3', values: [['never']] },
  ] });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.results.length, 2, 'the third op was not attempted');
  assert.strictEqual(res.results[1].error.code, 'NOT_IMPLEMENTED');
  assert.strictEqual(s1.getRange('F3').getValues()[0][0], '');
  assert.strictEqual(s1.getRange('F1').getValues()[0][0], 'ok', 'earlier work stands');
});

// -------------------------------------------------------- the confirmation gate

test('writing into empty cells does not ask', () => {
  const { api } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['fresh']] },
  ] });
  assert.strictEqual(res.ok, true);
  assert.ok(!res.results[0].needsConfirmation);
});

test('overwriting a formula always asks, even for a single cell', () => {
  // Replacing a formula with its own current value looks like nothing changed
  // and destroys the thing that computed it. Count is irrelevant here.
  const { api, s1 } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'setValues', sheetName: 'Sheet1', a1: 'D2', values: [[7]] },
  ] });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.results[0].needsConfirmation, true);
  assert.match(res.results[0].reason, /formula/);
  assert.strictEqual(s1.getRange('D2').getFormulas()[0][0], '=B2*C2', 'nothing was written');
});

test('a small overwrite of plain values does not ask', () => {
  const { api } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'setValues', sheetName: 'Sheet1', a1: 'A1', values: [['Product']] },
  ] });
  assert.strictEqual(res.ok, true, 'a one-cell typo fix is not a confirmation-worthy event');
});

test('overwriting more than the threshold of occupied cells asks', () => {
  const { api, ss } = loadAddon();
  const s1 = ss.getSheetByName('Sheet1');
  const column = [];
  for (let i = 0; i < 20; i++) column.push(['row ' + i]);
  s1.seed('A1', column);

  const res = api.applyOps({ ops: [
    { type: 'setValues', sheetName: 'Sheet1', a1: 'A1', values: column.map(() => ['x']) },
  ] });

  assert.strictEqual(res.results[0].needsConfirmation, true);
  assert.match(res.results[0].reason, /20 cells/);
  assert.strictEqual(s1.getRange('A1').getValues()[0][0], 'row 0', 'nothing was written');
});

test('clear asks whenever it would remove anything', () => {
  const { api } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'clear', sheetName: 'Sheet1', a1: 'A1:B2', what: 'values' },
  ] });
  assert.strictEqual(res.results[0].needsConfirmation, true);
  assert.match(res.results[0].reason, /clears/);
});

test('clearing an empty range does not ask', () => {
  const { api } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'clear', sheetName: 'Sheet1', a1: 'Z90:Z95', what: 'values' },
  ] });
  assert.strictEqual(res.ok, true);
});

test('formatting is never gated — it destroys no content', () => {
  const { api, s1 } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'setFormats', sheetName: 'Sheet1', a1: 'A1:D3',
      format: { bold: true, background: '#eeeeee' } },
  ] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(s1.getRange('A1').getFontWeights()[0][0], 'bold');
});

test('confirming names one op, and does not wave through the next one', () => {
  const { api, s1 } = seeded();
  const gated = { opId: 'op_a', type: 'setValues', sheetName: 'Sheet1', a1: 'D2', values: [[7]] };
  const alsoGated = { opId: 'op_b', type: 'setValues', sheetName: 'Sheet1', a1: 'D3', values: [[9]] };

  const res = api.applyOps({ ops: [gated, alsoGated], confirmed: ['op_a'] });

  assert.strictEqual(res.results[0].ok, true, 'the confirmed op ran');
  assert.strictEqual(s1.getRange('D2').getValues()[0][0], 7);
  assert.strictEqual(res.results[1].needsConfirmation, true, 'the other op still asks');
  assert.strictEqual(s1.getRange('D3').getFormulas()[0][0], '=B3*C3');
});

test('the gate is re-checked at apply time, not trusted from inspection', () => {
  // inspectOps() is a UI convenience. What governs is the check inside applyOps,
  // which runs against the sheet as it is now.
  const { api, s1 } = seeded();
  const inspected = api.inspectOps([
    { type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['later']] },
  ]);
  assert.strictEqual(inspected[0].destructive, false, 'empty when inspected');

  s1.seed('F1', [['someone typed here']]);
  s1.seed('F1', [['=NOW()']], 'formulas');

  const res = api.applyOps({ ops: [
    { type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['later']] },
  ] });
  assert.strictEqual(res.results[0].needsConfirmation, true, 'gated on current state');
});

// ------------------------------------------------------------------- the guard

test('a stale guard aborts the whole turn before anything is written', () => {
  const { api, s1 } = seeded();
  const context = api.getContext({ sheetName: 'Sheet1', a1: 'A1:D3' });
  const guard = { sheetName: 'Sheet1', a1: 'A1:D3', hash: context.active.contextHash };

  s1.seed('B2', [['someone typed this mid-turn']]);

  const res = api.applyOps({
    guard,
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['blocked']] }],
  });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'CONTEXT_STALE');
  assert.strictEqual(s1.getRange('F1').getValues()[0][0], '', 'nothing was applied');
});

test('an unchanged guard lets the turn through', () => {
  const { api, s1 } = seeded();
  const context = api.getContext({ sheetName: 'Sheet1', a1: 'A1:D3' });

  const res = api.applyOps({
    guard: { sheetName: 'Sheet1', a1: 'A1:D3', hash: context.active.contextHash },
    ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['fine']] }],
  });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(s1.getRange('F1').getValues()[0][0], 'fine');
});

// ---------------------------------------------------------------- undo overlap

test('undoing an earlier op that a later op overlaps is refused', () => {
  const { api, s1 } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['first'], ['second']] }] });
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F2', values: [['later']] }] });

  const history = api.getHistory();
  const earlier = history[history.length - 1];   // index is newest-first

  const res = api.undoOp(earlier.opId);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'BLOCKED_BY_LATER_EDIT');
  assert.strictEqual(res.blockers.length, 1);
  assert.strictEqual(s1.getRange('F2').getValues()[0][0], 'later', 'the later edit survives');
});

test('force undoes anyway, which is the point of offering it', () => {
  const { api, s1 } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['first'], ['second']] }] });
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F2', values: [['later']] }] });

  const history = api.getHistory();
  const earlier = history[history.length - 1];

  const res = api.undoOp(earlier.opId, true);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(s1.getRange('F2').getValues()[0][0], '', 'the later edit went with it, as warned');
});

test('a disjoint later edit does not block an undo', () => {
  const { api, s1 } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['first']] }] });
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'H8', values: [['elsewhere']] }] });

  const history = api.getHistory();
  const res = api.undoOp(history[history.length - 1].opId);

  assert.strictEqual(res.ok, true, 'the normal case stays frictionless');
  assert.strictEqual(s1.getRange('H8').getValues()[0][0], 'elsewhere');
});

test('an already-undone later edit stops blocking', () => {
  const { api } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['first'], ['second']] }] });
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F2', values: [['later']] }] });

  const history = api.getHistory();
  api.undoOp(history[0].opId);                       // undo the later one first
  const res = api.undoOp(history[history.length - 1].opId);

  assert.strictEqual(res.ok, true, 'walking back in reverse order just works');
});

test('an op on another sheet never blocks', () => {
  const { api } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['one']] }] });
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet2', a1: 'F1', values: [['two']] }] });

  const history = api.getHistory();
  assert.strictEqual(api.undoOp(history[history.length - 1].opId).ok, true);
});

test('undoing twice is refused rather than restoring a stale snapshot', () => {
  const { api } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['one']] }] });
  const entry = api.getHistory()[0];

  assert.strictEqual(api.undoOp(entry.opId).ok, true);
  assert.throws(() => api.undoOp(entry.opId), /already been undone/);
});

// ------------------------------------------------------------------ snapshots

test('undo restores formulas and formatting, not just values', () => {
  const { api, s1 } = seeded();
  s1.seed('F1', [['=1+1']], 'formulas');
  s1.seed('F1', [['#ff0000']], 'backgrounds');

  api.applyOps({
    confirmed: ['op_x'],
    ops: [{ opId: 'op_x', type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['plain']] }],
  });
  assert.strictEqual(s1.getRange('F1').getValues()[0][0], 'plain');

  api.undoOp('op_x');
  assert.strictEqual(s1.getRange('F1').getFormulas()[0][0], '=1+1', 'formula came back');
  assert.strictEqual(s1.getRange('F1').getBackgrounds()[0][0], '#ff0000', 'formatting came back');
});
