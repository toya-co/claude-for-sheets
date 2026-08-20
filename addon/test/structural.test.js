/**
 * Structural ops: inserts, deletes, tabs — and their undo.
 *
 * These change the coordinate space, which is why a value snapshot cannot
 * invert them: undo runs a stored inverse op instead, refilling from a snapshot
 * where one was taken. The other thing under test is the honesty rule — a
 * structural op conflicts with EVERYTHING on its sheet for undo purposes,
 * because it shifted the coordinates every other entry's range was recorded in.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadAddon } = require('./fake-sheets');

/** Item/Qty/Price rows with a formula column, on Sheet1. */
function seeded() {
  const { api, ss } = loadAddon();
  const s1 = ss.getSheetByName('Sheet1');
  s1.seed('A1', [
    ['Item', 'Qty', 'Price'],
    ['Widget', 2, 3.5],
    ['Gadget', 5, 1.25],
    ['Sprocket', 3, 9.99],
  ]);
  s1.seed('D2', [['=B2*C2'], ['=B3*C3'], ['=B4*C4']], 'formulas');
  return { api, ss, s1 };
}

const grid = (sheet, a1) => sheet.getRange(a1).getValues();

// -------------------------------------------------------------------- inserts

test('inserting rows shifts data down and never asks', () => {
  const { api, s1 } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'insertRows', sheetName: 'Sheet1', index: 2, count: 2 },
  ] });

  assert.strictEqual(res.ok, true);
  assert.ok(!res.results[0].needsConfirmation, 'inserts destroy nothing');
  assert.strictEqual(grid(s1, 'A1')[0][0], 'Item', 'header stays');
  assert.strictEqual(grid(s1, 'A2')[0][0], '', 'inserted rows are blank');
  assert.strictEqual(grid(s1, 'A4')[0][0], 'Widget', 'data moved down by 2');
});

test('undoing an insert deletes the inserted rows and restores the layout', () => {
  const { api, s1 } = seeded();
  api.applyOps({ ops: [{ type: 'insertRows', sheetName: 'Sheet1', index: 2, count: 2 }] });
  const entry = api.getHistory()[0];
  assert.strictEqual(entry.restorable, true, 'no payload needed, still undoable');

  const res = api.undoOp(entry.opId);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(grid(s1, 'A2')[0][0], 'Widget', 'layout is back');
});

test('inserting columns shifts data right', () => {
  const { api, s1 } = seeded();
  api.applyOps({ ops: [{ type: 'insertColumns', sheetName: 'Sheet1', index: 2, count: 1 }] });
  assert.strictEqual(grid(s1, 'A1')[0][0], 'Item');
  assert.strictEqual(grid(s1, 'B1')[0][0], '', 'new blank column at B');
  assert.strictEqual(grid(s1, 'C1')[0][0], 'Qty', 'old B moved to C');
});

// -------------------------------------------------------------------- deletes

test('deleting rows that hold content asks first, and nothing moves', () => {
  const { api, s1 } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'deleteRows', sheetName: 'Sheet1', index: 3, count: 1 },
  ] });

  assert.strictEqual(res.results[0].needsConfirmation, true);
  assert.match(res.results[0].reason, /deletes 1 row holding/);
  assert.strictEqual(grid(s1, 'A3')[0][0], 'Gadget', 'nothing was deleted');
});

test('deleting empty rows does not ask', () => {
  const { api } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'deleteRows', sheetName: 'Sheet1', index: 50, count: 3 },
  ] });
  assert.strictEqual(res.ok, true);
});

test('a confirmed row delete applies, and undo puts everything back', () => {
  const { api, s1 } = seeded();
  s1.seed('A3', [['#ffff00']], 'backgrounds');   // formatting must survive the round trip

  const gated = { opId: 'op_del', type: 'deleteRows', sheetName: 'Sheet1', index: 3, count: 1 };
  const res = api.applyOps({ ops: [gated], confirmed: ['op_del'] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(grid(s1, 'A3')[0][0], 'Sprocket', 'row below moved up');

  const undo = api.undoOp('op_del');
  assert.strictEqual(undo.ok, true);
  assert.strictEqual(grid(s1, 'A3')[0][0], 'Gadget', 'deleted row is back');
  assert.strictEqual(grid(s1, 'A4')[0][0], 'Sprocket', 'later rows shifted back down');
  assert.strictEqual(s1.getRange('D3').getFormulas()[0][0], '=B3*C3', 'formula restored');
  assert.strictEqual(s1.getRange('A3').getBackgrounds()[0][0], '#ffff00', 'formatting restored');
});

test('a confirmed column delete applies and undoes cleanly', () => {
  const { api, s1 } = seeded();
  const gated = { opId: 'op_delc', type: 'deleteColumns', sheetName: 'Sheet1', index: 2, count: 1 };
  api.applyOps({ ops: [gated], confirmed: ['op_delc'] });
  assert.strictEqual(grid(s1, 'B1')[0][0], 'Price', 'columns shifted left');

  api.undoOp('op_delc');
  assert.strictEqual(grid(s1, 'B1')[0][0], 'Qty', 'column is back');
  assert.strictEqual(grid(s1, 'B3')[0][0], 5, 'with its data');
});

// ----------------------------------------------------------------------- tabs

test('adding a sheet never asks; undo removes it; duplicate names refuse', () => {
  const { api, ss } = seeded();
  const res = api.applyOps({ ops: [{ type: 'addSheet', name: 'Summary' }] });
  assert.strictEqual(res.ok, true);
  assert.ok(ss.getSheetByName('Summary'));

  const dup = api.applyOps({ ops: [{ type: 'addSheet', name: 'Summary' }] });
  assert.strictEqual(dup.results[0].error.code, 'SHEET_EXISTS');

  api.undoOp(res.results[0].opId);
  assert.strictEqual(ss.getSheetByName('Summary'), null, 'undo deleted it');
});

test('deleting a sheet always asks, even an empty one', () => {
  const { api } = seeded();
  const res = api.applyOps({ ops: [{ type: 'deleteSheet', sheetName: 'Sheet2' }] });
  assert.strictEqual(res.results[0].needsConfirmation, true);
  assert.match(res.results[0].reason, /deletes the sheet 'Sheet2'/);
});

test('a confirmed sheet delete undoes with contents and position intact', () => {
  const { api, ss } = seeded();
  const s2 = ss.getSheetByName('Sheet2');
  s2.seed('A1', [['keep', 'this'], ['data', 'safe']]);

  const gated = { opId: 'op_dels', type: 'deleteSheet', sheetName: 'Sheet2' };
  api.applyOps({ ops: [gated], confirmed: ['op_dels'] });
  assert.strictEqual(ss.getSheetByName('Sheet2'), null, 'gone');

  api.undoOp('op_dels');
  const back = ss.getSheetByName('Sheet2');
  assert.ok(back, 'recreated');
  assert.strictEqual(back.getIndex(), 2, 'at its old position');
  assert.deepStrictEqual(grid(back, 'A1:B2'), [['keep', 'this'], ['data', 'safe']]);
});

test('the last real sheet cannot be deleted', () => {
  const { api } = loadAddon(['Only']);
  const res = api.applyOps({ ops: [{ type: 'deleteSheet', sheetName: 'Only' }] });
  assert.strictEqual(res.results[0].error.code, 'LAST_SHEET');
});

test('the history sheet is protected from every op type', () => {
  const { api } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['x']] }] });   // creates it
  for (const op of [
    { type: 'deleteSheet', sheetName: '__claude_history__' },
    { type: 'clear', sheetName: '__claude_history__', a1: 'A1:C10' },
    { type: 'deleteRows', sheetName: '__claude_history__', index: 1, count: 5 },
  ]) {
    const res = api.applyOps({ ops: [op] });
    assert.strictEqual(res.results[0].error.code, 'PROTECTED_SHEET', op.type);
  }
});

// ------------------------------------------------- the coordinate-shift rule

test('a structural op blocks undo of every earlier entry on its sheet', () => {
  const { api } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['note']] }] });
  api.applyOps({ ops: [{ type: 'insertRows', sheetName: 'Sheet1', index: 1, count: 1 }] });

  const history = api.getHistory();
  const valueEntry = history.find((h) => h.type === 'setValues');
  const res = api.undoOp(valueEntry.opId);

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'BLOCKED_BY_LATER_EDIT');
  assert.match(res.message, /overlap/i);
});

test('later edits on the same sheet block undoing a structural op', () => {
  const { api } = seeded();
  api.applyOps({ ops: [{ type: 'insertRows', sheetName: 'Sheet1', index: 1, count: 1 }] });
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'A1', values: [['typed after']] }] });

  const history = api.getHistory();
  const insertEntry = history.find((h) => h.type === 'insertRows');
  assert.strictEqual(api.undoOp(insertEntry.opId).ok, false, 'blocked');
  assert.strictEqual(api.undoOp(insertEntry.opId, true).ok, true, 'force overrides');
});

test('structural ops on another sheet never block', () => {
  const { api } = seeded();
  api.applyOps({ ops: [{ type: 'setValues', sheetName: 'Sheet1', a1: 'F1', values: [['note']] }] });
  api.applyOps({ ops: [{ type: 'insertRows', sheetName: 'Sheet2', index: 1, count: 1 }] });

  const valueEntry = api.getHistory().find((h) => h.type === 'setValues');
  assert.strictEqual(api.undoOp(valueEntry.opId).ok, true, 'different coordinate spaces');
});

test('walking a structural turn back in reverse order works end to end', () => {
  const { api, s1 } = seeded();
  const res = api.applyOps({ ops: [
    { type: 'insertRows', sheetName: 'Sheet1', index: 5 },
    { type: 'setValues', sheetName: 'Sheet1', a1: 'A5', values: [['TOTAL']] },
  ] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(grid(s1, 'A5')[0][0], 'TOTAL');

  // Newest first: undo the write, then the insert — each unblocks the next.
  const [writeEntry, insertEntry] = api.getHistory();
  assert.strictEqual(api.undoOp(writeEntry.opId).ok, true);
  assert.strictEqual(api.undoOp(insertEntry.opId).ok, true);
  assert.strictEqual(grid(s1, 'A5')[0][0], '', 'sheet is back to seeded state');
  assert.strictEqual(grid(s1, 'A4')[0][0], 'Sprocket');
});
