/**
 * @OnlyCurrentDoc
 *
 * Sheet I/O. The only file that touches SpreadsheetApp.
 *
 * The read/write split below is load-bearing, not stylistic. Measured in
 * experiments/undo-probe: writes through the *bound* spreadsheet handle land in
 * the user's native Ctrl+Z stack, and writes through openById() do not. The
 * agent's edits must stay out of that stack so the restorable history is the
 * only thing governing them, so every write goes through writeSpreadsheet_().
 *
 * Keeping these as two named accessors makes the rule structural. Do not add a
 * write path that calls getActiveSpreadsheet().
 */

/** Hard cap on cells returned in one context read. See MAX_CELLS note below. */
const MAX_CONTEXT_CELLS = 20000;

/** Reads may use the bound handle — cheaper, and reads touch no undo stack. */
function readSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Writes MUST go through this. openById() on the currently-open spreadsheet is
 * permitted under spreadsheets.currentonly (measured 2026-08-18) and escapes
 * native undo.
 */
function writeSpreadsheet_() {
  return SpreadsheetApp.openById(SpreadsheetApp.getActiveSpreadsheet().getId());
}

/**
 * Make a value grid safe to hand to google.script.run.
 *
 * Google's docs are explicit: "Requests fail if you attempt to pass a Date,
 * Function, DOM element besides a form, or other prohibited type, including
 * prohibited types inside objects or arrays."
 *
 * Range.getValues() returns real Date objects for any date-formatted cell, so
 * an unsanitized grid silently kills the round trip — the request fails on
 * serialization and *neither* the success nor the failure handler fires. The
 * symptom is a call that never returns, which is why this is worth a comment.
 *
 * Dates become ISO strings. That is lossy in one direction: a text cell holding
 * "2026-08-18" and a real date cell both arrive as strings. Acceptable while
 * context is read-only; revisit before M3 writes dates back, when a typed
 * representation will be needed.
 */
function sanitizeGrid_(grid) {
  return grid.map(function (row) {
    return row.map(function (cell) {
      if (cell instanceof Date) return cell.toISOString();
      return cell;
    });
  });
}

/**
 * Stable hash of a range's contents. The optimistic-concurrency token: captured
 * when context is gathered, re-checked immediately before a write. Sheets v4 has
 * no ETag and LockService does not cover human UI edits, so this is the
 * compare-and-swap primitive, scoped to the range rather than the file.
 *
 * Hash the sanitized grid, not the raw one — otherwise the hash captured at read
 * time and the hash computed at write time can differ for the same unchanged
 * cells.
 */
function hashValues_(sanitizedGrid) {
  const json = JSON.stringify(sanitizedGrid);
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json);
  return bytes
    .map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); })
    .join('')
    .slice(0, 32);
}

/** Cheap manifest of every tab. Always sent; full cell data is not. */
function sheetManifest_() {
  const ss = readSpreadsheet_();
  const activeId = ss.getActiveSheet().getSheetId();
  return ss.getSheets().map(function (s) {
    return {
      sheetId: s.getSheetId(),
      name: s.getName(),
      index: s.getIndex(),
      rows: s.getLastRow(),
      cols: s.getLastColumn(),
      isActive: s.getSheetId() === activeId,
    };
  });
}

/**
 * Full cell data for one tab, bounded. Two tiers by design: the manifest above
 * goes on every turn, this only for the tab in play. See ARCHITECTURE.md §11
 * (multi-tab / context strategy).
 *
 * Bounded because getDataRange() on a large sheet produces a payload big enough
 * to stall or exceed the google.script.run transport, which fails the same
 * silent way a Date does.
 */
function readRange_(sheetName, a1) {
  const ss = readSpreadsheet_();
  const sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getActiveSheet();
  if (!sheet) throw new Error('No such sheet: ' + sheetName);

  let range = a1 ? sheet.getRange(a1) : sheet.getDataRange();

  let truncated = false;
  if (range.getNumRows() * range.getNumColumns() > MAX_CONTEXT_CELLS) {
    const cols = Math.max(1, Math.min(range.getNumColumns(), 50));
    const rows = Math.max(1, Math.floor(MAX_CONTEXT_CELLS / cols));
    range = sheet.getRange(range.getRow(), range.getColumn(),
                           Math.min(rows, range.getNumRows()),
                           Math.min(cols, range.getNumColumns()));
    truncated = true;
  }

  const values = sanitizeGrid_(range.getValues());

  return {
    sheetId: sheet.getSheetId(),
    sheetName: sheet.getName(),
    a1: range.getA1Notation(),
    rows: range.getNumRows(),
    cols: range.getNumColumns(),
    truncated: truncated,
    values: values,
    formulas: range.getFormulas(),
    contextHash: hashValues_(values),
  };
}
