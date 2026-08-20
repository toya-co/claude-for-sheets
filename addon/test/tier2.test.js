/**
 * Tier 2 capability parity: borders, validation, conditional formats, notes,
 * named ranges, duplicate sheet.
 *
 * The novel machinery here is the Advanced Sheets service seam — borders and
 * conditional-format rules round-trip through API-shaped JSON because
 * SpreadsheetApp can write both but read neither back. The fake serves that
 * JSON from its own state, so the parsing and restore paths run for real.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadAddon } = require('./fake-sheets');

function seeded() {
  const ctx = loadAddon(['Sheet1', 'Sheet2']);
  ctx.s1 = ctx.ss.getSheetByName('Sheet1');
  ctx.s1.seed('A1', [
    ['Region', 'Units'],
    ['West', 42],
    ['East', 17],
  ]);
  return ctx;
}

const j = (x) => JSON.parse(JSON.stringify(x));   // vm-realm objects vs deepStrictEqual

const apply = (api, op, confirmed) =>
  api.applyOps({ ops: [op], confirmed: confirmed || [] }).results[0];

// ------------------------------------------------------------------ borders

test('borders apply, never ask, and undo restores what was there', () => {
  const { api, s1 } = seeded();
  // Pre-existing border the undo must bring back.
  s1.getRange('A1:B1').setBorder(null, null, true, null, null, null, '#ff0000', 'DASHED');

  const r = apply(api, { opId: 'op_b', type: 'setBorders', sheetName: 'Sheet1',
    a1: 'A1:B3', top: true, bottom: true, left: true, right: true, style: 'thick' });
  assert.strictEqual(r.ok, true, 'borders are formatting: never gated');
  assert.strictEqual(s1.getRange('A1').getValues()[0][0], 'Region', 'content untouched');
  const after = s1._get('borders', 1, 1);
  assert.strictEqual(after.top.style, 'SOLID_THICK');

  api.undoOp('op_b');
  const restored = s1._get('borders', 1, 1);
  assert.ok(!restored || !restored.top, 'the thick top border is gone');
  assert.strictEqual((restored && restored.bottom || {}).style, 'DASHED',
    'the pre-existing dashed bottom border came back');
});

test('style "none" removes borders, and undo brings them back', () => {
  const { api, s1 } = seeded();
  s1.getRange('A1:B3').setBorder(true, true, true, true, null, null, '#000000', 'SOLID');

  apply(api, { opId: 'op_rm', type: 'setBorders', sheetName: 'Sheet1',
    a1: 'A1:B3', top: false, bottom: false, left: false, right: false, style: 'none' });
  assert.strictEqual(s1._get('borders', 1, 1), '', 'borders removed');

  api.undoOp('op_rm');
  assert.strictEqual((s1._get('borders', 1, 1).top || {}).style, 'SOLID', 'borders restored');
});

test('a clear that wipes formatting restores borders on undo too', () => {
  const { api, s1 } = seeded();
  s1.getRange('A1:B1').setBorder(true, null, null, null, null, null, '#000000', 'SOLID');

  apply(api, { opId: 'op_c', type: 'clear', sheetName: 'Sheet1', a1: 'A1:B1', what: 'formats' },
    ['op_c']);
  assert.strictEqual(s1._get('borders', 1, 1), '', 'clearFormat took the borders');

  api.undoOp('op_c');
  assert.strictEqual((s1._get('borders', 1, 1).top || {}).style, 'SOLID',
    'undo of a format clear restores borders — the reason snapshots go through the API');
});

// --------------------------------------------------------------- validation

test('a dropdown applies, and undo restores the prior rule exactly', () => {
  const { api, s1 } = seeded();
  apply(api, { opId: 'op_v1', type: 'setValidation', sheetName: 'Sheet1', a1: 'B2:B3',
    rule: { type: 'list', values: ['Low', 'High'] } });
  const first = s1.getRange('B2').getDataValidations()[0][0];
  assert.strictEqual(first.getCriteriaType(), 'VALUE_IN_LIST');
  assert.deepStrictEqual(j(first.getCriteriaValues()[0]), ['Low', 'High']);

  apply(api, { opId: 'op_v2', type: 'setValidation', sheetName: 'Sheet1', a1: 'B2:B3',
    rule: { type: 'list', values: ['A', 'B', 'C'], help: 'pick one' } });
  assert.deepStrictEqual(
    j(s1.getRange('B2').getDataValidations()[0][0].getCriteriaValues()[0]), ['A', 'B', 'C']);

  api.undoOp('op_v2');
  const back = s1.getRange('B2').getDataValidations()[0][0];
  assert.deepStrictEqual(j(back.getCriteriaValues()[0]), ['Low', 'High'],
    'the earlier dropdown came back, not a blank');
});

test('rule type "none" clears validation; bad rules are refused up front', () => {
  const { api, s1 } = seeded();
  apply(api, { opId: 'op_v', type: 'setValidation', sheetName: 'Sheet1', a1: 'B2',
    rule: { type: 'list', values: ['x'] } });
  apply(api, { type: 'setValidation', sheetName: 'Sheet1', a1: 'B2', rule: { type: 'none' } });
  assert.strictEqual(s1.getRange('B2').getDataValidations()[0][0], null);

  const bad = apply(api, { type: 'setValidation', sheetName: 'Sheet1', a1: 'B2',
    rule: { type: 'list' } });
  assert.strictEqual(bad.error.code, 'BAD_PAYLOAD');
  const worse = apply(api, { type: 'setValidation', sheetName: 'Sheet1', a1: 'B2',
    rule: { type: 'numberBetween', min: 1 } });
  assert.strictEqual(worse.error.code, 'BAD_PAYLOAD');
});

// ------------------------------------------------------------------- notes

test('notes set, clear, and undo through the snapshot', () => {
  const { api, s1 } = seeded();
  s1.getRange('A2').setNote('old note');

  apply(api, { opId: 'op_n', type: 'setNote', sheetName: 'Sheet1', a1: 'A2',
    note: 'checked 2026-08-20' });
  assert.strictEqual(s1.getRange('A2').getNotes()[0][0], 'checked 2026-08-20');

  api.undoOp('op_n');
  assert.strictEqual(s1.getRange('A2').getNotes()[0][0], 'old note', 'prior note restored');
});

// -------------------------------------------------- conditional formatting

test('a conditional rule lands via the API and undo removes exactly it', () => {
  const { api, s1 } = seeded();
  const r = apply(api, { opId: 'op_cf', type: 'setConditionalFormat', sheetName: 'Sheet1',
    a1: 'B2:B3', rule: { when: 'NUMBER_GREATER', values: [20], background: '#fce8e6', bold: true } });
  assert.strictEqual(r.ok, true, 'formatting: never gated');
  assert.strictEqual(s1.conditionalFormats.length, 1);
  const rule = s1.conditionalFormats[0].booleanRule;
  assert.strictEqual(rule.condition.type, 'NUMBER_GREATER');
  assert.deepStrictEqual(j(rule.condition.values), [{ userEnteredValue: '20' }]);
  assert.ok(rule.format.backgroundColor, 'the format traveled with the rule');
  assert.strictEqual(rule.format.textFormat.bold, true);

  api.undoOp('op_cf');
  assert.strictEqual(s1.conditionalFormats.length, 0);
});

test('a gradient rule builds, and clearing all rules undoes to the full list', () => {
  const { api, s1 } = seeded();
  apply(api, { opId: 'op_g', type: 'setConditionalFormat', sheetName: 'Sheet1', a1: 'B2:B3',
    rule: { gradient: { minColor: '#ffffff', maxColor: '#0b8043' } } });
  assert.ok(s1.conditionalFormats[0].gradientRule, 'gradient rule stored');
  assert.strictEqual(s1.conditionalFormats[0].gradientRule.minpoint.type, 'MIN');

  apply(api, { opId: 'op_clear', type: 'clearConditionalFormats', sheetName: 'Sheet1' });
  assert.strictEqual(s1.conditionalFormats.length, 0);

  api.undoOp('op_clear');
  assert.strictEqual(s1.conditionalFormats.length, 1, 'the rule list came back whole');
});

test('two conditional-format edits conflict; the older undo is refused', () => {
  const { api } = seeded();
  apply(api, { opId: 'op_a', type: 'setConditionalFormat', sheetName: 'Sheet1', a1: 'B2',
    rule: { when: 'NUMBER_GREATER', values: [1], background: '#fce8e6' } });
  apply(api, { opId: 'op_b2', type: 'setConditionalFormat', sheetName: 'Sheet1', a1: 'B3',
    rule: { when: 'NUMBER_LESS', values: [99], background: '#e6f4ea' } });

  const refused = api.undoOp('op_a');
  assert.strictEqual(refused.ok, false, 'rules are whole-sheet state; older undo would eat the newer rule');
  assert.strictEqual(refused.code, 'BLOCKED_BY_LATER_EDIT');
});

// ------------------------------------------------------------ named ranges

test('named ranges create, update, delete, and undo each step', () => {
  const { api, ss } = seeded();
  apply(api, { opId: 'op_n1', type: 'setNamedRange', name: 'Sales',
    sheetName: 'Sheet1', a1: 'A1:B3' });
  assert.strictEqual(ss.namedRanges.get('Sales').a1, 'A1:B3');

  apply(api, { opId: 'op_n2', type: 'setNamedRange', name: 'Sales',
    sheetName: 'Sheet1', a1: 'A1:B9' });
  assert.strictEqual(ss.namedRanges.get('Sales').a1, 'A1:B9');

  api.undoOp('op_n2');
  assert.strictEqual(ss.namedRanges.get('Sales').a1, 'A1:B3', 'update undone to prior definition');

  apply(api, { opId: 'op_n3', type: 'deleteNamedRange', name: 'Sales' });
  assert.ok(!ss.namedRanges.has('Sales'));
  api.undoOp('op_n3');
  assert.strictEqual(ss.namedRanges.get('Sales').a1, 'A1:B3', 'delete undone');

  // And undoing the creation removes it, now that later edits are undone.
  api.undoOp('op_n1');
  assert.ok(!ss.namedRanges.has('Sales'), 'creation undone: the name is gone');
});

test('edits to different named ranges never block each other', () => {
  const { api } = seeded();
  apply(api, { opId: 'op_x', type: 'setNamedRange', name: 'Alpha', sheetName: 'Sheet1', a1: 'A1' });
  apply(api, { opId: 'op_y', type: 'setNamedRange', name: 'Beta', sheetName: 'Sheet1', a1: 'B1' });
  assert.strictEqual(api.undoOp('op_x').ok, true,
    'same kind, different key: no conflict');
});

test('a bad name is refused before anything happens', () => {
  const { api } = seeded();
  const r = apply(api, { type: 'setNamedRange', name: 'has space', sheetName: 'Sheet1', a1: 'A1' });
  assert.strictEqual(r.error.code, 'BAD_PAYLOAD');
  const gone = apply(api, { type: 'deleteNamedRange', name: 'Nope' });
  assert.strictEqual(gone.error.code, 'BAD_PAYLOAD');
});

// --------------------------------------------------------- duplicate sheet

test('duplicating a sheet copies content, and undo deletes the copy', () => {
  const { api, ss } = seeded();
  const r = apply(api, { opId: 'op_d', type: 'duplicateSheet', sheetName: 'Sheet1',
    newName: 'Sheet1 backup' });
  assert.strictEqual(r.ok, true, 'never gated: nothing is destroyed');
  const copy = ss.getSheetByName('Sheet1 backup');
  assert.ok(copy, 'the copy exists');
  assert.strictEqual(copy.getRange('A2').getValues()[0][0], 'West', 'content came along');

  api.undoOp('op_d');
  assert.ok(!ss.getSheetByName('Sheet1 backup'), 'undo deleted the copy');
  assert.ok(ss.getSheetByName('Sheet1'), 'the source is untouched');
});

test('duplicating to a taken name is refused', () => {
  const { api } = seeded();
  const r = apply(api, { type: 'duplicateSheet', sheetName: 'Sheet1', newName: 'Sheet2' });
  assert.strictEqual(r.error.code, 'SHEET_EXISTS');
});

// ------------------------------------------------------------- protection

test('every tier-2 op respects the protected history sheet', () => {
  const { api } = seeded();
  for (const op of [
    { type: 'setBorders', sheetName: '__claude_history__', a1: 'A1', top: true },
    { type: 'setValidation', sheetName: '__claude_history__', a1: 'A1', rule: { type: 'checkbox' } },
    { type: 'setNote', sheetName: '__claude_history__', a1: 'A1', note: 'x' },
    { type: 'setConditionalFormat', sheetName: '__claude_history__', a1: 'A1',
      rule: { when: 'NOT_BLANK' } },
    { type: 'clearConditionalFormats', sheetName: '__claude_history__' },
    { type: 'setNamedRange', name: 'X', sheetName: '__claude_history__', a1: 'A1' },
    { type: 'duplicateSheet', sheetName: '__claude_history__' },
  ]) {
    const r = apply(api, op);
    assert.strictEqual(r.error && r.error.code, 'PROTECTED_SHEET', op.type + ' is blocked');
  }
});
