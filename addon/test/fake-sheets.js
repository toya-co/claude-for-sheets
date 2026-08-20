/**
 * A fake of the slice of SpreadsheetApp that Ops.gs and History.gs touch.
 *
 * The confirmation gate and the undo-overlap check are the two pieces of this
 * add-on that must not be wrong: one decides whether the user is asked before
 * their data is overwritten, the other decides whether an undo quietly reverts
 * someone else's later edit. Neither is testable in a live spreadsheet without a
 * browser, a Google account, and a human — so they get a fake instead, and the
 * live sheet is reserved for verifying the parts a fake cannot prove.
 *
 * Deliberately small. It implements only what the code under test calls, and
 * fails loudly on anything else rather than pretending. If a test needs a method
 * that is not here, add it here rather than reaching around the fake.
 */

// ---------------------------------------------------------------- A1 parsing

function colToNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numToCol(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "B2" or "B2:D10" → {row, col, rows, cols} */
function parseA1(a1) {
  const parts = String(a1).split(':');
  const one = (ref) => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
    if (!m) throw new Error('Bad A1 reference: ' + a1);
    return { col: colToNum(m[1]), row: Number(m[2]) };
  };
  const a = one(parts[0]);
  const b = parts[1] ? one(parts[1]) : a;
  const row = Math.min(a.row, b.row);
  const col = Math.min(a.col, b.col);
  return {
    row, col,
    rows: Math.abs(b.row - a.row) + 1,
    cols: Math.abs(b.col - a.col) + 1,
  };
}

function toA1(row, col, rows, cols) {
  const start = numToCol(col) + row;
  if (rows === 1 && cols === 1) return start;
  return start + ':' + numToCol(col + cols - 1) + (row + rows - 1);
}

// ---------------------------------------------------------------- the fake

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.rows; }
  getNumColumns() { return this.cols; }
  getA1Notation() { return toA1(this.row, this.col, this.rows, this.cols); }

  _read(layer) {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) {
        line.push(this.sheet._get(layer, this.row + r, this.col + c));
      }
      out.push(line);
    }
    return out;
  }
  _write(layer, grid) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const v = grid[r] && grid[r][c] !== undefined ? grid[r][c] : '';
        this.sheet._set(layer, this.row + r, this.col + c, v);
      }
    }
  }
  _fill(layer, value) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) this.sheet._set(layer, this.row + r, this.col + c, value);
    }
  }

  getValues() { return this._read('values'); }
  getFormulas() { return this._read('formulas'); }
  getBackgrounds() { return this._read('backgrounds'); }
  getFontWeights() { return this._read('fontWeights'); }
  getFontColors() { return this._read('fontColors'); }
  getNumberFormats() { return this._read('numberFormats'); }
  getHorizontalAlignments() { return this._read('horizontalAlignments'); }
  getFontStyles() { return this._read('fontStyles'); }
  getFontSizes() { return this._read('fontSizes'); }
  getFontFamilies() { return this._read('fontFamilies'); }
  getWraps() { return this._read('wraps'); }
  getVerticalAlignments() { return this._read('verticalAlignments'); }
  getFontLines() { return this._read('fontLines'); }

  setValues(g) { this._write('values', g); return this; }
  setFormulas(g) { this._write('formulas', g); return this; }
  setBackgrounds(g) { this._write('backgrounds', g); return this; }
  setFontWeights(g) { this._write('fontWeights', g); return this; }
  setFontColors(g) { this._write('fontColors', g); return this; }
  setNumberFormats(g) { this._write('numberFormats', g); return this; }
  setHorizontalAlignments(g) { this._write('horizontalAlignments', g); return this; }
  setFontStyles(g) { this._write('fontStyles', g); return this; }
  setFontSizes(g) { this._write('fontSizes', g); return this; }
  setFontFamilies(g) { this._write('fontFamilies', g); return this; }
  setWraps(g) { this._write('wraps', g); return this; }
  setVerticalAlignments(g) { this._write('verticalAlignments', g); return this; }
  setFontLines(g) { this._write('fontLines', g); return this; }

  getNotes() { return this._read('notes'); }
  setNotes(g) { this._write('notes', g); return this; }
  setNote(v) { this._fill('notes', v === null || v === undefined ? '' : v); return this; }
  getSheet() { return this.sheet; }

  getDataValidations() {
    return this._read('validations').map((row) => row.map((v) => (v === '' ? null : v)));
  }
  setDataValidations(g) { this._write('validations', g); return this; }
  setDataValidation(v) { this._fill('validations', v); return this; }
  clearDataValidations() { this._fill('validations', null); return this; }

  /**
   * Range.setBorder, API-shaped into the borders layer. Each cell carries
   * {top?, bottom?, left?, right?} of {style, color} — the same object shape
   * the fake Sheets service serves back, so snapshot/restore is passthrough.
   * true sets the edge, false removes it, null leaves it alone.
   */
  setBorder(top, left, bottom, right, vertical, horizontal, color, style) {
    const value = { style: style || 'SOLID', color: color || '#000000' };
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cell = Object.assign({}, this.sheet._get('borders', this.row + r, this.col + c) || {});
        const apply = (edge, want) => {
          if (want === true) cell[edge] = value;
          else if (want === false) delete cell[edge];
        };
        apply('top', r === 0 ? top : (r > 0 ? horizontal : null));
        apply('bottom', r === this.rows - 1 ? bottom : (r < this.rows - 1 ? horizontal : null));
        apply('left', c === 0 ? left : (c > 0 ? vertical : null));
        apply('right', c === this.cols - 1 ? right : (c < this.cols - 1 ? vertical : null));
        this.sheet._set('borders', this.row + r, this.col + c,
          Object.keys(cell).length ? cell : '');
      }
    }
    return this;
  }

  setBackground(v) { this._fill('backgrounds', v); return this; }
  setFontColor(v) { this._fill('fontColors', v); return this; }
  setFontWeight(v) { this._fill('fontWeights', v); return this; }
  setFontStyle(v) { this._fill('fontStyles', v); return this; }
  setNumberFormat(v) { this._fill('numberFormats', v); return this; }
  setHorizontalAlignment(v) { this._fill('horizontalAlignments', v); return this; }
  setFontSize(v) { this._fill('fontSizes', v); return this; }
  setFontFamily(v) { this._fill('fontFamilies', v); return this; }
  setWrap(v) { this._fill('wraps', Boolean(v)); return this; }
  setVerticalAlignment(v) { this._fill('verticalAlignments', v); return this; }
  setFontLine(v) { this._fill('fontLines', v); return this; }

  clearContent() { this._fill('values', ''); this._fill('formulas', ''); return this; }
  clearFormat() {
    // Borders are formatting and go with the rest; notes and validations are
    // not — the real clear()/clearFormat leaves both in place.
    ['backgrounds', 'fontWeights', 'fontColors', 'numberFormats', 'horizontalAlignments',
     'fontStyles', 'fontSizes', 'fontFamilies', 'wraps', 'verticalAlignments', 'fontLines',
     'borders']
      .forEach((l) => this._fill(l, ''));
    return this;
  }
  clear() { this.clearContent(); this.clearFormat(); return this; }

  // ---- merges. Real merge() keeps only the top-left value of the block and
  // deletes the rest — the destructiveness the gate exists to catch.
  _intersects(m) {
    return m.row <= this.row + this.rows - 1 && this.row <= m.row + m.rows - 1 &&
           m.col <= this.col + this.cols - 1 && this.col <= m.col + m.cols - 1;
  }
  merge() { this.sheet._merge(this.row, this.col, this.rows, this.cols); return this; }
  mergeAcross() {
    for (let r = 0; r < this.rows; r++) this.sheet._merge(this.row + r, this.col, 1, this.cols);
    return this;
  }
  mergeVertically() {
    for (let c = 0; c < this.cols; c++) this.sheet._merge(this.row, this.col + c, this.rows, 1);
    return this;
  }
  breakApart() {
    this.sheet.merges = this.sheet.merges.filter((m) => !this._intersects(m));
    return this;
  }
  getMergedRanges() {
    return this.sheet.merges.filter((m) => this._intersects(m))
      .map((m) => new FakeRange(this.sheet, m.row, m.col, m.rows, m.cols));
  }

  /**
   * Range.sort. Column positions are absolute sheet columns, as in the real
   * API. Rows move across every layer — values, formulas, and formats travel
   * together. One infidelity, documented: real Sheets adjusts relative formula
   * references as rows move; the fake moves formula text verbatim.
   */
  sort(specs) {
    const list = (Array.isArray(specs) ? specs : [specs]).map((s) =>
      (typeof s === 'object' ? s : { column: s, ascending: true }));
    const layers = Object.keys(this.sheet.layers);
    const rows = [];
    for (let r = 0; r < this.rows; r++) {
      const data = {};
      for (const l of layers) {
        data[l] = [];
        for (let c = 0; c < this.cols; c++) data[l].push(this.sheet._get(l, this.row + r, this.col + c));
      }
      rows.push({ i: r, data });
    }
    rows.sort((a, b) => {
      for (const s of list) {
        const ci = s.column - this.col;
        const av = a.data.values[ci], bv = b.data.values[ci];
        if (av === bv) continue;
        return (av < bv ? -1 : 1) * (s.ascending === false ? -1 : 1);
      }
      return a.i - b.i;
    });
    rows.forEach((row, r) => {
      for (const l of layers) {
        for (let c = 0; c < this.cols; c++) this.sheet._set(l, this.row + r, this.col + c, row.data[l][c]);
      }
    });
    return this;
  }
}

const LAYER_DEFAULTS = {
  values: '', formulas: '', backgrounds: '#ffffff', fontWeights: 'normal',
  fontColors: '#000000', numberFormats: '', horizontalAlignments: '', fontStyles: 'normal',
  fontSizes: 10, fontFamilies: 'Arial', wraps: false, verticalAlignments: 'bottom',
  fontLines: 'none', notes: '', borders: null, validations: null,
};

/** A stored data-validation rule; the getters mirror the real DataValidation. */
class FakeDataValidation {
  constructor(criteria, args, allowInvalid, help) {
    Object.assign(this, { criteria, args, allowInvalid, help });
  }
  getCriteriaType() { return this.criteria; }   // a string doubling as the enum
  getCriteriaValues() { return this.args; }
  getAllowInvalid() { return this.allowInvalid; }
  getHelpText() { return this.help || ''; }
  copy() { return this; }
}

class FakeValidationBuilder {
  constructor() { this.criteria = null; this.args = []; this.allowInvalid = true; this.help = null; }
  requireValueInList(values, show) { this.criteria = 'VALUE_IN_LIST'; this.args = [values, show !== false]; return this; }
  requireNumberBetween(min, max) { this.criteria = 'NUMBER_BETWEEN'; this.args = [min, max]; return this; }
  requireNumberGreaterThan(min) { this.criteria = 'NUMBER_GREATER_THAN'; this.args = [min]; return this; }
  requireCheckbox() { this.criteria = 'CHECKBOX'; this.args = []; return this; }
  requireDate() { this.criteria = 'DATE_IS_VALID_DATE'; this.args = []; return this; }
  withCriteria(criteria, args) { this.criteria = criteria; this.args = args || []; return this; }
  setAllowInvalid(v) { this.allowInvalid = Boolean(v); return this; }
  setHelpText(t) { this.help = t; return this; }
  build() { return new FakeDataValidation(this.criteria, this.args, this.allowInvalid, this.help); }
}

class FakeSheet {
  constructor(name, sheetId) {
    this.name = name;
    this.sheetId = sheetId;
    this.layers = {};
    this.hidden = false;
    this.merges = [];                  // {row, col, rows, cols}
    this.columnWidths = new Map();     // col -> px (default 100)
    this.rowHeights = new Map();       // row -> px (default 21)
    this.frozenRows = 0;
    this.frozenCols = 0;
    this.hiddenRows = new Set();
    this.hiddenCols = new Set();
    this.conditionalFormats = [];      // API-shaped rule objects, in order
    Object.keys(LAYER_DEFAULTS).forEach((l) => { this.layers[l] = new Map(); });
  }

  copyTo(ss) {
    const copy = ss.insertSheet('Copy of ' + this.name);
    for (const l of Object.keys(this.layers)) copy.layers[l] = new Map(this.layers[l]);
    copy.merges = this.merges.map((m) => ({ ...m }));
    copy.columnWidths = new Map(this.columnWidths);
    copy.rowHeights = new Map(this.rowHeights);
    copy.conditionalFormats = this.conditionalFormats.map((r) => JSON.parse(JSON.stringify(r)));
    return copy;
  }

  /**
   * Merge a block: absorb any merges it fully contains, then delete every
   * value and formula except the top-left — the real API's behavior, and the
   * destructiveness the gate exists to catch.
   */
  _merge(row, col, rows, cols) {
    if (rows === 1 && cols === 1) return;
    this.merges = this.merges.filter((m) =>
      !(m.row >= row && m.col >= col &&
        m.row + m.rows <= row + rows && m.col + m.cols <= col + cols));
    for (let r = row; r < row + rows; r++) {
      for (let c = col; c < col + cols; c++) {
        if (r === row && c === col) continue;
        this._set('values', r, c, '');
        this._set('formulas', r, c, '');
      }
    }
    this.merges.push({ row, col, rows, cols });
  }
  _key(r, c) { return r + ':' + c; }
  _get(layer, r, c) {
    const m = this.layers[layer];
    if (!m) throw new Error('Fake has no layer: ' + layer);
    const v = m.get(this._key(r, c));
    return v === undefined ? LAYER_DEFAULTS[layer] : v;
  }
  _set(layer, r, c, v) { this.layers[layer].set(this._key(r, c), v); }

  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getSheetId() { return this.sheetId; }
  getIndex() {
    return this._parent ? this._parent.sheets.indexOf(this) + 1 : this.sheetId + 1;
  }
  hideSheet() { this.hidden = true; return this; }
  showSheet() { this.hidden = false; return this; }
  isSheetHidden() { return this.hidden; }

  getColumnWidth(c) { return this.columnWidths.has(c) ? this.columnWidths.get(c) : 100; }
  setColumnWidth(c, w) { this.columnWidths.set(c, w); return this; }
  getRowHeight(r) { return this.rowHeights.has(r) ? this.rowHeights.get(r) : 21; }
  setRowHeight(r, h) { this.rowHeights.set(r, h); return this; }
  getFrozenRows() { return this.frozenRows; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  getFrozenColumns() { return this.frozenCols; }
  setFrozenColumns(n) { this.frozenCols = n; return this; }
  hideRows(start, num) {
    for (let i = start; i < start + (num || 1); i++) this.hiddenRows.add(i);
    return this;
  }
  showRows(start, num) {
    for (let i = start; i < start + (num || 1); i++) this.hiddenRows.delete(i);
    return this;
  }
  isRowHiddenByUser(r) { return this.hiddenRows.has(r); }
  hideColumns(start, num) {
    for (let i = start; i < start + (num || 1); i++) this.hiddenCols.add(i);
    return this;
  }
  showColumns(start, num) {
    for (let i = start; i < start + (num || 1); i++) this.hiddenCols.delete(i);
    return this;
  }
  isColumnHiddenByUser(c) { return this.hiddenCols.has(c); }

  // Real Sheets counts a formula-only cell as content for getLastRow/Column
  // (its computed value occupies the cell). The fake keeps values and formulas
  // as separate layers, so it must scan both to stay faithful — scanning only
  // values under-measured the data region and cost a formula its snapshot.
  _last(pick) {
    let max = 0;
    for (const layer of ['values', 'formulas']) {
      for (const [k, v] of this.layers[layer]) {
        if (v !== '') max = Math.max(max, pick(k.split(':').map(Number)));
      }
    }
    return max;
  }
  getLastRow() { return this._last(([r]) => r); }
  getLastColumn() { return this._last(([, c]) => c); }
  getRange(a1OrRow, col, rows, cols) {
    if (typeof a1OrRow === 'string') {
      const p = parseA1(a1OrRow);
      return new FakeRange(this, p.row, p.col, p.rows, p.cols);
    }
    return new FakeRange(this, a1OrRow, col, rows === undefined ? 1 : rows,
                         cols === undefined ? 1 : cols);
  }
  getMaxRows() { return Math.max(this.getLastRow(), 100); }
  getMaxColumns() { return Math.max(this.getLastColumn(), 26); }

  /**
   * Structural shifts. Cells live in sparse Maps keyed "r:c", so a shift is a
   * rekeying: every cell at or past the insertion point moves by `count`, and a
   * deletion drops the doomed span and pulls the rest back. Mirrors what Sheets
   * does to the coordinate space, which is the whole reason structural ops
   * cannot be undone by a value snapshot alone.
   */
  _rekey(axis, from, delta, dropSpan) {
    for (const layer of Object.keys(this.layers)) {
      const next = new Map();
      for (const [key, v] of this.layers[layer]) {
        let [r, c] = key.split(':').map(Number);
        let dim = axis === 'row' ? r : c;
        if (dropSpan && dim >= from && dim < from + dropSpan) continue;
        if (dropSpan && dim >= from + dropSpan) dim -= dropSpan;
        else if (!dropSpan && dim >= from) dim += delta;
        if (axis === 'row') r = dim; else c = dim;
        next.set(r + ':' + c, v);
      }
      this.layers[layer] = next;
    }
  }
  insertRowsBefore(at, n) { this._rekey('row', at, n, 0); return this; }
  deleteRows(at, n) { this._rekey('row', at, 0, n); return this; }
  insertColumnsBefore(at, n) { this._rekey('col', at, n, 0); return this; }
  deleteColumns(at, n) { this._rekey('col', at, 0, n); return this; }
  /** Seed cells from a grid anchored at a1. Test convenience, not an API mirror. */
  seed(a1, grid, layer) {
    const p = parseA1(a1);
    new FakeRange(this, p.row, p.col, grid.length, grid[0].length)
      ._write(layer || 'values', grid);
    return this;
  }
}

class FakeSpreadsheet {
  constructor(names) {
    this._nextId = 0;
    this.sheets = names.map((n) => this._make(n));
    this.id = 'fake-spreadsheet-id';
    this.namedRanges = new Map();      // name -> {sheetName, a1}
  }

  /** "'Sheet Name'!A1:B2" or "Sheet1!A1" — the qualified form the API uses. */
  getRange(qualified) {
    const m = /^(?:'((?:[^']|'')*)'|([^'!]+))!(.+)$/.exec(String(qualified));
    if (!m) throw new Error('Bad qualified range: ' + qualified);
    const sheetName = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
    const sheet = this.getSheetByName(sheetName);
    if (!sheet) throw new Error('No sheet: ' + sheetName);
    return sheet.getRange(m[3]);
  }

  getNamedRanges() {
    const ss = this;
    return [...this.namedRanges.entries()].map(([name, def]) => ({
      getName: () => name,
      getRange: () => ss.getSheetByName(def.sheetName).getRange(def.a1),
      remove: () => { ss.namedRanges.delete(name); },
    }));
  }
  setNamedRange(name, range) {
    this.namedRanges.set(name, { sheetName: range.sheet.getName(), a1: range.getA1Notation() });
  }
  _make(name) {
    const s = new FakeSheet(name, this._nextId++);
    s._parent = this;
    return s;
  }
  getId() { return this.id; }
  getName() { return 'Fake Spreadsheet'; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.filter((s) => s.getName() === n)[0] || null; }
  getActiveSheet() { return this.sheets[0]; }
  /** index, when given, is 0-based insertion position — the Apps Script contract. */
  insertSheet(name, index) {
    const s = this._make(name);
    if (index === undefined) this.sheets.push(s);
    else this.sheets.splice(index, 0, s);
    return s;
  }
  deleteSheet(sheet) {
    this.sheets = this.sheets.filter((x) => x !== sheet);
  }
}

/**
 * Build the globals the .gs files expect, load them into one shared scope, and
 * hand back both the API surface and the fake spreadsheet behind it.
 *
 * Apps Script has a flat global namespace across files, which is why this
 * concatenates rather than requiring: it reproduces the environment the code
 * actually runs in, including the fact that Ops.gs can call History.gs directly.
 */
function loadAddon(sheetNames = ['Sheet1', 'Sheet2']) {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');

  const ss = new FakeSpreadsheet(sheetNames);
  const properties = new Map();

  const byId = (sheetId) => ss.sheets.filter((s) => s.getSheetId() === sheetId)[0];

  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: (id) => {
        if (id !== ss.getId()) throw new Error('openById called with a foreign id: ' + id);
        return ss;
      },
      flush: () => {},
      newDataValidation: () => new FakeValidationBuilder(),
      // Identity maps: the code passes these enums straight through, and the
      // fake stores the name itself, so name -> name is exactly faithful.
      DataValidationCriteria: new Proxy({}, { get: (t, k) => String(k) }),
      BorderStyle: new Proxy({}, { get: (t, k) => String(k) }),
    },

    /**
     * The Advanced Sheets service, for exactly the two things SpreadsheetApp
     * cannot do: read borders back, and round-trip conditional-format rules
     * with their formats attached. Serves API-shaped JSON from the fake's own
     * state so the .gs code's parsing is exercised for real.
     */
    Sheets: {
      Spreadsheets: {
        get: (id, params) => {
          if (/conditionalFormats/.test(params.fields || '')) {
            return { sheets: ss.sheets.map((s) => ({
              properties: { sheetId: s.getSheetId() },
              conditionalFormats: s.conditionalFormats.map((r) => JSON.parse(JSON.stringify(r))),
            })) };
          }
          const range = ss.getRange(params.ranges[0]);
          const rowData = [];
          for (let r = 0; r < range.getNumRows(); r++) {
            const values = [];
            for (let c = 0; c < range.getNumColumns(); c++) {
              const b = range.sheet._get('borders', range.row + r, range.col + c);
              values.push(b ? { userEnteredFormat: { borders: JSON.parse(JSON.stringify(b)) } } : {});
            }
            rowData.push({ values });
          }
          return { sheets: [{ data: [{ rowData }] }] };
        },
        batchUpdate: (body, id) => {
          for (const req of body.requests || []) {
            if (req.updateCells) {
              const u = req.updateCells;
              if (u.fields !== 'userEnteredFormat.borders') {
                throw new Error('fake batchUpdate only understands border updates, got: ' + u.fields);
              }
              const sheet = byId(u.range.sheetId);
              (u.rows || []).forEach((row, r) => {
                (row.values || []).forEach((cell, c) => {
                  const b = (cell.userEnteredFormat || {}).borders || {};
                  sheet._set('borders', u.range.startRowIndex + 1 + r,
                    u.range.startColumnIndex + 1 + c, Object.keys(b).length ? b : '');
                });
              });
            } else if (req.deleteConditionalFormatRule) {
              byId(req.deleteConditionalFormatRule.sheetId)
                .conditionalFormats.splice(req.deleteConditionalFormatRule.index, 1);
            } else if (req.addConditionalFormatRule) {
              const a = req.addConditionalFormatRule;
              const sheetId = a.rule.ranges[0].sheetId;
              byId(sheetId).conditionalFormats.splice(a.index, 0, a.rule);
            } else {
              throw new Error('fake batchUpdate: unknown request ' + Object.keys(req));
            }
          }
        },
      },
    },
    PropertiesService: {
      getDocumentProperties: () => ({
        getProperty: (k) => (properties.has(k) ? properties.get(k) : null),
        setProperty: (k, v) => { properties.set(k, v); },
      }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      // Not cryptographic, and does not need to be: the only property under test
      // is that identical content hashes identically and changed content does not.
      computeDigest: (_algo, str) => {
        const bytes = [];
        let h1 = 0x811c9dc5, h2 = 0x1000193;
        for (let i = 0; i < str.length; i++) {
          h1 = (h1 ^ str.charCodeAt(i)) * 16777619 >>> 0;
          h2 = (h2 + str.charCodeAt(i) * (i + 1)) >>> 0;
        }
        for (let i = 0; i < 32; i++) {
          bytes.push(((i % 2 ? h1 : h2) >>> ((i % 4) * 8)) & 0xff);
        }
        return bytes;
      },
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const dir = path.join(__dirname, '..');
  for (const file of ['Sheet.gs', 'History.gs', 'Ops.gs', 'Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), sandbox,
                    { filename: file });
  }

  return { api: sandbox, ss, properties };
}

module.exports = { loadAddon, parseA1, toA1, FakeSpreadsheet };
