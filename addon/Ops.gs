/**
 * @OnlyCurrentDoc
 *
 * Multi-op turns: inspection, the confirmation gate, and sequential execution.
 *
 * A turn is a list of ops, not one op. Each gets its own history entry so the
 * user can undo "this" without undoing "that", and they share a `turnId` so the
 * sidebar can group them visually without giving up that granularity.
 *
 * Two phases on purpose. `inspectOps()` reports what each op would destroy
 * without touching the sheet; `applyOps()` refuses to run a gated op that the
 * user did not confirm. The gate is enforced here rather than in the sidebar,
 * because the sidebar is the part an injected prompt could plausibly influence.
 */

/** Above this many existing non-empty cells overwritten, ask first. */
const DESTRUCTIVE_CELL_THRESHOLD = 10;

const VALUE_OPS = ['setValues', 'setFormulas', 'setFormats', 'clear'];

/**
 * Resolve an op's target. Sheet by name for now; protocol.md prefers sheetId
 * because names are user-editable, and the model only ever sees names — so
 * accept both and prefer the ID when it is present.
 */
function opSheet_(ss, op) {
  if (op.sheetId !== undefined && op.sheetId !== null) {
    const byId = ss.getSheets().filter(function (s) { return s.getSheetId() === op.sheetId; })[0];
    if (byId) return byId;
  }
  if (op.sheetName) return ss.getSheetByName(op.sheetName);
  return ss.getSheets()[0];
}

/**
 * The range an op writes to.
 *
 * For grid ops the written range is sized from the payload, not from the a1 the
 * model wrote — a1 is only the top-left anchor. For `clear` the a1 is the range
 * itself, since there is no payload to size from.
 */
function opRange_(sheet, op) {
  const anchor = sheet.getRange(op.a1);
  const grid = op.values || op.formulas;
  if (grid && grid.length && grid[0] && grid[0].length) {
    return sheet.getRange(anchor.getRow(), anchor.getColumn(), grid.length, grid[0].length);
  }
  return anchor;
}

function countNonEmpty_(grid) {
  let n = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c];
      if (v !== '' && v !== null && v !== undefined) n++;
    }
  }
  return n;
}

/**
 * What would this op destroy?
 *
 * Reads only. Two things make an op destructive, and they are deliberately
 * different in kind:
 *
 *   - **Volume** — it overwrites more than DESTRUCTIVE_CELL_THRESHOLD cells that
 *     already hold something. One cell is a typo fix; forty is a column of
 *     someone's data.
 *   - **Formulas** — it overwrites a cell containing a formula, at any count.
 *     Replacing a formula with its own current value looks like a no-op in the
 *     grid and quietly destroys the thing that computed it. Always ask.
 *
 * `clear` is always gated when it would remove anything at all: unlike a write,
 * it leaves nothing behind to notice.
 */
function inspectOp_(ss, op) {
  const base = { opId: op.opId || null, type: op.type, ok: true };

  if (VALUE_OPS.indexOf(op.type) === -1) {
    return { ok: false, type: op.type,
      error: { code: 'NOT_IMPLEMENTED', message: 'Unsupported op type: ' + op.type } };
  }

  const sheet = opSheet_(ss, op);
  if (!sheet) {
    return { ok: false, type: op.type,
      error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
  }

  let range;
  try { range = opRange_(sheet, op); } catch (e) {
    return { ok: false, type: op.type,
      error: { code: 'BAD_PAYLOAD', message: 'Bad range "' + op.a1 + '": ' + e.message } };
  }

  const existing = sanitizeGrid_(range.getValues());
  const formulas = range.getFormulas();
  const occupied = countNonEmpty_(existing);
  const formulaCount = countNonEmpty_(formulas);

  let destructive = false;
  let reason = '';

  if (op.type === 'clear' && occupied > 0) {
    destructive = true;
    reason = 'clears ' + occupied + ' cell' + (occupied === 1 ? '' : 's') + ' that hold content';
  } else if (formulaCount > 0 && op.type !== 'setFormats') {
    destructive = true;
    reason = 'overwrites ' + formulaCount + ' formula' + (formulaCount === 1 ? '' : 's');
  } else if (occupied > DESTRUCTIVE_CELL_THRESHOLD && op.type !== 'setFormats') {
    destructive = true;
    reason = 'overwrites ' + occupied + ' cells that already hold content';
  }

  base.target = sheet.getName() + '!' + range.getA1Notation();
  base.sheetName = sheet.getName();
  base.a1 = range.getA1Notation();
  base.cells = range.getNumRows() * range.getNumColumns();
  base.occupied = occupied;
  base.formulas = formulaCount;
  base.destructive = destructive;
  base.reason = reason;
  return base;
}

/**
 * Dry run. Returns one inspection per op, in order, touching nothing.
 * The sidebar uses this to decide what to ask about before anything happens.
 */
function inspectOps(ops) {
  if (!Array.isArray(ops)) return [];
  const ss = writeSpreadsheet_();
  return ops.map(function (op) { return inspectOp_(ss, op); });
}

/**
 * Verify the region the ops were planned against has not changed underneath us.
 *
 * This is the compare-and-swap from protocol.md §Concurrency, and the region is
 * the one `getContext` read — NOT each op's own target. Re-hashing an op's
 * target and comparing it to the context hash compares two different ranges,
 * which can only match by luck.
 */
function checkGuard_(ss, guard) {
  if (!guard || !guard.hash || !guard.a1) return null;
  const sheet = guard.sheetName ? ss.getSheetByName(guard.sheetName) : ss.getSheets()[0];
  if (!sheet) {
    return { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + guard.sheetName };
  }
  const current = hashValues_(sanitizeGrid_(sheet.getRange(guard.a1).getValues()));
  if (current !== guard.hash) {
    return {
      code: 'CONTEXT_STALE',
      message: 'The sheet changed since this was planned. Re-read the sheet and try again.',
    };
  }
  return null;
}

function newOpId_() {
  return 'op_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
}

/** Apply one already-gated op. Assumes inspection and confirmation happened. */
function applyOne_(ss, op, turnId) {
  const sheet = opSheet_(ss, op);
  const range = opRange_(sheet, op);
  const opId = op.opId || newOpId_();

  // Snapshot before writing — this is the entire undo guarantee, and it captures
  // formats as well as values so a restore does not leave the sheet visibly wrong.
  const snapshot = snapshotRange_(sheet, range);

  if (op.type === 'setValues') {
    if (!Array.isArray(op.values) || !Array.isArray(op.values[0])) {
      return { ok: false, opId: opId, error: { code: 'BAD_PAYLOAD', message: 'values must be a 2-D array.' } };
    }
    range.setValues(op.values);
  } else if (op.type === 'setFormulas') {
    if (!Array.isArray(op.formulas) || !Array.isArray(op.formulas[0])) {
      return { ok: false, opId: opId, error: { code: 'BAD_PAYLOAD', message: 'formulas must be a 2-D array.' } };
    }
    range.setFormulas(op.formulas);
  } else if (op.type === 'setFormats') {
    const f = op.format || {};
    if (f.background) range.setBackground(f.background);
    if (f.fontColor) range.setFontColor(f.fontColor);
    if (f.bold !== undefined) range.setFontWeight(f.bold ? 'bold' : 'normal');
    if (f.italic !== undefined) range.setFontStyle(f.italic ? 'italic' : 'normal');
    if (f.numberFormat) range.setNumberFormat(f.numberFormat);
    if (f.align) range.setHorizontalAlignment(f.align);
  } else if (op.type === 'clear') {
    const what = op.what || 'all';
    if (what === 'values') range.clearContent();
    else if (what === 'formats') range.clearFormat();
    else range.clear();
  } else {
    return { ok: false, opId: opId,
      error: { code: 'NOT_IMPLEMENTED', message: 'Unsupported op type: ' + op.type } };
  }

  SpreadsheetApp.flush();

  const target = sheet.getName() + '!' + range.getA1Notation();
  const recorded = recordHistory_(opId, op.type, target, snapshot, turnId);

  return {
    ok: true,
    opId: opId,
    type: op.type,
    applied: target,
    restorable: recorded.restorable,
    newContextHash: hashValues_(sanitizeGrid_(range.getValues())),
  };
}

/**
 * Execute a turn's ops in order.
 *
 * @param {{ops: Array, guard?: {sheetName, a1, hash}, confirmed?: string[],
 *          prompt?: string}} request
 *
 * Stops at the first failure rather than pressing on: later ops in a turn are
 * usually planned against the state the earlier ones were meant to produce, so
 * continuing past a failure applies them to a sheet that never reached it.
 * Everything already applied stays applied, and each carries its own history
 * entry, so the user can walk it back one step at a time.
 */
function applyOps(request) {
  request = request || {};
  const ops = request.ops || [];
  if (!Array.isArray(ops) || !ops.length) {
    return { ok: false, error: { code: 'BAD_PAYLOAD', message: 'No ops supplied.' } };
  }

  const ss = writeSpreadsheet_();

  const stale = checkGuard_(ss, request.guard);
  if (stale) return { ok: false, error: stale };

  const turnId = 'turn_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const confirmed = request.confirmed || [];
  const results = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op.opId) op.opId = newOpId_();

    // Re-inspect at apply time. The sidebar's inspection is a UI convenience;
    // this is the check that actually governs, and it runs against the sheet as
    // it is now — including whatever the previous op in this turn just changed.
    const check = inspectOp_(ss, op);
    if (!check.ok) {
      results.push({ ok: false, opId: op.opId, type: op.type, error: check.error });
      break;
    }
    if (check.destructive && confirmed.indexOf(op.opId) === -1) {
      results.push({ ok: false, opId: op.opId, type: op.type, needsConfirmation: true,
        target: check.target, reason: check.reason,
        error: { code: 'NEEDS_CONFIRMATION', message: 'This op ' + check.reason + '.' } });
      break;
    }

    let res;
    try {
      res = applyOne_(ss, op, turnId);
    } catch (e) {
      res = { ok: false, opId: op.opId, type: op.type,
        error: { code: 'APPLY_FAILED', message: String(e && e.message || e) } };
    }
    results.push(res);
    if (!res.ok) break;
  }

  return {
    ok: results.every(function (r) { return r.ok; }),
    turnId: turnId,
    results: results,
  };
}
