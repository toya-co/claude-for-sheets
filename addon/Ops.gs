/**
 * Do NOT add the OnlyCurrentDoc annotation here — see the note in Sheet.gs.
 * It breaks undo across the whole add-on.
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

/** Where onEdit (Code.gs) leaves its "a person typed" marker. */
const EDIT_MARK_KEY = 'claude.humanEdit';

/**
 * The last human edit, or null. Millisecond timestamps, compared against the
 * watermark a turn captured when it read the sheet.
 */
function editWatermark_() {
  try {
    const raw = PropertiesService.getDocumentProperties().getProperty(EDIT_MARK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

const VALUE_OPS = ['setValues', 'setFormulas', 'setFormats', 'clear'];
const STRUCTURAL_OPS = ['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns',
                        'addSheet', 'deleteSheet', 'duplicateSheet'];

/**
 * Range-scoped ops beyond plain writes. Same undo story as value ops — bounded
 * to a rectangle, snapshot restores it — so they share the rectangle-overlap
 * conflict rule. Merge additionally records the merges it displaced; borders,
 * notes, and validations ride the plain snapshot, which captures all three.
 */
const RANGE_OPS = ['mergeCells', 'unmergeCells', 'sortRange',
                   'setBorders', 'setValidation', 'setNote'];

/**
 * Layout ops change how the sheet *presents*, not what it holds: widths,
 * heights, frozen panes, hidden spans, tab names and visibility. Each is
 * invertible from a small record of prior state — no snapshot payload at all —
 * and none destroys content, so none is ever gated. For undo conflicts they
 * live on their own plane: two width changes to the same columns conflict;
 * a width change and a value write never do.
 */
const LAYOUT_OPS = ['setColumnWidth', 'setRowHeight', 'freezePanes', 'renameSheet',
                    'hideRows', 'showRows', 'hideColumns', 'showColumns',
                    'hideSheet', 'showSheet',
                    'setConditionalFormat', 'clearConditionalFormats',
                    'setNamedRange', 'deleteNamedRange'];

/** '#rrggbb' → the API's {red, green, blue} floats. */
function hexColor_(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'thick', 'double', 'none'];

function borderStyleEnum_(style) {
  const map = {
    solid: SpreadsheetApp.BorderStyle.SOLID,
    dashed: SpreadsheetApp.BorderStyle.DASHED,
    dotted: SpreadsheetApp.BorderStyle.DOTTED,
    thick: SpreadsheetApp.BorderStyle.SOLID_THICK,
    double: SpreadsheetApp.BorderStyle.DOUBLE,
  };
  return map[style || 'solid'] || SpreadsheetApp.BorderStyle.SOLID;
}

/**
 * A sheet's conditional-format rules as the API's own JSON, via the Advanced
 * Sheets service. SpreadsheetApp can enumerate rules but cannot read a rule's
 * FORMAT back (BooleanCondition exposes the condition only), so honest
 * undo — and therefore the whole feature — goes through the API, where a rule
 * round-trips untouched.
 */
function condRules_(ss, sheet) {
  const resp = Sheets.Spreadsheets.get(ss.getId(), {
    fields: 'sheets(properties(sheetId),conditionalFormats)',
  });
  const entry = (resp.sheets || []).filter(function (s) {
    return s.properties && s.properties.sheetId === sheet.getSheetId();
  })[0];
  return (entry && entry.conditionalFormats) || [];
}

/** Replace a sheet's rules wholesale: delete what is there, add what should be. */
function setCondRules_(ss, sheet, rules) {
  const current = condRules_(ss, sheet);
  const requests = [];
  for (let i = 0; i < current.length; i++) {
    requests.push({ deleteConditionalFormatRule: { sheetId: sheet.getSheetId(), index: 0 } });
  }
  (rules || []).forEach(function (rule, i) {
    requests.push({ addConditionalFormatRule: { rule: rule, index: i } });
  });
  if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests: requests }, ss.getId());
}

/** Build one API rule from the model-facing spec. Returns null on a bad spec. */
function condRuleFromSpec_(sheet, range, spec) {
  const gridRange = {
    sheetId: sheet.getSheetId(),
    startRowIndex: range.getRow() - 1,
    endRowIndex: range.getRow() - 1 + range.getNumRows(),
    startColumnIndex: range.getColumn() - 1,
    endColumnIndex: range.getColumn() - 1 + range.getNumColumns(),
  };
  if (spec && spec.gradient) {
    const g = spec.gradient;
    const point = function (color, type, value) {
      if (!color) return null;
      const p = { color: hexColor_(color), type: type || 'NUMBER' };
      if (value !== undefined && p.type !== 'MIN' && p.type !== 'MAX') p.value = String(value);
      return p;
    };
    const rule = { minpoint: point(g.minColor, g.minType || 'MIN', g.minValue),
                   maxpoint: point(g.maxColor, g.maxType || 'MAX', g.maxValue) };
    if (!rule.minpoint || !rule.maxpoint) return null;
    if (g.midColor) rule.midpoint = point(g.midColor, g.midType || 'PERCENTILE', g.midValue !== undefined ? g.midValue : 50);
    return { ranges: [gridRange], gradientRule: rule };
  }
  if (!spec || !spec.when) return null;
  const format = {};
  if (spec.background) format.backgroundColor = hexColor_(spec.background);
  if (spec.fontColor || spec.bold !== undefined || spec.italic !== undefined) {
    format.textFormat = {};
    if (spec.fontColor) format.textFormat.foregroundColor = hexColor_(spec.fontColor);
    if (spec.bold !== undefined) format.textFormat.bold = Boolean(spec.bold);
    if (spec.italic !== undefined) format.textFormat.italic = Boolean(spec.italic);
  }
  return {
    ranges: [gridRange],
    booleanRule: {
      condition: {
        type: String(spec.when),
        values: (spec.values || []).map(function (v) { return { userEnteredValue: String(v) }; }),
      },
      format: format,
    },
  };
}

/** The named range with this name, or null. */
function namedRange_(ss, name) {
  return ss.getNamedRanges().filter(function (nr) { return nr.getName() === name; })[0] || null;
}

/** "B" or 2 → 2. Sort specs arrive with whatever the model found natural. */
function colNum_(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '').trim().toUpperCase();
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[A-Z]+$/.test(s)) return NaN;
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

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

  // The history sheet holds the undo payloads. An op that touches it — from a
  // confused model or a hostile cell — would let an edit destroy its own undo.
  if (op.sheetName === HISTORY_SHEET || op.name === HISTORY_SHEET ||
      op.newName === HISTORY_SHEET) {
    return { ok: false, type: op.type,
      error: { code: 'PROTECTED_SHEET', message: 'That sheet belongs to the undo history.' } };
  }

  if (STRUCTURAL_OPS.indexOf(op.type) !== -1) return inspectStructural_(ss, op, base);
  if (LAYOUT_OPS.indexOf(op.type) !== -1) return inspectLayout_(ss, op, base);
  if (RANGE_OPS.indexOf(op.type) !== -1) return inspectRangeOp_(ss, op, base);

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

/** "Sheet1!rows 3-5" / "Sheet1!cols 2-4" / "sheet 'Data'" — for cards and history. */
function structTarget_(op, sheetName) {
  if (op.type === 'addSheet') return "sheet '" + op.name + "'";
  if (op.type === 'deleteSheet') return "sheet '" + sheetName + "'";
  if (op.type === 'duplicateSheet') {
    return "sheet '" + sheetName + "' → copy" + (op.newName ? " '" + op.newName + "'" : '');
  }
  const count = Math.max(1, op.count || 1);
  const unit = /Rows$/.test(op.type) ? 'rows' : 'cols';
  const span = count > 1 ? op.index + '-' + (op.index + count - 1) : String(op.index);
  return sheetName + '!' + unit + ' ' + span;
}

/**
 * What would this structural op destroy?
 *
 * Inserts and addSheet destroy nothing and are never gated. Deleting rows or
 * columns is gated exactly like `clear`: whenever the doomed span holds any
 * content at all, because a delete leaves nothing behind to notice. Deleting a
 * whole sheet always asks — and above the snapshot ceiling the confirmation
 * says the one thing that matters: this one cannot be undone.
 */
function inspectStructural_(ss, op, base) {
  const count = Math.max(1, op.count || 1);

  if (op.type === 'addSheet') {
    if (!op.name) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'addSheet needs a name.' } };
    }
    if (ss.getSheetByName(op.name)) {
      return { ok: false, type: op.type,
        error: { code: 'SHEET_EXISTS', message: "A sheet named '" + op.name + "' already exists." } };
    }
    base.target = structTarget_(op, op.name);
    base.destructive = false;
    base.reason = '';
    return base;
  }

  const sheet = opSheet_(ss, op);
  if (!sheet) {
    return { ok: false, type: op.type,
      error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
  }
  base.target = structTarget_(op, sheet.getName());

  if (op.type === 'duplicateSheet') {
    if (op.newName && ss.getSheetByName(op.newName)) {
      return { ok: false, type: op.type,
        error: { code: 'SHEET_EXISTS', message: "A sheet named '" + op.newName + "' already exists." } };
    }
    base.destructive = false;
    base.reason = '';
    return base;
  }

  if (op.type === 'insertRows' || op.type === 'insertColumns') {
    if (!op.index || op.index < 1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'index must be 1 or greater.' } };
    }
    base.destructive = false;
    base.reason = '';
    return base;
  }

  if (op.type === 'deleteRows' || op.type === 'deleteColumns') {
    if (!op.index || op.index < 1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'index must be 1 or greater.' } };
    }
    const rows = op.type === 'deleteRows';
    const width = Math.max(1, rows ? sheet.getLastColumn() : sheet.getLastRow());
    const block = rows
      ? sheet.getRange(op.index, 1, count, width)
      : sheet.getRange(1, op.index, width, count);
    const occupied = countNonEmpty_(sanitizeGrid_(block.getValues()));
    const formulas = countNonEmpty_(block.getFormulas());
    base.occupied = occupied;
    base.formulas = formulas;
    base.destructive = occupied + formulas > 0;
    base.reason = base.destructive
      ? 'deletes ' + count + (rows ? ' row' : ' column') + (count === 1 ? '' : 's') +
        ' holding ' + occupied + ' cell' + (occupied === 1 ? '' : 's') + ' of content'
      : '';
    return base;
  }

  // deleteSheet
  if (ss.getSheets().filter(function (x) { return x.getName() !== HISTORY_SHEET; }).length <= 1) {
    return { ok: false, type: op.type,
      error: { code: 'LAST_SHEET', message: 'Cannot delete the only sheet.' } };
  }
  const lastRow = Math.max(1, sheet.getLastRow());
  const lastCol = Math.max(1, sheet.getLastColumn());
  const grid = sanitizeGrid_(sheet.getRange(1, 1, lastRow, lastCol).getValues());
  const occupied = countNonEmpty_(grid);
  const tooBig = JSON.stringify(grid).length > MAX_ENTRY_BYTES;
  base.occupied = occupied;
  base.destructive = true;   // always — a sheet is a big thing to lose
  base.reason = "deletes the sheet '" + sheet.getName() + "' (" + occupied +
    ' cell' + (occupied === 1 ? '' : 's') + ' of content)' +
    (tooBig ? ' — TOO LARGE TO UNDO' : '');
  return base;
}

/**
 * How many cells would a merge destroy?
 *
 * merge() keeps only the top-left cell of the block and silently deletes the
 * rest — mergeAcross keeps the first cell of each row, mergeVertically the
 * first of each column. Like `clear`, it leaves nothing behind to notice, so
 * any doomed content gates.
 */
function mergeDoomed_(values, formulas, mergeType) {
  let n = 0;
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      const survives = mergeType === 'across' ? c === 0
                     : mergeType === 'vertical' ? r === 0
                     : (r === 0 && c === 0);
      if (survives) continue;
      const v = values[r][c];
      if ((v !== '' && v !== null && v !== undefined) || formulas[r][c]) n++;
    }
  }
  return n;
}

/**
 * What would this range op destroy?
 *
 * Merging is gated like `clear` — it deletes every non-surviving cell that
 * holds anything. Sorting destroys nothing (a permutation, and the snapshot
 * restores it exactly), but formulas gate it: their relative references get
 * rearranged, which can silently change what they compute. Unmerging destroys
 * nothing and never asks.
 */
function inspectRangeOp_(ss, op, base) {
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
  base.target = sheet.getName() + '!' + range.getA1Notation();
  base.sheetName = sheet.getName();
  base.a1 = range.getA1Notation();
  base.destructive = false;
  base.reason = '';

  if (op.type === 'mergeCells') {
    const mergeType = op.mergeType || 'all';
    if (['all', 'across', 'vertical'].indexOf(mergeType) === -1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: "mergeType must be 'all', 'across', or 'vertical'." } };
    }
    const doomed = mergeDoomed_(sanitizeGrid_(range.getValues()), range.getFormulas(), mergeType);
    if (doomed > 0) {
      base.destructive = true;
      base.reason = 'merges away ' + doomed + ' cell' + (doomed === 1 ? '' : 's') +
        ' of content (only the first cell of a merge survives)';
    }
    return base;
  }

  if (op.type === 'unmergeCells') {
    if (!range.getMergedRanges().length) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'No merged cells in ' + base.target + '.' } };
    }
    return base;
  }

  // Borders, notes, and validations destroy no content — the snapshot captures
  // and restores all three — so none of them gates. Validation only.
  if (op.type === 'setBorders') {
    if (op.style !== undefined && BORDER_STYLES.indexOf(op.style) === -1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: "style must be one of: " + BORDER_STYLES.join(', ') } };
    }
    const edges = ['top', 'bottom', 'left', 'right', 'vertical', 'horizontal'];
    if (!edges.some(function (e) { return op[e] !== undefined; })) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Pass at least one edge: ' + edges.join(', ') + '.' } };
    }
    return base;
  }

  if (op.type === 'setNote') {
    if (op.note !== undefined && op.note !== null && typeof op.note !== 'string') {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'note must be a string (empty clears it).' } };
    }
    return base;
  }

  if (op.type === 'setValidation') {
    const rule = op.rule || {};
    const kinds = ['list', 'numberBetween', 'numberGreaterThan', 'checkbox', 'date', 'none'];
    if (kinds.indexOf(rule.type) === -1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'rule.type must be one of: ' + kinds.join(', ') } };
    }
    if (rule.type === 'list' && (!Array.isArray(rule.values) || !rule.values.length)) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'a list rule needs values: ["a", "b", …].' } };
    }
    if (rule.type === 'numberBetween' &&
        (typeof rule.min !== 'number' || typeof rule.max !== 'number')) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'numberBetween needs numeric min and max.' } };
    }
    if (rule.type === 'numberGreaterThan' && typeof rule.min !== 'number') {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'numberGreaterThan needs a numeric min.' } };
    }
    return base;
  }

  // sortRange
  const by = op.by;
  if (!Array.isArray(by) || !by.length) {
    return { ok: false, type: op.type,
      error: { code: 'BAD_PAYLOAD', message: 'sortRange needs by: [{column, ascending}].' } };
  }
  const first = range.getColumn();
  const last = first + range.getNumColumns() - 1;
  for (let i = 0; i < by.length; i++) {
    const col = colNum_(by[i] && by[i].column);
    if (!col || isNaN(col) || col < first || col > last) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Sort column ' + (by[i] && by[i].column) +
          ' is outside ' + base.target + '.' } };
    }
  }
  const formulas = countNonEmpty_(range.getFormulas());
  if (formulas > 0) {
    base.destructive = true;
    base.reason = 'sorts a range holding ' + formulas + ' formula' + (formulas === 1 ? '' : 's') +
      ', whose references will be rearranged';
  }
  return base;
}

/**
 * Validate a layout op. None of them is ever destructive — they change
 * presentation, not content, and each undoes exactly from its recorded prior
 * state — so this is validation only.
 */
function inspectLayout_(ss, op, base) {
  base.destructive = false;
  base.reason = '';

  // Named ranges are spreadsheet-scoped; resolve them before any sheet lookup.
  if (op.type === 'setNamedRange' || op.type === 'deleteNamedRange') {
    if (!op.name || typeof op.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_.]{0,254}$/.test(op.name)) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Named range names are letters, digits, and _ ' +
          '(no spaces), not starting with a digit.' } };
    }
    if (op.type === 'deleteNamedRange') {
      if (!namedRange_(ss, op.name)) {
        return { ok: false, type: op.type,
          error: { code: 'BAD_PAYLOAD', message: "No named range called '" + op.name + "'." } };
      }
      base.target = "named range '" + op.name + "'";
      return base;
    }
    const target = opSheet_(ss, op);
    if (!target) {
      return { ok: false, type: op.type,
        error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
    }
    try { target.getRange(op.a1); } catch (e) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Bad range "' + op.a1 + '": ' + e.message } };
    }
    base.target = "named range '" + op.name + "' → " + target.getName() + '!' + op.a1;
    return base;
  }

  const SHEET_SCOPED = ['renameSheet', 'hideSheet', 'showSheet', 'freezePanes',
                        'setConditionalFormat', 'clearConditionalFormats'];
  if (SHEET_SCOPED.indexOf(op.type) === -1) {
    if (!op.index || op.index < 1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'index must be 1 or greater.' } };
    }
  }

  const sheet = opSheet_(ss, op);
  if (!sheet) {
    return { ok: false, type: op.type,
      error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
  }
  const name = sheet.getName();
  base.destructive = false;
  base.reason = '';
  const count = Math.max(1, op.count || 1);
  const span = count > 1 ? op.index + '-' + (op.index + count - 1) : String(op.index);

  if (op.type === 'setColumnWidth' || op.type === 'setRowHeight') {
    const size = op.type === 'setColumnWidth' ? op.width : op.height;
    if (typeof size !== 'number' || size < 1 || size > 2000) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Need a pixel size between 1 and 2000.' } };
    }
    base.target = name + '!' + (op.type === 'setColumnWidth' ? 'cols ' : 'rows ') + span;
  } else if (op.type === 'freezePanes') {
    if (op.rows === undefined && op.cols === undefined) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'freezePanes needs rows, cols, or both (0 unfreezes).' } };
    }
    base.target = name + '!frozen panes';
  } else if (op.type === 'renameSheet') {
    if (!op.newName || typeof op.newName !== 'string' || op.newName.length > 100) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'renameSheet needs a newName under 100 characters.' } };
    }
    if (ss.getSheetByName(op.newName)) {
      return { ok: false, type: op.type,
        error: { code: 'SHEET_EXISTS', message: "A sheet named '" + op.newName + "' already exists." } };
    }
    base.target = "sheet '" + name + "' → '" + op.newName + "'";
  } else if (op.type === 'hideSheet') {
    const others = ss.getSheets().filter(function (s) {
      return s.getName() !== name && s.getName() !== HISTORY_SHEET && !s.isSheetHidden();
    });
    if (!others.length) {
      return { ok: false, type: op.type,
        error: { code: 'LAST_SHEET', message: 'Cannot hide the only visible sheet.' } };
    }
    base.target = "sheet '" + name + "'";
  } else if (op.type === 'showSheet') {
    base.target = "sheet '" + name + "'";
  } else if (op.type === 'setConditionalFormat') {
    if (!op.a1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'setConditionalFormat needs an a1 range.' } };
    }
    let range;
    try { range = sheet.getRange(op.a1); } catch (e) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Bad range "' + op.a1 + '": ' + e.message } };
    }
    if (!condRuleFromSpec_(sheet, range, op.rule)) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'rule needs {when, values?, background?, ' +
          'fontColor?, bold?} or {gradient: {minColor, maxColor, …}}.' } };
    }
    base.target = name + '!' + range.getA1Notation() + ' rule';
  } else if (op.type === 'clearConditionalFormats') {
    base.target = name + ' conditional formats';
  } else {  // hideRows / showRows / hideColumns / showColumns
    base.target = name + '!' + (/Rows$/.test(op.type) ? 'rows ' : 'cols ') + span;
  }
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
  if (!guard) return null;

  // Secondary: did a person type anywhere in the file since this turn read it?
  // Catches edits outside the range that was read, which the hash cannot see.
  if (guard.since) {
    const mark = editWatermark_();
    if (mark && mark.at > guard.since) {
      const where = mark.sheetName && mark.a1 ? ' (' + mark.sheetName + '!' + mark.a1 + ')' : '';
      return {
        code: 'CONTEXT_STALE',
        message: 'Someone edited the spreadsheet' + where + ' after this was planned. ' +
                 'Nothing was changed. Read the sheet again before writing.',
      };
    }
  }

  // Primary: is the region this was planned against byte-for-byte unchanged?
  if (!guard.hash || !guard.a1) return null;
  const sheet = guard.sheetName ? ss.getSheetByName(guard.sheetName) : ss.getSheets()[0];
  if (!sheet) {
    return { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + guard.sheetName };
  }
  const current = hashValues_(sanitizeGrid_(sheet.getRange(guard.a1).getValues()));
  if (current !== guard.hash) {
    return {
      code: 'CONTEXT_STALE',
      message: 'The contents of ' + sheet.getName() + '!' + guard.a1 + ' changed after this ' +
               'was planned. Nothing was changed. Read the sheet again before writing.',
    };
  }
  return null;
}

/**
 * The guard, refreshed to reflect this turn's own work.
 *
 * Without this a multi-write turn defeats itself: op 1 changes the guarded
 * region, so op 2's hash check fails on a change *we* made. Re-hashing after
 * each turn keeps the guard sensitive to everyone except us.
 */
function refreshedGuard_(ss, guard) {
  if (!guard || !guard.a1) return null;
  const sheet = guard.sheetName ? ss.getSheetByName(guard.sheetName) : ss.getSheets()[0];
  if (!sheet) return null;
  try {
    return {
      sheetName: sheet.getName(),
      a1: guard.a1,
      hash: hashValues_(sanitizeGrid_(sheet.getRange(guard.a1).getValues())),
      since: guard.since || null,
    };
  } catch (e) {
    return null;   // the region stopped existing (a structural op); drop the guard
  }
}

function newOpId_() {
  return 'op_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
}

/**
 * Apply one already-gated structural op and record its inverse.
 *
 * Order is load-bearing on deletes: snapshot FIRST, then delete — the payload
 * has to be captured while the cells still exist. Undo is the stored inverse:
 * an insert is undone by deleting what it inserted; a delete by re-inserting
 * the coordinates and rewriting the snapshot into them (History.gs).
 */
function applyStructural_(ss, op, turnId) {
  const opId = op.opId || newOpId_();
  const count = Math.max(1, op.count || 1);
  let target;
  let snapshot = null;
  let inverse;
  let sheetName;

  if (op.type === 'addSheet') {
    ss.insertSheet(op.name);
    sheetName = op.name;
    target = structTarget_(op, op.name);
    inverse = { type: 'deleteSheet', name: op.name };
  } else if (op.type === 'duplicateSheet') {
    const source = opSheet_(ss, op);
    const copy = source.copyTo(ss);
    if (op.newName) copy.setName(op.newName);
    sheetName = copy.getName();
    target = structTarget_(op, source.getName());
    // Undoing a duplicate deletes the copy — nothing else changed, and the
    // source needs no snapshot.
    inverse = { type: 'deleteSheet', name: sheetName };
  } else {
    const sheet = opSheet_(ss, op);
    sheetName = sheet.getName();
    target = structTarget_(op, sheetName);

    if (op.type === 'insertRows') {
      sheet.insertRowsBefore(op.index, count);
      inverse = { type: 'deleteRows', index: op.index, count: count };
    } else if (op.type === 'insertColumns') {
      sheet.insertColumnsBefore(op.index, count);
      inverse = { type: 'deleteColumns', index: op.index, count: count };
    } else if (op.type === 'deleteRows') {
      const width = Math.max(1, sheet.getLastColumn());
      snapshot = snapshotRange_(sheet, sheet.getRange(op.index, 1, count, width));
      sheet.deleteRows(op.index, count);
      inverse = { type: 'insertRows', index: op.index, count: count };
    } else if (op.type === 'deleteColumns') {
      const height = Math.max(1, sheet.getLastRow());
      snapshot = snapshotRange_(sheet, sheet.getRange(1, op.index, height, count));
      sheet.deleteColumns(op.index, count);
      inverse = { type: 'insertColumns', index: op.index, count: count };
    } else {  // deleteSheet
      const lastRow = Math.max(1, sheet.getLastRow());
      const lastCol = Math.max(1, sheet.getLastColumn());
      snapshot = snapshotRange_(sheet, sheet.getRange(1, 1, lastRow, lastCol));
      inverse = { type: 'recreateSheet', name: sheetName, index: sheet.getIndex() - 1 };
      ss.deleteSheet(sheet);
    }
  }

  SpreadsheetApp.flush();
  const recorded = recordHistory_(opId, op.type, target, snapshot, turnId,
    { structural: true, sheetName: sheetName, inverse: inverse });

  return {
    ok: true,
    opId: opId,
    type: op.type,
    applied: target,
    restorable: recorded.restorable,
  };
}

/**
 * Apply one already-gated range op.
 *
 * Sort rides the value-op undo path exactly: snapshot before, restore on undo,
 * nothing else needed. Merge and unmerge record an inverse as well — undoing a
 * merge is breakApart + restore + re-merge whatever the merge displaced, and
 * undoing an unmerge is re-merging what it broke.
 */
function applyRangeOp_(ss, op, turnId) {
  const sheet = opSheet_(ss, op);
  const range = opRange_(sheet, op);
  const opId = op.opId || newOpId_();
  const target = sheet.getName() + '!' + range.getA1Notation();
  let snapshot = null;
  let extra = null;

  if (op.type === 'sortRange') {
    snapshot = snapshotRange_(sheet, range);
    range.sort(op.by.map(function (s) {
      return { column: colNum_(s.column), ascending: s.ascending !== false };
    }));
  } else if (op.type === 'mergeCells') {
    snapshot = snapshotRange_(sheet, range);
    const prior = range.getMergedRanges().map(function (r) { return r.getA1Notation(); });
    const mergeType = op.mergeType || 'all';
    if (mergeType === 'across') range.mergeAcross();
    else if (mergeType === 'vertical') range.mergeVertically();
    else range.merge();
    extra = { sheetName: sheet.getName(),
              inverse: { type: 'unmergeRestore', priorMerges: prior } };
  } else if (op.type === 'unmergeCells') {
    // Values survive an unmerge, so no snapshot needed.
    const prior = range.getMergedRanges().map(function (r) { return r.getA1Notation(); });
    range.breakApart();
    extra = { sheetName: sheet.getName(), a1: range.getA1Notation(),
              inverse: { type: 'remerge', ranges: prior } };
  } else if (op.type === 'setBorders') {
    // The snapshot carries the prior borders (borderGrid_), so undo is the
    // plain restore path — same as a value write.
    snapshot = snapshotRange_(sheet, range);
    const b = function (edge) { return op[edge] === undefined ? null : Boolean(op[edge]); };
    if (op.style === 'none') {
      range.setBorder(b('top'), b('left'), b('bottom'), b('right'),
                      b('vertical'), b('horizontal'), null, null);
    } else {
      range.setBorder(b('top'), b('left'), b('bottom'), b('right'),
                      b('vertical'), b('horizontal'),
                      op.color || '#000000', borderStyleEnum_(op.style));
    }
  } else if (op.type === 'setNote') {
    snapshot = snapshotRange_(sheet, range);
    range.setNote(op.note ? String(op.note) : null);
  } else {  // setValidation — the snapshot's validations grid is the undo
    snapshot = snapshotRange_(sheet, range);
    const rule = op.rule || {};
    if (rule.type === 'none') {
      range.clearDataValidations();
    } else {
      let builder = SpreadsheetApp.newDataValidation();
      if (rule.type === 'list') builder = builder.requireValueInList(rule.values.map(String), true);
      else if (rule.type === 'numberBetween') builder = builder.requireNumberBetween(rule.min, rule.max);
      else if (rule.type === 'numberGreaterThan') builder = builder.requireNumberGreaterThan(rule.min);
      else if (rule.type === 'checkbox') builder = builder.requireCheckbox();
      else builder = builder.requireDate();
      builder = builder.setAllowInvalid(rule.allowInvalid !== false);
      if (rule.help) builder = builder.setHelpText(String(rule.help));
      range.setDataValidation(builder.build());
    }
  }

  SpreadsheetApp.flush();
  const recorded = recordHistory_(opId, op.type, target, snapshot, turnId, extra);
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
 * Apply one layout op, recording just enough prior state to undo it exactly.
 *
 * renameSheet additionally rewrites every history entry's sheetName from the
 * old name to the new one. Without that, the rename orphans the whole history:
 * every earlier entry points at a name that no longer exists, and every undo
 * on this sheet fails. Coordinates are untouched by a rename, so the rewrite
 * is lossless — and undoing the rename rewrites them back.
 */
function applyLayout_(ss, op, turnId) {
  const opId = op.opId || newOpId_();
  const sheet = opSheet_(ss, op);
  let entrySheetName = sheet.getName();
  const count = Math.max(1, op.count || 1);
  const span = count > 1 ? op.index + '-' + (op.index + count - 1) : String(op.index);
  let target, inverse, layout;

  if (op.type === 'setColumnWidth') {
    const widths = [];
    for (let c = op.index; c < op.index + count; c++) {
      widths.push({ index: c, width: sheet.getColumnWidth(c) });
      sheet.setColumnWidth(c, op.width);
    }
    target = entrySheetName + '!cols ' + span + ' → ' + op.width + 'px';
    inverse = { type: 'layout', kind: 'colwidth', widths: widths };
    layout = { kind: 'colwidth', index: op.index, count: count };
  } else if (op.type === 'setRowHeight') {
    const heights = [];
    for (let r = op.index; r < op.index + count; r++) {
      heights.push({ index: r, height: sheet.getRowHeight(r) });
      sheet.setRowHeight(r, op.height);
    }
    target = entrySheetName + '!rows ' + span + ' → ' + op.height + 'px';
    inverse = { type: 'layout', kind: 'rowheight', heights: heights };
    layout = { kind: 'rowheight', index: op.index, count: count };
  } else if (op.type === 'freezePanes') {
    inverse = { type: 'layout', kind: 'freeze',
                rows: sheet.getFrozenRows(), cols: sheet.getFrozenColumns() };
    if (op.rows !== undefined) sheet.setFrozenRows(op.rows);
    if (op.cols !== undefined) sheet.setFrozenColumns(op.cols);
    target = entrySheetName + '!frozen: ' + sheet.getFrozenRows() + ' row' +
      (sheet.getFrozenRows() === 1 ? '' : 's') + ', ' + sheet.getFrozenColumns() + ' col' +
      (sheet.getFrozenColumns() === 1 ? '' : 's');
    layout = { kind: 'freeze' };
  } else if (op.type === 'renameSheet') {
    const from = entrySheetName;
    sheet.setName(op.newName);
    const index = readIndex_();
    index.forEach(function (e) { if (e.sheetName === from) e.sheetName = op.newName; });
    writeIndex_(index);
    entrySheetName = op.newName;
    target = "sheet '" + from + "' → '" + op.newName + "'";
    inverse = { type: 'layout', kind: 'rename', to: from };
    layout = { kind: 'rename' };
  } else if (op.type === 'hideSheet' || op.type === 'showSheet') {
    inverse = { type: 'layout', kind: 'sheetvis', hidden: sheet.isSheetHidden() };
    if (op.type === 'hideSheet') sheet.hideSheet(); else sheet.showSheet();
    target = "sheet '" + entrySheetName + "'";
    layout = { kind: 'sheetvis' };
  } else if (op.type === 'setConditionalFormat' || op.type === 'clearConditionalFormats') {
    // Rules are whole-sheet state through the API, so the inverse is the
    // sheet's prior rule list, stored as the API's own JSON and restored
    // verbatim. SpreadsheetApp cannot read a rule's format back; the Advanced
    // Sheets service round-trips it untouched.
    const prior = condRules_(ss, sheet);
    if (op.type === 'setConditionalFormat') {
      const range = sheet.getRange(op.a1);
      const rule = condRuleFromSpec_(sheet, range, op.rule);
      setCondRules_(ss, sheet, prior.concat([rule]));
      target = entrySheetName + '!' + range.getA1Notation() + ' rule';
    } else {
      setCondRules_(ss, sheet, []);
      target = entrySheetName + ' conditional formats (' + prior.length + ' rule' +
        (prior.length === 1 ? '' : 's') + ' removed)';
    }
    inverse = { type: 'layout', kind: 'condfmt', rules: prior };
    layout = { kind: 'condfmt' };
  } else if (op.type === 'setNamedRange' || op.type === 'deleteNamedRange') {
    const existing = namedRange_(ss, op.name);
    const priorA1 = existing
      ? { sheetName: existing.getRange().getSheet().getName(),
          a1: existing.getRange().getA1Notation() }
      : null;
    if (op.type === 'setNamedRange') {
      const targetSheet = opSheet_(ss, op);
      ss.setNamedRange(op.name, targetSheet.getRange(op.a1));
      entrySheetName = targetSheet.getName();
      target = "named range '" + op.name + "' → " + entrySheetName + '!' + op.a1;
    } else {
      existing.remove();
      entrySheetName = priorA1.sheetName;
      target = "named range '" + op.name + "'";
    }
    // key scopes the conflict: edits to DIFFERENT named ranges never block
    // each other's undo; edits to the same one do.
    inverse = { type: 'layout', kind: 'namedrange', name: op.name, prior: priorA1 };
    layout = { kind: 'namedrange', key: op.name };
  } else {  // hideRows / showRows / hideColumns / showColumns
    const rows = /Rows$/.test(op.type);
    const spans = [];
    for (let i = op.index; i < op.index + count; i++) {
      spans.push({ index: i,
        hidden: rows ? sheet.isRowHiddenByUser(i) : sheet.isColumnHiddenByUser(i) });
    }
    if (op.type === 'hideRows') sheet.hideRows(op.index, count);
    else if (op.type === 'showRows') sheet.showRows(op.index, count);
    else if (op.type === 'hideColumns') sheet.hideColumns(op.index, count);
    else sheet.showColumns(op.index, count);
    target = entrySheetName + '!' + (rows ? 'rows ' : 'cols ') + span;
    inverse = { type: 'layout', kind: rows ? 'rowshidden' : 'colshidden', spans: spans };
    layout = { kind: rows ? 'rowhidden' : 'colhidden', index: op.index, count: count };
  }

  SpreadsheetApp.flush();
  const recorded = recordHistory_(opId, op.type, target, null, turnId,
    { sheetName: entrySheetName, layout: layout, inverse: inverse });
  return { ok: true, opId: opId, type: op.type, applied: target, restorable: recorded.restorable };
}

/** Apply one already-gated op. Assumes inspection and confirmation happened. */
function applyOne_(ss, op, turnId) {
  if (STRUCTURAL_OPS.indexOf(op.type) !== -1) return applyStructural_(ss, op, turnId);
  if (LAYOUT_OPS.indexOf(op.type) !== -1) return applyLayout_(ss, op, turnId);
  if (RANGE_OPS.indexOf(op.type) !== -1) return applyRangeOp_(ss, op, turnId);
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
    if (f.fontSize) range.setFontSize(f.fontSize);
    if (f.fontFamily) range.setFontFamily(f.fontFamily);
    if (f.wrap !== undefined) range.setWrap(Boolean(f.wrap));
    if (f.verticalAlign) range.setVerticalAlignment(f.verticalAlign);
    if (f.fontLine) range.setFontLine(f.fontLine);
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
    // Hand the caller a guard that accounts for what we just did, so the next
    // write in this turn is not rejected because of our own edit.
    guard: refreshedGuard_(ss, request.guard),
  };
}
