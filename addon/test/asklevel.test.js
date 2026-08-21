/**
 * The ask-before threshold — the setting that relaxes the confirmation gate.
 *
 * This is the most dangerous knob in the product: it decides whether a human
 * is asked before their data is overwritten. Two properties must hold.
 *
 *   1. It FAILS STRICT. Absent, misspelled, or a value from a newer daemon
 *      this add-on doesn't know — all mean "ask about everything". A gate that
 *      fails open on an unfamiliar string is the exact bug that shipped twice
 *      in this project already.
 *   2. The relaxation is bounded by UNDO, not by convenience. Anything the
 *      history cannot put back keeps asking regardless of the setting.
 */

const test = require('node:test');
const assert = require('node:assert');
const { loadAddon } = require('./fake-sheets');

function seeded() {
  const ctx = loadAddon(['Sheet1', 'Sheet2']);
  ctx.s1 = ctx.ss.getSheetByName('Sheet1');
  // Twelve occupied cells — over DESTRUCTIVE_CELL_THRESHOLD, so a write here
  // is gated at the default level.
  ctx.s1.seed('A1', [
    ['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l'],
  ]);
  return ctx;
}

const run = (api, op, askBefore, confirmed) =>
  api.applyOps({ ops: [op], confirmed: confirmed || [], askBefore: askBefore }).results[0];

const wideWrite = {
  type: 'setValues', sheetName: 'Sheet1', a1: 'A1',
  values: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['10', '11', '12']],
};

// ------------------------------------------------------------ fails strict

test('an unknown, missing, or misspelled level asks about everything', () => {
  for (const level of [undefined, null, '', 'none', 'never', 'UNRECOVERABLE',
                       'unrecoverable ', 'destructive', 'ask-me-less', 0, 1, true, {}]) {
    const { api } = seeded();
    const r = run(api, Object.assign({}, wideWrite), level);
    assert.strictEqual(r.needsConfirmation, true,
      JSON.stringify(level) + ' must fall back to asking');
  }
});

test('only the exact string relaxes the gate', () => {
  const { api } = seeded();
  const r = run(api, Object.assign({}, wideWrite), 'unrecoverable');
  assert.strictEqual(r.ok, true, 'the one recognized value applies without asking');
});

// ------------------------------------------------- relaxed, but still undoable

test('a relaxed write is still fully undoable — that is the whole bargain', () => {
  const { api, s1 } = seeded();
  const r = run(api, Object.assign({ opId: 'op_w' }, wideWrite), 'unrecoverable');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.restorable, true, 'relaxing the prompt must not cost the undo entry');
  assert.strictEqual(s1.getRange('A1').getValues()[0][0], '1');

  api.undoOp('op_w');
  assert.strictEqual(s1.getRange('A1').getValues()[0][0], 'a', 'the original came back');
});

test('formula overwrites and clears relax too, since undo covers them', () => {
  const { api, s1 } = seeded();
  s1.seed('E1', [['=1+1']], 'formulas');

  const overwrite = run(api, { type: 'setValues', sheetName: 'Sheet1', a1: 'E1',
    values: [['plain']] }, 'unrecoverable');
  assert.strictEqual(overwrite.ok, true, 'a formula overwrite is restorable');

  const cleared = run(api, { type: 'clear', sheetName: 'Sheet1', a1: 'A1:C4',
    what: 'all' }, 'unrecoverable');
  assert.strictEqual(cleared.ok, true, 'a clear is restorable');
});

test('deleting populated rows relaxes; the snapshot still records', () => {
  const { api, s1 } = seeded();
  const r = run(api, { opId: 'op_d', type: 'deleteRows', sheetName: 'Sheet1',
    index: 2, count: 2 }, 'unrecoverable');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s1.getRange('A2').getValues()[0][0], 'j', 'rows really went');

  api.undoOp('op_d');
  assert.strictEqual(s1.getRange('A2').getValues()[0][0], 'd', 'and really came back');
});

// -------------------------------------------------- never relaxed, whatever

test('deleting a sheet always asks, at every level', () => {
  for (const level of ['destructive', 'unrecoverable']) {
    const { api } = seeded();
    const r = run(api, { type: 'deleteSheet', sheetName: 'Sheet2' }, level);
    assert.strictEqual(r.needsConfirmation, true,
      'a tab is a big thing to lose — ' + level);
  }
});

test('an edit too large to snapshot keeps asking even when relaxed', () => {
  const { api, s1 } = seeded();
  // Push the target range past MAX_ENTRY_BYTES (500 KB) so no undo entry could
  // hold it. The relaxed level must notice and ask anyway.
  const big = 'x'.repeat(60000);
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push([big]);
  s1.seed('J1', rows);

  const r = run(api, { type: 'clear', sheetName: 'Sheet1', a1: 'J1:J12', what: 'all' },
    'unrecoverable');
  assert.strictEqual(r.needsConfirmation, true,
    'nothing to go back to, so the prompt stands');
});

test('web access is untouched by this setting', () => {
  // The web gate lives in the daemon (web-gate.js) and never consults
  // askBefore. Asserted structurally: the add-on has no concept of it.
  const fs = require('fs');
  const path = require('path');
  const gate = fs.readFileSync(
    path.join(__dirname, '..', '..', 'daemon', 'src', 'web-gate.js'), 'utf8');
  assert.ok(!/askBefore/.test(gate),
    'a relaxed sheet gate must never quietly relax outbound requests');
});

// ------------------------------------------------------------ dry run parity

test('inspectOps previews at the same level it will apply at', () => {
  const { api } = seeded();
  const strict = api.inspectOps([wideWrite], 'destructive')[0];
  const relaxed = api.inspectOps([wideWrite], 'unrecoverable')[0];

  assert.strictEqual(strict.destructive, true);
  assert.strictEqual(relaxed.destructive, false);
  assert.strictEqual(relaxed.relaxed, true, 'the preview says why it will not ask');
  // The advisory preview and the governing check must not disagree.
  assert.strictEqual(run(api, Object.assign({}, wideWrite), 'unrecoverable').ok, true);
});
