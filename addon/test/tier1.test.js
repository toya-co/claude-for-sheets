/**
 * Tier 1 capability parity: merge, sort, layout ops, and the widened formats.
 *
 * Same stakes as ops.test.js: the gate decides whether the user is asked before
 * content is destroyed, and the undo machinery decides whether "undoable"
 * is true. Every op here claims both; these tests hold them to it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadAddon } = require('./fake-sheets');

function seeded() {
  const ctx = loadAddon(['Sheet1', 'Sheet2']);
  ctx.s1 = ctx.ss.getSheetByName('Sheet1');
  ctx.s1.seed('A1', [
    ['Name', 'Qty', 'Price'],
    ['Widget', 4, 9.5],
    ['Gadget', 2, 19],
    ['Doohickey', 7, 3.25],
  ]);
  return ctx;
}

const apply = (api, op, confirmed) =>
  api.applyOps({ ops: [op], confirmed: confirmed || [] }).results[0];

// ------------------------------------------------------------------ merging

test('merging over content asks first; merging blank cells does not', () => {
  const { api } = seeded();

  const blocked = apply(api, { type: 'mergeCells', sheetName: 'Sheet1', a1: 'A1:C1' });
  assert.strictEqual(blocked.needsConfirmation, true);
  assert.match(blocked.reason, /merges away 2 cells/);

  const fine = apply(api, { type: 'mergeCells', sheetName: 'Sheet1', a1: 'E1:G1' });
  assert.strictEqual(fine.ok, true, 'blank cells merge without asking');
});

test('mergeAcross gates on what it actually destroys, not the whole range', () => {
  const { api } = seeded();
  // A1:C2 merged 'across' keeps col A of each row: dooms B1,C1,B2,C2 (all occupied).
  const across = apply(api, { type: 'mergeCells', sheetName: 'Sheet1', a1: 'A1:C2', mergeType: 'across' });
  assert.match(across.reason, /4 cells/);
});

test('undoing a merge restores the values it destroyed', () => {
  const { api, s1 } = seeded();
  const r = apply(api, { opId: 'op_m', type: 'mergeCells', sheetName: 'Sheet1', a1: 'A1:C1' },
    ['op_m']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s1.getRange('B1').getValues()[0][0], '', 'merge destroyed B1');
  assert.strictEqual(s1.merges.length, 1);

  assert.strictEqual(api.undoOp('op_m').ok, true);
  assert.strictEqual(s1.getRange('B1').getValues()[0][0], 'Qty', 'value came back');
  assert.strictEqual(s1.merges.length, 0, 'the merge is gone');
});

test('undoing a merge re-merges what the merge had absorbed', () => {
  const { api, s1 } = seeded();
  s1.getRange('E1:F1').merge();                       // pre-existing merge, blank cells
  apply(api, { opId: 'op_big', type: 'mergeCells', sheetName: 'Sheet1', a1: 'E1:G2' }, ['op_big']);
  assert.strictEqual(s1.merges.length, 1, 'big merge absorbed the small one');

  api.undoOp('op_big');
  assert.deepStrictEqual(
    s1.merges.map((m) => [m.row, m.col, m.rows, m.cols]),
    [[1, 5, 1, 2]],
    'the prior E1:F1 merge is back and the big one is gone');
});

test('unmerge never asks, and undo re-merges', () => {
  const { api, s1 } = seeded();
  s1.getRange('A1:C1').merge();
  const r = apply(api, { opId: 'op_u', type: 'unmergeCells', sheetName: 'Sheet1', a1: 'A1:C1' });
  assert.strictEqual(r.ok, true, 'no confirmation needed');
  assert.strictEqual(s1.merges.length, 0);

  api.undoOp('op_u');
  assert.strictEqual(s1.merges.length, 1, 'merge came back');
});

test('unmerging a range with no merges is refused as a bad payload', () => {
  const { api } = seeded();
  const r = apply(api, { type: 'unmergeCells', sheetName: 'Sheet1', a1: 'A1:C1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'BAD_PAYLOAD');
});

// ------------------------------------------------------------------ sorting

test('sorting values never asks; sorting formulas does', () => {
  const { api, s1 } = seeded();
  const plain = apply(api, { type: 'sortRange', sheetName: 'Sheet1', a1: 'A2:C4',
    by: [{ column: 'A' }] });
  assert.strictEqual(plain.ok, true, 'a value-only sort runs without asking');

  s1.seed('D2', [['=B2*C2'], ['=B3*C3'], ['=B4*C4']], 'formulas');
  const withFormulas = apply(api, { type: 'sortRange', sheetName: 'Sheet1', a1: 'A2:D4',
    by: [{ column: 'A' }] });
  assert.strictEqual(withFormulas.needsConfirmation, true);
  assert.match(withFormulas.reason, /3 formulas/);
});

test('sort actually sorts, and undo restores the original order', () => {
  const { api, s1 } = seeded();
  apply(api, { opId: 'op_s', type: 'sortRange', sheetName: 'Sheet1', a1: 'A2:C4',
    by: [{ column: 1 }] });
  assert.deepStrictEqual(
    s1.getRange('A2:A4').getValues().map((r) => r[0]),
    ['Doohickey', 'Gadget', 'Widget']);

  api.undoOp('op_s');
  assert.deepStrictEqual(
    s1.getRange('A2:A4').getValues().map((r) => r[0]),
    ['Widget', 'Gadget', 'Doohickey'], 'original order came back');
});

test('descending sort and letter columns both resolve', () => {
  const { api, s1 } = seeded();
  apply(api, { type: 'sortRange', sheetName: 'Sheet1', a1: 'A2:C4',
    by: [{ column: 'B', ascending: false }] });
  assert.deepStrictEqual(
    s1.getRange('B2:B4').getValues().map((r) => r[0]), [7, 4, 2]);
});

test('a sort column outside the range is refused before anything runs', () => {
  const { api } = seeded();
  const r = apply(api, { type: 'sortRange', sheetName: 'Sheet1', a1: 'A2:C4',
    by: [{ column: 'F' }] });
  assert.strictEqual(r.error.code, 'BAD_PAYLOAD');
});

// ------------------------------------------------------------------ layout

test('column width applies per column and undoes to prior widths', () => {
  const { api, s1 } = seeded();
  s1.setColumnWidth(2, 150);                    // B already customized
  const r = apply(api, { opId: 'op_w', type: 'setColumnWidth', sheetName: 'Sheet1',
    index: 1, count: 3, width: 200 });
  assert.strictEqual(r.ok, true, 'never gated');
  assert.strictEqual(s1.getColumnWidth(2), 200);

  api.undoOp('op_w');
  assert.strictEqual(s1.getColumnWidth(1), 100, 'default width restored');
  assert.strictEqual(s1.getColumnWidth(2), 150, 'customized width restored, not defaulted');
});

test('freeze panes applies and undoes to the prior freeze', () => {
  const { api, s1 } = seeded();
  s1.setFrozenRows(1);
  apply(api, { opId: 'op_f', type: 'freezePanes', sheetName: 'Sheet1', rows: 2, cols: 1 });
  assert.strictEqual(s1.getFrozenRows(), 2);
  assert.strictEqual(s1.getFrozenColumns(), 1);

  api.undoOp('op_f');
  assert.strictEqual(s1.getFrozenRows(), 1);
  assert.strictEqual(s1.getFrozenColumns(), 0);
});

test('hiding rows records which were already hidden, and undo is exact', () => {
  const { api, s1 } = seeded();
  s1.hideRows(3, 1);                            // row 3 hidden by the user beforehand
  apply(api, { opId: 'op_h', type: 'hideRows', sheetName: 'Sheet1', index: 2, count: 3 });
  assert.ok(s1.isRowHiddenByUser(2) && s1.isRowHiddenByUser(4));

  api.undoOp('op_h');
  assert.ok(!s1.isRowHiddenByUser(2), 'row 2 visible again');
  assert.ok(s1.isRowHiddenByUser(3), 'row 3 stays hidden — it was hidden before the op');
  assert.ok(!s1.isRowHiddenByUser(4), 'row 4 visible again');
});

test('hiding the last visible sheet is refused', () => {
  const { api, ss } = seeded();
  ss.getSheetByName('Sheet2').hideSheet();
  const r = apply(api, { type: 'hideSheet', sheetName: 'Sheet1' });
  assert.strictEqual(r.error.code, 'LAST_SHEET');
});

test('hide sheet, undo, and the visibility round-trips', () => {
  const { api, ss } = seeded();
  apply(api, { opId: 'op_v', type: 'hideSheet', sheetName: 'Sheet2' });
  assert.ok(ss.getSheetByName('Sheet2').isSheetHidden());
  api.undoOp('op_v');
  assert.ok(!ss.getSheetByName('Sheet2').isSheetHidden());
});

// ------------------------------------------------------------------ rename

test('rename keeps the whole history usable, and undoes cleanly', () => {
  const { api, ss, s1 } = seeded();

  // An edit BEFORE the rename…
  apply(api, { opId: 'op_before', type: 'setValues', sheetName: 'Sheet1', a1: 'E5',
    values: [['x']] });

  // …then the rename. The stored entry must follow the sheet to its new name.
  apply(api, { opId: 'op_r', type: 'renameSheet', sheetName: 'Sheet1', newName: 'Data' });
  assert.strictEqual(ss.getSheetByName('Data'), s1);
  assert.strictEqual(api.getHistory().find((e) => e.opId === 'op_before').sheetName, 'Data',
    'earlier entries were rewritten to the new name');

  // The pre-rename edit undoes fine — its snapshot lands on the renamed sheet.
  assert.strictEqual(api.undoOp('op_before').ok, true);
  assert.strictEqual(s1.getRange('E5').getValues()[0][0], '');

  // And undoing the rename itself rewrites everything back.
  assert.strictEqual(api.undoOp('op_r').ok, true);
  assert.strictEqual(s1.getName(), 'Sheet1');
  assert.strictEqual(api.getHistory().find((e) => e.opId === 'op_before').sheetName, 'Sheet1');
});

test('renaming to a taken name or to the history sheet is refused', () => {
  const { api } = seeded();
  const taken = apply(api, { type: 'renameSheet', sheetName: 'Sheet1', newName: 'Sheet2' });
  assert.strictEqual(taken.error.code, 'SHEET_EXISTS');

  const protectedName = apply(api, { type: 'renameSheet', sheetName: 'Sheet1',
    newName: '__claude_history__' });
  assert.strictEqual(protectedName.error.code, 'PROTECTED_SHEET');
});

// ------------------------------------------------------- conflict planes

test('a layout undo is refused when a later same-kind edit overlaps', () => {
  const { api } = seeded();
  apply(api, { opId: 'op_w1', type: 'setColumnWidth', sheetName: 'Sheet1', index: 2, width: 150 });
  apply(api, { opId: 'op_w2', type: 'setColumnWidth', sheetName: 'Sheet1', index: 2, width: 250 });

  const refused = api.undoOp('op_w1');
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.code, 'BLOCKED_BY_LATER_EDIT');
});

test('layout edits and value edits never block each other', () => {
  const { api, s1 } = seeded();
  apply(api, { opId: 'op_val', type: 'setValues', sheetName: 'Sheet1', a1: 'B2',
    values: [['5']] }, []);
  apply(api, { opId: 'op_wid', type: 'setColumnWidth', sheetName: 'Sheet1', index: 2, width: 300 });

  // The later width change does not block undoing the earlier value write…
  assert.strictEqual(api.undoOp('op_val').ok, true, 'value undo unblocked by layout');
  assert.strictEqual(s1.getRange('B2').getValues()[0][0], 4);
  // …and the width op undoes independently.
  assert.strictEqual(api.undoOp('op_wid').ok, true);
});

test('a structural op still blocks layout undo on its sheet', () => {
  const { api } = seeded();
  apply(api, { opId: 'op_w', type: 'setColumnWidth', sheetName: 'Sheet1', index: 2, width: 300 });
  apply(api, { opId: 'op_ins', type: 'insertColumns', sheetName: 'Sheet1', index: 1, count: 1 });

  const refused = api.undoOp('op_w');
  assert.strictEqual(refused.ok, false, 'columns shifted; width index no longer means the same');
  assert.strictEqual(refused.code, 'BLOCKED_BY_LATER_EDIT');
});

test('a merge undo is refused when a later write overlaps its rectangle', () => {
  const { api } = seeded();
  apply(api, { opId: 'op_m', type: 'mergeCells', sheetName: 'Sheet1', a1: 'E1:G1' });
  apply(api, { opId: 'op_v', type: 'setValues', sheetName: 'Sheet1', a1: 'F1',
    values: [['later']] });

  const refused = api.undoOp('op_m');
  assert.strictEqual(refused.ok, false, 'undoing the merge would eat the later write');
});

// -------------------------------------------------------- widened formats

test('the new format properties apply and undo, including italic', () => {
  const { api, s1 } = seeded();
  apply(api, { opId: 'op_fmt', type: 'setFormats', sheetName: 'Sheet1', a1: 'A1:C1',
    format: { fontSize: 14, fontFamily: 'Roboto', wrap: true, verticalAlign: 'middle',
              fontLine: 'underline', italic: true } });

  assert.strictEqual(s1.getRange('A1').getFontSizes()[0][0], 14);
  assert.strictEqual(s1.getRange('A1').getFontFamilies()[0][0], 'Roboto');
  assert.strictEqual(s1.getRange('A1').getWraps()[0][0], true);
  assert.strictEqual(s1.getRange('A1').getFontLines()[0][0], 'underline');
  assert.strictEqual(s1.getRange('A1').getFontStyles()[0][0], 'italic');

  api.undoOp('op_fmt');
  assert.strictEqual(s1.getRange('A1').getFontSizes()[0][0], 10, 'size restored');
  assert.strictEqual(s1.getRange('A1').getFontStyles()[0][0], 'normal',
    'italic restored — fontStyles is snapshot-captured now');
  assert.strictEqual(s1.getRange('A1').getWraps()[0][0], false, 'wrap restored');
});

// ------------------------------------------------------------- protection

test('every new op type respects the protected history sheet', () => {
  const { api } = seeded();
  for (const op of [
    { type: 'mergeCells', sheetName: '__claude_history__', a1: 'A1:B1' },
    { type: 'sortRange', sheetName: '__claude_history__', a1: 'A1:B2', by: [{ column: 1 }] },
    { type: 'setColumnWidth', sheetName: '__claude_history__', index: 1, width: 100 },
    { type: 'renameSheet', sheetName: '__claude_history__', newName: 'x' },
    { type: 'hideSheet', sheetName: '__claude_history__' },
  ]) {
    const r = apply(api, op);
    assert.strictEqual(r.error && r.error.code, 'PROTECTED_SHEET', op.type + ' is blocked');
  }
});

// ---------------------------------------------------------------- context

test('reads report merged blocks so the model can see them', () => {
  const { api, s1 } = seeded();
  s1.getRange('A1:C1').merge();
  const ctx = api.getContext({ sheetName: 'Sheet1', a1: 'A1:D4' });
  assert.deepStrictEqual(ctx.active.merges, ['A1:C1']);
});
