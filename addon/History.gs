/**
 * @OnlyCurrentDoc
 *
 * Restorable edit history.
 *
 * Two stores, split by role (ARCHITECTURE.md §4):
 *   - payloads → a hidden sheet inside this spreadsheet. Never leaves the file,
 *     travels with it when shared, and restores with the local app closed. Undo
 *     is a safety feature; it must not depend on a running process.
 *   - index → Document Properties. Small and fast enough to render the history
 *     list without touching the payload sheet.
 *
 * Properties caps at 9 KB per value and 500 KB per store, so payloads cannot
 * live there. A Sheets cell caps at 50,000 characters, so payloads chunk.
 */

const HISTORY_SHEET = '__claude_history__';
const HISTORY_INDEX_KEY = 'claude.history.index';
const CELL_CHUNK = 40000;          // under the 50k cell ceiling, with headroom
const MAX_ENTRY_BYTES = 500 * 1024; // above this, record as non-restorable

function historySheet_() {
  const ss = writeSpreadsheet_();
  let sheet = ss.getSheetByName(HISTORY_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(HISTORY_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['opId', 'chunkIndex', 'payload']]);
    sheet.hideSheet();
  }
  return sheet;
}

function readIndex_() {
  const raw = PropertiesService.getDocumentProperties().getProperty(HISTORY_INDEX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function writeIndex_(index) {
  PropertiesService.getDocumentProperties()
    .setProperty(HISTORY_INDEX_KEY, JSON.stringify(index));
}

/**
 * Capture values, formulas AND formats. Restoring values alone leaves the sheet
 * visibly wrong — that is the specific gap in the competing product's undo.
 */
function snapshotRange_(sheet, range) {
  return {
    sheetName: sheet.getName(),
    a1: range.getA1Notation(),
    values: sanitizeGrid_(range.getValues()),
    formulas: range.getFormulas(),
    backgrounds: range.getBackgrounds(),
    fontWeights: range.getFontWeights(),
    fontColors: range.getFontColors(),
    numberFormats: range.getNumberFormats(),
    horizontalAlignments: range.getHorizontalAlignments(),
  };
}

function restoreSnapshot_(snap) {
  const sheet = writeSpreadsheet_().getSheetByName(snap.sheetName);
  if (!sheet) throw new Error('Sheet no longer exists: ' + snap.sheetName);
  const range = sheet.getRange(snap.a1);

  // Formulas first, then values — setValues would clobber a restored formula,
  // and a cell with no formula carries '' here, which setValues then corrects.
  range.setFormulas(snap.formulas);
  const merged = snap.values.map((row, r) =>
    row.map((v, c) => (snap.formulas[r][c] ? snap.formulas[r][c] : v)));
  range.setValues(merged);

  range.setBackgrounds(snap.backgrounds);
  range.setFontWeights(snap.fontWeights);
  range.setFontColors(snap.fontColors);
  range.setNumberFormats(snap.numberFormats);
  range.setHorizontalAlignments(snap.horizontalAlignments);
  SpreadsheetApp.flush();
}

/** Append a history entry; payload chunked across rows of the hidden sheet. */
function recordHistory_(opId, opType, target, snapshot) {
  const json = JSON.stringify(snapshot);
  const restorable = json.length <= MAX_ENTRY_BYTES;

  if (restorable) {
    const sheet = historySheet_();
    const chunks = [];
    for (let i = 0; i < json.length; i += CELL_CHUNK) {
      chunks.push([opId, chunks.length, json.slice(i, i + CELL_CHUNK)]);
    }
    sheet.getRange(sheet.getLastRow() + 1, 1, chunks.length, 3).setValues(chunks);
  }

  const index = readIndex_();
  index.unshift({           // newest first, per the vault-wide log convention
    opId: opId,
    at: new Date().toISOString(),
    type: opType,
    target: target,
    bytes: json.length,
    restorable: restorable,
    undone: false,
  });
  writeIndex_(index);
  return { restorable: restorable, bytes: json.length };
}

function loadSnapshot_(opId) {
  const sheet = historySheet_();
  const last = sheet.getLastRow();
  if (last < 2) return null;

  const rows = sheet.getRange(2, 1, last - 1, 3).getValues()
    .filter((r) => r[0] === opId)
    .sort((a, b) => a[1] - b[1]);
  if (!rows.length) return null;

  try { return JSON.parse(rows.map((r) => r[2]).join('')); } catch { return null; }
}

/** History list for the sidebar. Index only — payloads are never read here. */
function getHistory() {
  return readIndex_().slice(0, 50);
}

/** Undo one entry by rewriting its snapshot. */
function undoOp(opId) {
  const index = readIndex_();
  const entry = index.find((e) => e.opId === opId);
  if (!entry) throw new Error('No history entry: ' + opId);
  if (!entry.restorable) throw new Error('That change was too large to be restorable.');

  const snap = loadSnapshot_(opId);
  if (!snap) throw new Error('Snapshot missing — the history sheet may have been deleted.');

  restoreSnapshot_(snap);
  entry.undone = true;
  writeIndex_(index);
  return { ok: true, opId: opId, restored: snap.sheetName + '!' + snap.a1 };
}
