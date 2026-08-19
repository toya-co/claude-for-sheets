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

  setValues(g) { this._write('values', g); return this; }
  setFormulas(g) { this._write('formulas', g); return this; }
  setBackgrounds(g) { this._write('backgrounds', g); return this; }
  setFontWeights(g) { this._write('fontWeights', g); return this; }
  setFontColors(g) { this._write('fontColors', g); return this; }
  setNumberFormats(g) { this._write('numberFormats', g); return this; }
  setHorizontalAlignments(g) { this._write('horizontalAlignments', g); return this; }

  setBackground(v) { this._fill('backgrounds', v); return this; }
  setFontColor(v) { this._fill('fontColors', v); return this; }
  setFontWeight(v) { this._fill('fontWeights', v); return this; }
  setFontStyle(v) { this._fill('fontStyles', v); return this; }
  setNumberFormat(v) { this._fill('numberFormats', v); return this; }
  setHorizontalAlignment(v) { this._fill('horizontalAlignments', v); return this; }

  clearContent() { this._fill('values', ''); this._fill('formulas', ''); return this; }
  clearFormat() {
    ['backgrounds', 'fontWeights', 'fontColors', 'numberFormats', 'horizontalAlignments']
      .forEach((l) => this._fill(l, ''));
    return this;
  }
  clear() { this.clearContent(); this.clearFormat(); return this; }
}

const LAYER_DEFAULTS = {
  values: '', formulas: '', backgrounds: '#ffffff', fontWeights: 'normal',
  fontColors: '#000000', numberFormats: '', horizontalAlignments: '', fontStyles: 'normal',
};

class FakeSheet {
  constructor(name, sheetId) {
    this.name = name;
    this.sheetId = sheetId;
    this.layers = {};
    this.hidden = false;
    Object.keys(LAYER_DEFAULTS).forEach((l) => { this.layers[l] = new Map(); });
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
  getSheetId() { return this.sheetId; }
  getIndex() { return this.sheetId + 1; }
  hideSheet() { this.hidden = true; return this; }

  getLastRow() {
    let max = 0;
    for (const k of this.layers.values.keys()) {
      const [r] = k.split(':').map(Number);
      if (this.layers.values.get(k) !== '') max = Math.max(max, r);
    }
    return max;
  }
  getLastColumn() {
    let max = 0;
    for (const k of this.layers.values.keys()) {
      const [, c] = k.split(':').map(Number);
      if (this.layers.values.get(k) !== '') max = Math.max(max, c);
    }
    return max;
  }
  getRange(a1OrRow, col, rows, cols) {
    if (typeof a1OrRow === 'string') {
      const p = parseA1(a1OrRow);
      return new FakeRange(this, p.row, p.col, p.rows, p.cols);
    }
    return new FakeRange(this, a1OrRow, col, rows === undefined ? 1 : rows,
                         cols === undefined ? 1 : cols);
  }
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
    this.sheets = names.map((n, i) => new FakeSheet(n, i));
    this.id = 'fake-spreadsheet-id';
  }
  getId() { return this.id; }
  getName() { return 'Fake Spreadsheet'; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.filter((s) => s.getName() === n)[0] || null; }
  getActiveSheet() { return this.sheets[0]; }
  insertSheet(name) {
    const s = new FakeSheet(name, this.sheets.length);
    this.sheets.push(s);
    return s;
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

  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: (id) => {
        if (id !== ss.getId()) throw new Error('openById called with a foreign id: ' + id);
        return ss;
      },
      flush: () => {},
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
